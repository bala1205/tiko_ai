import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { AI_CONFIG } from "./config/ai_config";
import { callNvidiaWithFallback } from "./services/nvidia_ai_service";
import { validateChatRequest } from "./utils/validation";
import { NvidiaMessage } from "./types/chat";

admin.initializeApp();

// Secret - never hardcode the actual key. Developer sets via:
// firebase functions:secrets:set NVIDIA_API_KEY
const nvidiaApiKey = defineSecret("NVIDIA_API_KEY");

/**
 * Callable function: chatWithAI
 *
 * Requires Firebase Authentication.
 * Validates input, verifies conversation ownership, loads recent context,
 * calls NVIDIA NIM securely with fallback, returns assistant response.
 * Never returns secrets.
 *
 * Fallback strategy:
 *  Primary: moonshotai/kimi-k3 (30s timeout)
 *  Fallback: google/diffusiongemma-26b-a4b-it (30s timeout) on transient failures.
 *
 * Non-streaming reliable implementation with typing indicator on client.
 */
export const chatWithAI = onCall(
  {
    secrets: [nvidiaApiKey],
    region: "us-central1",
    cors: true,
    maxInstances: 20,
  },
  async (request) => {
    // 1. Auth - never trust client userId, use verified UID
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in to chat.");
    }
    const uid = request.auth.uid;
    console.log(`chatWithAI invoked uid=${uid}`);

    // 2. Validate request (supports {message} and {messages} formats)
    const { message: userMessage, conversationId, imageUrl } = validateChatRequest(request.data);
    console.log(`conversationId=${conversationId ?? "(none)"} messageLen=${userMessage.length}`);

    // 3. Verify conversation ownership if conversationId provided
    let history: Array<{ role: string; content: string }> = [];
    if (conversationId) {
      const convRef = admin.firestore().collection("conversations").doc(conversationId);
      const convSnap = await convRef.get();
      if (!convSnap.exists) {
        throw new HttpsError("not-found", "Conversation not found.");
      }
      const convData = convSnap.data()!;
      if (convData.userId !== uid) {
        throw new HttpsError("permission-denied", "You do not own this conversation.");
      }

      // 4. Load recent conversation context (last N messages) - only own conversation
      const messagesSnap = await convRef
        .collection("messages")
        .orderBy("createdAt", "desc")
        .limit(AI_CONFIG.MAX_CONTEXT_MESSAGES)
        .get();

      history = messagesSnap.docs
        .map((doc) => {
          const d = doc.data();
          return { role: d.role as string, content: d.content as string };
        })
        .reverse();
    }

    // 5. Build messages for NVIDIA: system + history + current user message
    const lastInHistory = history[history.length - 1];
    const needsAppend = !lastInHistory || lastInHistory.content !== userMessage || lastInHistory.role !== "user";

    const nvidiaMessages: NvidiaMessage[] = [
      { role: "system", content: AI_CONFIG.SYSTEM_PROMPT },
      ...history.map((m) => ({
        role: m.role as NvidiaMessage["role"],
        content: m.content,
      })),
    ];
    if (needsAppend) {
      nvidiaMessages.push({ role: "user", content: userMessage });
    }

    // Image handling: neither kimi-k3 nor diffusiongemma reliably support vision.
    // Ignore imageUrl to avoid invalid payload. Log safely.
    // Image is still stored in Firestore via Cloudinary -> imageUrl field.
    if (imageUrl) {
      console.warn(
        `Image URL received but vision disabled for models ${AI_CONFIG.PRIMARY_MODEL}/${AI_CONFIG.FALLBACK_MODEL}. Ignoring for AI payload.`,
      );
    }

    // 6. Call NVIDIA securely with server secret and fallback
    const apiKey = nvidiaApiKey.value();
    const assistantText = await callNvidiaWithFallback(nvidiaMessages, apiKey);

    // 7. Update conversation metadata server-side if conversationId exists
    if (conversationId) {
      try {
        await admin.firestore().collection("conversations").doc(conversationId).update({
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastMessagePreview: assistantText.slice(0, 80),
        });
      } catch (_) {
        // non-fatal
      }
    }

    // 8. Return clean response - matches Flutter expectation {response}
    console.log(`chatWithAI success uid=${uid} responseLen=${assistantText.length}`);
    return {
      success: true,
      message: { role: "assistant", content: assistantText },
      response: assistantText,
    };
  },
);
