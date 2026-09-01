// Supabase Edge Function: chat-with-ai
// Deno runtime, TypeScript
// Secure NVIDIA proxy: verifies Supabase JWT, checks conversation ownership, loads context, calls NVIDIA with fallback

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const NVIDIA_API_KEY = Deno.env.get("NVIDIA_API_KEY") ?? "";

// Centralized model configuration
const PRIMARY_MODEL = "moonshotai/kimi-k3";
const FALLBACK_MODEL = "google/diffusiongemma-26b-a4b-it";
const PRIMARY_TIMEOUT_MS = 30000;
const FALLBACK_TIMEOUT_MS = 30000;
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MAX_CONTEXT = 30;
const MAX_MESSAGE_LEN = 10000;

const SYSTEM_PROMPT =
  "You are Tiko AI, a helpful, accurate, and friendly AI assistant. Answer clearly and naturally. Use Markdown when useful. Explain technical concepts clearly.";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Safe response parsing — treat empty content as failure for fallback
function parseAssistantContent(json: unknown): string | null {
  const j = json as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
  const choice = j?.choices?.[0];
  const raw = choice?.message?.content ?? choice?.text ?? null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return raw;
}

// Call NVIDIA with given model and timeout, throws on failure
async function callNvidia(
  model: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 2048,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const txt = await resp.text();
      console.error(`NVIDIA ${model} ${resp.status}: ${txt.slice(0, 1000)}`);
      // Throw with status for caller to decide fallback
      const err = new Error(`NVIDIA ${model} ${resp.status}: ${txt.slice(0, 200)}`) as Error & { status?: number };
      (err as unknown as Record<string, unknown>).status = resp.status;
      throw err;
    }
    const json: unknown = await resp.json();
    const content = parseAssistantContent(json);
    if (content === null) {
      console.error(`NVIDIA ${model} empty/invalid response: ${JSON.stringify(json).slice(0, 1000)}`);
      throw new Error(`NVIDIA ${model} empty response`);
    }
    return content;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

function isTransientError(e: unknown): boolean {
  const err = e as Error & { status?: number; name?: string };
  if (err?.name === "AbortError") return true;
  const msg = (err?.message ?? "").toLowerCase();
  if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("aborterror") || msg.includes("aborted")) return true;
  const status = err?.status;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (msg.includes("empty response") || msg.includes("unexpected ai response") || msg.includes("failed to reach ai")) return true;
  // Network errors
  if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("connection")) return true;
  return false;
}

function isConfigError(e: unknown): boolean {
  const msg = ((e as Error)?.message ?? "").toLowerCase();
  const status = (e as Error & { status?: number })?.status;
  if (status === 401 || status === 403) return true;
  if (msg.includes("ai service not configured") || msg.includes("auth failed") || msg.includes("invalid api key") || msg.includes("401") || msg.includes("403")) return true;
  // Bad request due to our payload — don't fallback, fix code
  if (status === 400) return true;
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  // Auth: require Supabase JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ success: false, error: "Missing Authorization header" }, 401);
  }
  const jwt = authHeader.replace("Bearer ", "").trim();
  if (!jwt) return jsonResponse({ success: false, error: "Invalid JWT" }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    console.error("getUser failed", userErr);
    return jsonResponse({ success: false, error: "Invalid or expired session" }, 401);
  }
  const uid = userData.user.id;
  console.log(`chat-with-ai uid=${uid}`);

  let body: { message?: unknown; conversationId?: unknown; imageUrl?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  let userMessage: string | null = null;
  if (typeof body.message === "string" && (body.message as string).trim().length > 0) {
    userMessage = (body.message as string).trim();
  } else if (Array.isArray(body.messages) && (body.messages as unknown[]).length > 0) {
    const msgs = body.messages as Array<{ role?: unknown; content?: unknown }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role === "user" && typeof m.content === "string" && m.content.trim().length > 0) {
        userMessage = m.content.trim();
        break;
      }
    }
    if (!userMessage) {
      const last = msgs[msgs.length - 1];
      if (last && typeof last.content === "string") userMessage = (last.content as string).trim();
    }
  }

  if (!userMessage || userMessage.length === 0) {
    return jsonResponse({ success: false, error: "Message is required and cannot be empty" }, 400);
  }
  if (userMessage.length > MAX_MESSAGE_LEN) {
    return jsonResponse({ success: false, error: `Message too long (max ${MAX_MESSAGE_LEN})` }, 400);
  }

  let conversationId: string | null = null;
  if (body.conversationId != null) {
    if (typeof body.conversationId !== "string") {
      return jsonResponse({ success: false, error: "conversationId must be a string" }, 400);
    }
    const t = (body.conversationId as string).trim();
    if (t.length > 0) conversationId = t;
  }

  if (body.imageUrl != null && typeof body.imageUrl !== "string") {
    return jsonResponse({ success: false, error: "imageUrl must be a string" }, 400);
  }
  const imageUrl = typeof body.imageUrl === "string" ? (body.imageUrl as string).trim() : undefined;
  if (imageUrl && imageUrl.length > 2000) {
    return jsonResponse({ success: false, error: "imageUrl too long" }, 400);
  }
  if (imageUrl) {
    console.warn(`Image URL received but vision disabled for ${PRIMARY_MODEL}`);
  }

  let history: Array<{ role: string; content: string }> = [];
  if (conversationId) {
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .select("user_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (convErr) {
      console.error("conv fetch err", convErr);
      return jsonResponse({ success: false, error: "Failed to verify conversation" }, 500);
    }
    if (!conv) return jsonResponse({ success: false, error: "Conversation not found" }, 404);
    if ((conv as { user_id: string }).user_id !== uid) {
      return jsonResponse({ success: false, error: "Forbidden: not your conversation" }, 403);
    }
    const { data: msgs, error: msgsErr } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(MAX_CONTEXT);
    if (msgsErr) {
      console.error("msgs err", msgsErr);
      return jsonResponse({ success: false, error: "Failed to load history" }, 500);
    }
    history = (msgs as Array<{ role: string; content: string }> ?? []).reverse();
  }

  const last = history[history.length - 1];
  const needsAppend = !last || last.content !== userMessage || last.role !== "user";
  const nvidiaMessages: Array<{ role: string; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  if (needsAppend) nvidiaMessages.push({ role: "user", content: userMessage });

  if (!NVIDIA_API_KEY || NVIDIA_API_KEY.length < 10) {
    console.error("NVIDIA_API_KEY not set");
    return jsonResponse({ success: false, error: "AI service not configured" }, 500);
  }

  // Try primary, fallback on transient failures
  let assistantText: string | null = null;
  let lastError: unknown = null;

  try {
    console.log(`Trying primary ${PRIMARY_MODEL} timeout ${PRIMARY_TIMEOUT_MS}ms`);
    assistantText = await callNvidia(PRIMARY_MODEL, nvidiaMessages, PRIMARY_TIMEOUT_MS);
    console.log(`Primary ${PRIMARY_MODEL} succeeded len=${assistantText.length}`);
  } catch (e) {
    lastError = e;
    const msg = (e as Error)?.message ?? String(e);
    const status = (e as Error & { status?: number })?.status;
    console.error(`Primary ${PRIMARY_MODEL} failed status=${status} err=${msg.slice(0, 500)}`);
    // Do NOT fallback on config errors (401/403/missing key/400)
    if (isConfigError(e)) {
      if (status === 401 || status === 403) return jsonResponse({ success: false, error: "AI provider auth failed" }, 500);
      if (msg.toLowerCase().includes("ai service not configured")) return jsonResponse({ success: false, error: "AI service not configured" }, 500);
      return jsonResponse({ success: false, error: `AI provider error ${status ?? 500}` }, 500);
    }
    if (isTransientError(e)) {
      console.log(`Transient error, trying fallback ${FALLBACK_MODEL}`);
      try {
        assistantText = await callNvidia(FALLBACK_MODEL, nvidiaMessages, FALLBACK_TIMEOUT_MS);
        console.log(`Fallback ${FALLBACK_MODEL} succeeded len=${assistantText.length}`);
      } catch (fe) {
        console.error(`Fallback ${FALLBACK_MODEL} also failed: ${(fe as Error)?.message?.slice(0, 500)}`);
        lastError = fe;
        // Both failed
      }
    } else {
      // Non-transient, don't fallback
      console.error(`Non-transient primary error, not falling back`);
    }
  }

  if (assistantText === null) {
    // Both primary and fallback failed (or primary non-transient)
    const err = lastError as Error & { status?: number };
    const status = err?.status;
    if (err?.name === "AbortError" || (err?.message ?? "").toLowerCase().includes("timed out")) {
      return jsonResponse({ success: false, error: "AI service is temporarily unavailable. Please try again." }, 504);
    }
    if (status === 429) return jsonResponse({ success: false, error: "AI service is busy. Please try again." }, 429);
    if (status && status >= 500) return jsonResponse({ success: false, error: "AI service is temporarily unavailable. Please try again." }, 502);
    return jsonResponse({ success: false, error: "AI service is temporarily unavailable. Please try again." }, 500);
  }

  if (conversationId) {
    try {
      await supabase.from("conversations").update({
        updated_at: new Date().toISOString(),
        last_message_preview: assistantText.slice(0, 80),
      }).eq("id", conversationId);
    } catch (_) {}
  }

  console.log(`chat-with-ai success len=${assistantText.length}`);
  return jsonResponse({
    success: true,
    message: { role: "assistant", content: assistantText },
    response: assistantText,
  });
});
