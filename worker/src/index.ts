import { AI_CONFIG, type NvidiaMessage } from "./ai/config.js";
import { callNvidiaWithFallback, callVisionWithFallback, NvidiaError } from "./ai/nvidia.js";
import { getBearerToken, verifyFirebaseIdToken } from "./ai/auth.js";
import { FirestoreError, getAccessToken, getConversation, loadHistory, updateConversationMetadata, type Env } from "./ai/firestore.js";

export interface WorkerEnv extends Env {
  NVIDIA_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders },
  });
}

function errorResponse(message: string, status: number, code?: string): Response {
  return jsonResponse({ success: false, error: message, code: code ?? "error" }, status);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return jsonResponse({
        ok: true,
        service: "tiko-ai-worker",
        projectId: env.FIREBASE_PROJECT_ID ?? "tiko-6a169",
        primaryModel: AI_CONFIG.PRIMARY_MODEL,
        fallbackModel: AI_CONFIG.FALLBACK_MODEL,
        visionModel: AI_CONFIG.VISION_MODEL,
        primaryTimeoutMs: AI_CONFIG.PRIMARY_TIMEOUT_MS,
        fallbackTimeoutMs: AI_CONFIG.FALLBACK_TIMEOUT_MS,
        visionTimeoutMs: AI_CONFIG.VISION_TIMEOUT_MS,
        timestamp: new Date().toISOString(),
        nvidiaConfigured: !!(env.NVIDIA_API_KEY && env.NVIDIA_API_KEY.length > 10),
      });
    }

    const isChatPath = url.pathname === "/chat" || url.pathname === "/" || url.pathname === "/api/chat";
    if (!isChatPath) {
      return errorResponse("Not found", 404, "not-found");
    }
    if (request.method !== "POST") {
      return errorResponse("Method not allowed", 405, "method-not-allowed");
    }

    const token = getBearerToken(request);
    if (!token) {
      return errorResponse("Missing Authorization Bearer token", 401, "unauthenticated");
    }

    const projectId = env.FIREBASE_PROJECT_ID || "tiko-6a169";
    let uid: string;
    try {
      const verified = await verifyFirebaseIdToken(token, projectId);
      uid = verified.uid;
    } catch (e: any) {
      console.error("Token verification failed:", e?.message ?? String(e));
      return errorResponse("Invalid or expired token. Please sign in again.", 401, "unauthenticated");
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", 400, "invalid-argument");
    }

    // Preserve exact Unicode (Tamil, Tanglish, mixed) — do not normalize destructively.
    let userMessage: string | null = null;
    if (typeof body.message === "string" && body.message.trim().length > 0) {
      userMessage = body.message.trim();
    } else if (Array.isArray(body.messages) && body.messages.length > 0) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m: any = body.messages[i];
        if (m && m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0) {
          userMessage = m.content.trim();
          break;
        }
      }
      if (!userMessage) {
        const last: any = body.messages[body.messages.length - 1];
        if (last && typeof last.content === "string") userMessage = last.content.trim();
      }
    }

    // Allow image-only messages: if message empty but imageUrl present, treat as image analysis request
    let imageUrl: string | undefined;
    if (body.imageUrl !== undefined && body.imageUrl !== null) {
      if (typeof body.imageUrl !== "string") return errorResponse("imageUrl must be a string.", 400, "invalid-argument");
      const t = body.imageUrl.trim();
      if (t.length > 0) {
        if (t.length > 2000) return errorResponse("imageUrl too long.", 400, "invalid-argument");
        // Basic URL validation, allow any https but prefer Cloudinary secure_url
        if (!t.startsWith("https://") && !t.startsWith("http://")) return errorResponse("imageUrl must be a valid URL.", 400, "invalid-argument");
        imageUrl = t;
      }
    }

    // If both missing, reject
    if ((!userMessage || userMessage.length === 0) && !imageUrl) {
      return errorResponse("Message is required and cannot be empty.", 400, "invalid-argument");
    }
    // For image-only, set default text that still respects Tamil context if history indicates Tamil preference?
    // Keep user's original intent: if imageUrl present and message is empty placeholder "[Image]", convert to descriptive prompt
    if ((!userMessage || userMessage.length === 0) && imageUrl) {
      userMessage = "Describe this image.";
    }
    // For vision routing, if userMessage is still "[Image]" placeholder, give meaningful prompt preserving language context
    if (userMessage === "[Image]" && imageUrl) {
      userMessage = "Describe this image.";
    }

    if (userMessage && userMessage.length > AI_CONFIG.MAX_MESSAGE_LENGTH) {
      return errorResponse(`Message too long (max ${AI_CONFIG.MAX_MESSAGE_LENGTH} chars).`, 400, "invalid-argument");
    }

    let conversationId: string | null = null;
    if (body.conversationId !== undefined && body.conversationId !== null) {
      if (typeof body.conversationId !== "string") return errorResponse("conversationId must be a string.", 400, "invalid-argument");
      const t = body.conversationId.trim();
      if (t.length > 0) conversationId = t;
    }

    const nvidiaKey = env.NVIDIA_API_KEY;
    if (!nvidiaKey || nvidiaKey.length < 10) {
      console.error("NVIDIA_API_KEY not configured");
      return errorResponse("AI service is not configured. Please contact support.", 500, "failed-precondition");
    }

    // Verify conversation ownership and load history
    let history: Array<{ role: string; content: string }> = [];
    if (conversationId) {
      let firestoreToken: string;
      try {
        firestoreToken = await getAccessToken(env as any);
      } catch (e: any) {
        console.warn("Service account not configured, falling back to ID token for Firestore", e?.message ?? String(e));
        firestoreToken = token;
      }

      try {
        const conv = await getConversation(projectId, firestoreToken, conversationId);
        if (!conv.exists) return errorResponse("Conversation not found.", 404, "not-found");
        if (conv.data?.userId !== uid) return errorResponse("You do not own this conversation.", 403, "permission-denied");

        history = await loadHistory(projectId, firestoreToken, conversationId, AI_CONFIG.MAX_CONTEXT_MESSAGES);
      } catch (e: any) {
        const status = (e as FirestoreError)?.status ?? (e?.status as number | undefined);
        const msg = e?.message ?? String(e);
        if (status === 403 || (typeof msg === "string" && msg.includes(" 403"))) {
          return errorResponse("You do not own this conversation.", 403, "permission-denied");
        }
        if (status === 404) {
          return errorResponse("Conversation not found.", 404, "not-found");
        }
        console.error("Firestore error:", msg);
        return errorResponse("Failed to load conversation. Please try again.", 500, "internal");
      }

      (request as any).__firestoreToken = firestoreToken;
    }

    // Build messages
    let assistantText: string;
    try {
      if (imageUrl) {
        // Vision routing — verified model meta/llama-3.2-11b-vision-instruct with Cloudinary secure_url
        // Do not send image as plain text; use multimodal content array.
        const visionText = userMessage && userMessage.length > 0 ? userMessage : "What is in this image? Describe it.";
        const visionMessages: NvidiaMessage[] = [
          { role: "system", content: AI_CONFIG.SYSTEM_PROMPT },
          ...history.map((m) => ({ role: m.role as NvidiaMessage["role"], content: m.content })),
          {
            role: "user",
            content: [
              { type: "text", text: visionText },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ];
        assistantText = await callVisionWithFallback(visionMessages, nvidiaKey);
      } else {
        // Text routing — preserve exact Unicode, do not duplicate current message
        const lastInHistory = history[history.length - 1];
        const needsAppend = !lastInHistory || lastInHistory.content !== userMessage || lastInHistory.role !== "user";

        const nvidiaMessages: NvidiaMessage[] = [
          { role: "system", content: AI_CONFIG.SYSTEM_PROMPT },
          ...history.map((m) => ({ role: m.role as NvidiaMessage["role"], content: m.content })),
        ];
        if (needsAppend && userMessage) {
          nvidiaMessages.push({ role: "user", content: userMessage });
        }

        assistantText = await callNvidiaWithFallback(nvidiaMessages, nvidiaKey);
      }
    } catch (e: any) {
      const err = e as NvidiaError;
      const msg = err?.message ?? String(e);
      const status = err?.status ?? 500;
      console.error(`NVIDIA failed status=${status} msg=${msg.slice(0, 500)} image=${!!imageUrl}`);
      if (status === 404 && imageUrl) {
        return errorResponse("Image analysis is currently unavailable.", 503, "unavailable");
      }
      if (status === 429) return errorResponse("AI service is busy. Please try again in a moment.", 429, "resource-exhausted");
      if (status === 400) return errorResponse("AI provider error (400). Please try again.", 400, "invalid-argument");
      if (status === 401 || status === 403) return errorResponse("AI provider authentication failed. Please contact support.", 500, "internal");
      if (status === 504 || msg.toLowerCase().includes("timed out")) return errorResponse("AI request timed out. Please try again.", 504, "deadline-exceeded");
      if (msg.toLowerCase().includes("image analysis")) return errorResponse(msg, 503, "unavailable");
      if (status >= 500) return errorResponse("AI service is temporarily unavailable. Please try again.", 503, "unavailable");
      if (msg.includes("not configured")) return errorResponse("AI service is not configured. Please contact support.", 500, "failed-precondition");
      return errorResponse("AI service is temporarily unavailable. Please try again.", 500, "internal");
    }

    if (!assistantText || assistantText.trim().length === 0) {
      console.error("Empty assistant response after fallback");
      return errorResponse("AI service is temporarily unavailable. Please try again.", 500, "internal");
    }

    if (conversationId) {
      try {
        let at = (request as any).__firestoreToken as string | undefined;
        if (!at) {
          try {
            at = await getAccessToken(env as any);
          } catch {
            at = token;
          }
        }
        await updateConversationMetadata(projectId, at, conversationId, assistantText);
      } catch (_) {}
    }

    return jsonResponse({
      success: true,
      message: { role: "assistant", content: assistantText },
      response: assistantText,
    });
  },
} satisfies ExportedHandler<WorkerEnv>;
