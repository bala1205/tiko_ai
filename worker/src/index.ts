import { AI_CONFIG, type NvidiaMessage } from "./ai/config.js";
import { callNvidiaWithFallback, callVisionWithFallback, NvidiaError } from "./ai/nvidia.js";
import { getBearerToken, verifyFirebaseIdToken } from "./ai/auth.js";
import { FirestoreError, getAccessToken, getConversation, loadHistory, updateConversationMetadata, type Env } from "./ai/firestore.js";
import {
  CF_VISION_MODEL,
  CF_IMAGE_GEN_MODEL,
  CF_VISION_TIMEOUT_MS,
  CF_IMAGE_GEN_TIMEOUT_MS,
  callCloudflareVisionWithFallback,
  callCloudflareImageGenerationWithFallback,
  fetchImageAsDataUri,
  dataUriFromBytes,
  validateImageBytes,
  CloudflareAIError,
} from "./ai/cloudflare.js";

export interface WorkerEnv extends Env {
  NVIDIA_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
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

async function verifyAuth(request: Request, env: WorkerEnv): Promise<{ uid: string; token: string; projectId: string }> {
  const token = getBearerToken(request);
  if (!token) throw errorResponse("Missing Authorization Bearer token", 401, "unauthenticated");
  // hack: throw Response and catch higher? Instead return error response directly
  // We'll handle by throwing an object with response
  const projectId = env.FIREBASE_PROJECT_ID || "tiko-6a169";
  try {
    const verified = await verifyFirebaseIdToken(token, projectId);
    return { uid: verified.uid, token, projectId };
  } catch (e: any) {
    console.error("Token verification failed:", e?.message ?? String(e));
    throw errorResponse("Invalid or expired token. Please sign in again.", 401, "unauthenticated");
  }
}

// Helper to check if thrown is a Response
function isResponse(x: unknown): x is Response {
  return x instanceof Response;
}

function isCloudflareConfigured(env: WorkerEnv): boolean {
  return !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID.length > 5 && env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_API_TOKEN.length > 10);
}

// --- Handler for /ai/analyze-image ---
async function handleAnalyzeImage(request: Request, env: WorkerEnv): Promise<Response> {
  let auth: { uid: string; token: string; projectId: string };
  try {
    const t = getBearerToken(request);
    if (!t) return errorResponse("Missing Authorization Bearer token", 401, "unauthenticated");
    const projectId = env.FIREBASE_PROJECT_ID || "tiko-6a169";
    const verified = await verifyFirebaseIdToken(t, projectId);
    auth = { uid: verified.uid, token: t, projectId };
  } catch (e: any) {
    if (isResponse(e)) return e;
    console.error("Token verification failed:", e?.message ?? String(e));
    return errorResponse("Invalid or expired token. Please sign in again.", 401, "unauthenticated");
  }

  if (!isCloudflareConfigured(env)) {
    const hasAccount = !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID.length > 5);
    const hasToken = !!(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_API_TOKEN.length > 10);
    console.error(`Cloudflare AI not configured for analyze-image account=${hasAccount} token=${hasToken}`);
    // Safe message: tell which var missing without exposing value
    if (!hasAccount && !hasToken) return errorResponse("Cloudflare not configured: missing CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Set via wrangler secret put.", 500, "failed-precondition");
    if (!hasAccount) return errorResponse("Cloudflare not configured: missing CLOUDFLARE_ACCOUNT_ID.", 500, "failed-precondition");
    return errorResponse("Cloudflare not configured: missing CLOUDFLARE_API_TOKEN (needs Workers AI Read/Write).", 500, "failed-precondition");
  }

  const contentType = request.headers.get("content-type") ?? "";

  let dataUri: string | null = null;
  let prompt: string = "Describe this image. Include main objects, scene, colors, and read any visible text if present.";
  let conversationId: string | null = null;

  try {
    if (contentType.includes("multipart/form-data")) {
      // Multipart upload
      const formData = await request.formData();
      const fileEntry = formData.get("image") ?? formData.get("file") ?? formData.get("imageFile");
      const q = formData.get("question") ?? formData.get("prompt") ?? formData.get("message") ?? formData.get("text");
      if (typeof q === "string" && q.trim().length > 0) prompt = q.trim();
      const cid = formData.get("conversationId");
      if (typeof cid === "string" && cid.trim().length > 0) conversationId = cid.trim();

      if (!fileEntry || !(fileEntry instanceof File)) {
        return errorResponse("Image file is required (field: image)", 400, "invalid-argument");
      }
      const file = fileEntry as File;
      if (file.size === 0) return errorResponse("Image file is empty", 400, "invalid-argument");
      if (file.size > 10 * 1024 * 1024) return errorResponse("Image too large (max 10MB)", 400, "invalid-argument");
      const mime = file.type || "image/jpeg";
      const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "image/jpg"];
      if (!allowed.includes(mime.toLowerCase()) && !mime.startsWith("image/")) {
        return errorResponse(`Unsupported image type: ${mime}`, 400, "invalid-argument");
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      validateImageBytes(buf, mime);
      dataUri = dataUriFromBytes(buf, mime);
    } else {
      // JSON body
      let body: any;
      try {
        body = await request.json();
      } catch {
        return errorResponse("Invalid JSON body", 400, "invalid-argument");
      }

      // Extract prompt / question
      if (typeof body.question === "string" && body.question.trim().length > 0) prompt = body.question.trim();
      else if (typeof body.prompt === "string" && body.prompt.trim().length > 0) prompt = body.prompt.trim();
      else if (typeof body.message === "string" && body.message.trim().length > 0) prompt = body.message.trim();
      else if (typeof body.text === "string" && body.text.trim().length > 0) prompt = body.text.trim();
      // conversationId
      if (typeof body.conversationId === "string" && body.conversationId.trim().length > 0) conversationId = body.conversationId.trim();

      // Image sources: imageBase64, image_base64, image, imageUrl, image_url, dataUri
      let rawBase64: string | null = null;
      let rawMime: string | null = null;

      if (typeof body.imageBase64 === "string" && body.imageBase64.trim().length > 0) rawBase64 = body.imageBase64.trim();
      else if (typeof body.image_base64 === "string" && body.image_base64.trim().length > 0) rawBase64 = body.image_base64.trim();
      else if (typeof body.image === "string" && body.image.trim().length > 0 && body.image.trim().length > 100) {
        // Could be base64 or data URI; if it looks like URL treat as url, else base64
        const s = body.image.trim();
        if (s.startsWith("data:image/")) rawBase64 = s;
        else if (s.startsWith("http")) {
          // treat as URL below
        } else rawBase64 = s;
      } else if (typeof body.dataUri === "string" && body.dataUri.trim().length > 0) rawBase64 = body.dataUri.trim();

      if (rawBase64) {
        if (rawBase64.startsWith("data:image/")) {
          dataUri = rawBase64;
          // Validate size without leaking data
          const base64Part = rawBase64.split(",")[1] ?? "";
          try {
            const binaryLen = Math.floor(base64Part.length * 0.75);
            if (binaryLen > 10 * 1024 * 1024) return errorResponse("Image too large (max 10MB)", 400, "invalid-argument");
            if (binaryLen < 10) return errorResponse("Invalid image data", 400, "invalid-argument");
          } catch {}
        } else {
          // Raw base64, assume jpeg
          const clean = rawBase64.replace(/\s/g, "");
          if (clean.length < 10) return errorResponse("Invalid image data", 400, "invalid-argument");
          if (clean.length > 14 * 1024 * 1024) return errorResponse("Image too large (max 10MB)", 400, "invalid-argument");
          // Validate base64 charset
          if (!/^[A-Za-z0-9+/=]+$/.test(clean.slice(0, 1000))) return errorResponse("Invalid base64 image", 400, "invalid-argument");
          const mime = typeof body.mime === "string" && body.mime.startsWith("image/") ? body.mime : "image/jpeg";
          dataUri = `data:${mime};base64,${clean}`;
          // Optional: try to decode small check
          try {
            const bin = Uint8Array.from(atob(clean.slice(0, 1000)), c => c.charCodeAt(0));
            if (bin.length === 0) throw new Error("empty");
          } catch {
            return errorResponse("Invalid base64 image", 400, "invalid-argument");
          }
        }
      } else {
        // Check imageUrl
        let url: string | null = null;
        if (typeof body.imageUrl === "string" && body.imageUrl.trim().length > 0) url = body.imageUrl.trim();
        else if (typeof body.image_url === "string" && body.image_url.trim().length > 0) url = body.image_url.trim();
        else if (typeof body.url === "string" && body.url.trim().length > 0) url = body.url.trim();

        if (!url) return errorResponse("Image is required (provide imageBase64 or imageUrl)", 400, "invalid-argument");
        // Fetch and convert to data URI securely
        try {
          const fetched = await fetchImageAsDataUri(url);
          dataUri = fetched.dataUri;
        } catch (e: any) {
          if (e instanceof CloudflareAIError) return errorResponse(e.message, e.status ?? 400, e.code ?? "invalid-argument");
          return errorResponse("Failed to fetch image from URL", 400, "invalid-argument");
        }
      }
    }

    if (!dataUri) return errorResponse("Image is required", 400, "invalid-argument");
    if (prompt.length > 2000) return errorResponse("Prompt too long (max 2000 chars)", 400, "invalid-argument");
    // Normalize prompt: support questions list from spec
    if (prompt.trim().length === 0) prompt = "Describe this image. Include main objects, scene, colors, and read any visible text if present.";
    // Add OCR hint if prompt is short generic
    const lowerPrompt = prompt.toLowerCase();
    const needsOcrHint = lowerPrompt.includes("read") || lowerPrompt.includes("text") || lowerPrompt.includes("extract");
    if (needsOcrHint && !lowerPrompt.includes("visible text")) {
      // keep original prompt but ensure we ask to extract text
      prompt = prompt + " If there is visible text in the image, extract it accurately.";
    }

    // Verify conversation ownership if provided
    if (conversationId) {
      let firestoreToken: string;
      try {
        firestoreToken = await getAccessToken(env as any);
      } catch {
        firestoreToken = auth.token;
      }
      try {
        const conv = await getConversation(auth.projectId, firestoreToken, conversationId);
        if (!conv.exists) return errorResponse("Conversation not found.", 404, "not-found");
        if (conv.data?.userId !== auth.uid) return errorResponse("You do not own this conversation.", 403, "permission-denied");
      } catch (e: any) {
        const status = (e as FirestoreError)?.status ?? (e?.status as number | undefined);
        const msg = e?.message ?? String(e);
        if (status === 403) return errorResponse("You do not own this conversation.", 403, "permission-denied");
        if (status === 404) return errorResponse("Conversation not found.", 404, "not-found");
        console.error("Firestore error in analyze:", msg);
        return errorResponse("Failed to load conversation. Please try again.", 500, "internal");
      }
    }

    // Call Cloudflare Vision
    let resultText: string;
    let usedModel: string;
    try {
      const res = await callCloudflareVisionWithFallback({
        accountId: env.CLOUDFLARE_ACCOUNT_ID!,
        apiToken: env.CLOUDFLARE_API_TOKEN!,
        dataUri,
        prompt,
      });
      resultText = res.text;
      usedModel = res.model;
    } catch (e: any) {
      const err = e as CloudflareAIError;
      const msg = err?.message ?? String(e);
      const status = err?.status ?? 500;
      const code = err?.code ?? "internal";
      // Safe log: never token, but include status/msg for debugging
      console.error(`Cloudflare vision failed status=${status} code=${code} msg=${msg.slice(0, 800)} model=${CF_VISION_MODEL}`);
      // Propagate safe detailed message to client for debugging (msg already sanitized, no token)
      // This fixes the "temporarily unavailable" hiding; Flutter will now see actual reason.
      return errorResponse(msg, status, code);
    }

    if (!resultText || resultText.trim().length === 0) return errorResponse("Empty response from vision model. Model may be overloaded.", 500, "internal");

    if (conversationId) {
      try {
        let at: string;
        try { at = await getAccessToken(env as any); } catch { at = auth.token; }
        await updateConversationMetadata(auth.projectId, at, conversationId, resultText);
      } catch (_) {}
    }

    return jsonResponse({
      success: true,
      type: "image_analysis",
      text: resultText,
      response: resultText,
      model: usedModel,
      prompt,
    });
  } catch (e: any) {
    if (isResponse(e)) return e;
    const msg = e?.message ?? String(e);
    console.error("analyze-image unexpected error:", msg.slice(0, 800));
    // Safe: return sanitized message without token
    return errorResponse(`Unexpected error: ${msg.slice(0, 300)}`, 500, "internal");
  }
}

// --- Handler for /ai/generate-image ---
async function handleGenerateImage(request: Request, env: WorkerEnv): Promise<Response> {
  let auth: { uid: string; token: string; projectId: string };
  try {
    const t = getBearerToken(request);
    if (!t) return errorResponse("Missing Authorization Bearer token", 401, "unauthenticated");
    const projectId = env.FIREBASE_PROJECT_ID || "tiko-6a169";
    const verified = await verifyFirebaseIdToken(t, projectId);
    auth = { uid: verified.uid, token: t, projectId };
  } catch (e: any) {
    if (isResponse(e)) return e;
    console.error("Token verification failed:", e?.message ?? String(e));
    return errorResponse("Invalid or expired token. Please sign in again.", 401, "unauthenticated");
  }

  if (!isCloudflareConfigured(env)) {
    const hasAccount = !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID.length > 5);
    const hasToken = !!(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_API_TOKEN.length > 10);
    console.error(`Cloudflare AI not configured for generate-image account=${hasAccount} token=${hasToken}`);
    if (!hasAccount && !hasToken) return errorResponse("Cloudflare not configured: missing CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.", 500, "failed-precondition");
    if (!hasAccount) return errorResponse("Cloudflare not configured: missing CLOUDFLARE_ACCOUNT_ID.", 500, "failed-precondition");
    return errorResponse("Cloudflare not configured: missing CLOUDFLARE_API_TOKEN.", 500, "failed-precondition");
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400, "invalid-argument");
  }

  let prompt: string | null = null;
  if (typeof body.prompt === "string" && body.prompt.trim().length > 0) prompt = body.prompt.trim();
  else if (typeof body.message === "string" && body.message.trim().length > 0) prompt = body.message.trim();
  else if (typeof body.text === "string" && body.text.trim().length > 0) prompt = body.text.trim();
  else if (typeof body.question === "string" && body.question.trim().length > 0) prompt = body.question.trim();

  if (!prompt || prompt.length === 0) return errorResponse("Prompt is required for image generation", 400, "invalid-argument");
  if (prompt.length > 2048) return errorResponse("Prompt too long (max 2048 chars)", 400, "invalid-argument");

  let conversationId: string | null = null;
  if (typeof body.conversationId === "string" && body.conversationId.trim().length > 0) conversationId = body.conversationId.trim();

  // Optional params
  let steps: number | undefined;
  if (typeof body.steps === "number" && body.steps > 0) steps = Math.min(20, Math.floor(body.steps));
  if (typeof body.num_steps === "number") steps = Math.min(20, Math.floor(body.num_steps));
  let seed: number | undefined;
  if (typeof body.seed === "number") seed = Math.floor(body.seed);

  if (conversationId) {
    let firestoreToken: string;
    try { firestoreToken = await getAccessToken(env as any); } catch { firestoreToken = auth.token; }
    try {
      const conv = await getConversation(auth.projectId, firestoreToken, conversationId);
      if (!conv.exists) return errorResponse("Conversation not found.", 404, "not-found");
      if (conv.data?.userId !== auth.uid) return errorResponse("You do not own this conversation.", 403, "permission-denied");
    } catch (e: any) {
      const status = (e as FirestoreError)?.status ?? (e?.status as number | undefined);
      if (status === 403) return errorResponse("You do not own this conversation.", 403, "permission-denied");
      if (status === 404) return errorResponse("Conversation not found.", 404, "not-found");
      console.error("Firestore error in generate:", e?.message ?? String(e));
      return errorResponse("Failed to load conversation. Please try again.", 500, "internal");
    }
  }

  try {
    const res = await callCloudflareImageGenerationWithFallback({
      accountId: env.CLOUDFLARE_ACCOUNT_ID!,
      apiToken: env.CLOUDFLARE_API_TOKEN!,
      prompt: prompt!,
      steps,
      seed,
    });

    // Update conversation preview if needed
    if (conversationId) {
      try {
        let at: string;
        try { at = await getAccessToken(env as any); } catch { at = auth.token; }
        await updateConversationMetadata(auth.projectId, at, conversationId, `[Generated image: ${prompt!.slice(0, 60)}]`);
      } catch (_) {}
    }

    return jsonResponse({
      success: true,
      type: "image_generation",
      prompt: prompt!,
      imageBase64: res.dataUri,
      image: res.base64,
      dataUri: res.dataUri,
      mime: res.mime,
      model: res.model,
    });
  } catch (e: any) {
    const err = e as CloudflareAIError;
    const msg = err?.message ?? String(e);
    const status = err?.status ?? 500;
    const code = err?.code ?? "internal";
    console.error(`Cloudflare image generation failed status=${status} code=${code} msg=${msg.slice(0, 800)} model=${CF_IMAGE_GEN_MODEL}`);
    return errorResponse(msg, status, code);
  }
}

// --- Chat handler (existing logic extracted) ---
async function handleChat(request: Request, env: WorkerEnv): Promise<Response> {
  const token = getBearerToken(request);
  if (!token) return errorResponse("Missing Authorization Bearer token", 401, "unauthenticated");
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

  let imageUrl: string | undefined;
  if (body.imageUrl !== undefined && body.imageUrl !== null) {
    if (typeof body.imageUrl !== "string") return errorResponse("imageUrl must be a string.", 400, "invalid-argument");
    const t = body.imageUrl.trim();
    if (t.length > 0) {
      if (t.length > 2000) return errorResponse("imageUrl too long.", 400, "invalid-argument");
      if (!t.startsWith("https://") && !t.startsWith("http://")) return errorResponse("imageUrl must be a valid URL.", 400, "invalid-argument");
      imageUrl = t;
    }
  }

  if ((!userMessage || userMessage.length === 0) && !imageUrl) {
    return errorResponse("Message is required and cannot be empty.", 400, "invalid-argument");
  }
  if ((!userMessage || userMessage.length === 0) && imageUrl) {
    userMessage = "Describe this image.";
  }
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

  let assistantText: string;
  try {
    if (imageUrl) {
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
        cfVisionModel: CF_VISION_MODEL,
        cfImageGenModel: CF_IMAGE_GEN_MODEL,
        timestamp: new Date().toISOString(),
        nvidiaConfigured: !!(env.NVIDIA_API_KEY && env.NVIDIA_API_KEY.length > 10),
        cloudflareConfigured: isCloudflareConfigured(env),
      });
    }

    // New Cloudflare Workers AI endpoints (must be before generic chat fallback)
    if ((url.pathname === "/ai/analyze-image" || url.pathname === "/api/ai/analyze-image") && request.method === "POST") {
      return await handleAnalyzeImage(request, env);
    }
    if ((url.pathname === "/ai/generate-image" || url.pathname === "/api/ai/generate-image") && request.method === "POST") {
      return await handleGenerateImage(request, env);
    }

    const isChatPath = url.pathname === "/chat" || url.pathname === "/" || url.pathname === "/api/chat";
    if (isChatPath) {
      if (request.method !== "POST") return errorResponse("Method not allowed", 405, "method-not-allowed");
      return await handleChat(request, env);
    }

    return errorResponse("Not found", 404, "not-found");
  },
} satisfies ExportedHandler<WorkerEnv>;
