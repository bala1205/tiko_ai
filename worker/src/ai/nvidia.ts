import { AI_CONFIG, type NvidiaMessage } from "./config.js";

export class NvidiaError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "NvidiaError";
    this.status = status;
  }
}

function parseAssistantContent(json: unknown): string | null {
  const j = json as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
  const choice = j?.choices?.[0];
  const raw = choice?.message?.content ?? (choice as any)?.text ?? null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return raw;
}

export async function callNvidia(
  model: string,
  messages: NvidiaMessage[],
  apiKey: string,
  timeoutMs: number,
): Promise<string> {
  if (!apiKey || apiKey.length < 10) {
    throw new NvidiaError("AI service is not configured. Please contact support.", 0);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(AI_CONFIG.NVIDIA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: AI_CONFIG.TEMPERATURE,
        max_tokens: AI_CONFIG.MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(timeout);
    if (e?.name === "AbortError") {
      const abortErr = new NvidiaError(`NVIDIA ${model} timeout after ${timeoutMs}ms`) as NvidiaError;
      abortErr.name = "AbortError";
      throw abortErr;
    }
    const netErr = new NvidiaError(`NVIDIA ${model} network error: ${e?.message ?? String(e)}`);
    throw netErr;
  }

  clearTimeout(timeout);

  if (!resp.ok) {
    const errText = await resp.text();
    const err = new NvidiaError(`NVIDIA ${model} ${resp.status}: ${errText.slice(0, 200)}`, resp.status);
    throw err;
  }

  const json: unknown = await resp.json();
  const content = parseAssistantContent(json);
  if (content === null) {
    throw new NvidiaError(`NVIDIA ${model} empty response`);
  }
  return content;
}

export function isTransientError(e: unknown): boolean {
  const err = e as Error & { status?: number; name?: string };
  if (err?.name === "AbortError") return true;
  const msg = (err?.message ?? "").toLowerCase();
  if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("aborterror") || msg.includes("aborted")) return true;
  const status = (err as NvidiaError)?.status;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (msg.includes("empty response") || msg.includes("unexpected ai response") || msg.includes("failed to reach ai")) return true;
  if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("connection")) return true;
  return false;
}

export function isConfigError(e: unknown): boolean {
  const msg = ((e as Error)?.message ?? "").toLowerCase();
  const status = (e as NvidiaError)?.status;
  if (status === 401 || status === 403) return true;
  if (msg.includes("ai service not configured") || msg.includes("auth failed") || msg.includes("invalid api key") || msg.includes("401") || msg.includes("403")) return true;
  if (status === 400) return true;
  return false;
}

export async function callNvidiaWithFallback(messages: NvidiaMessage[], apiKey: string): Promise<string> {
  let lastError: unknown = null;

  try {
    const result = await callNvidia(AI_CONFIG.PRIMARY_MODEL, messages, apiKey, AI_CONFIG.PRIMARY_TIMEOUT_MS);
    return result;
  } catch (e) {
    lastError = e;
    const msg = (e as Error)?.message ?? String(e);
    const status = (e as NvidiaError)?.status;

    if (isConfigError(e)) {
      if (status === 401 || status === 403) {
        throw new NvidiaError("AI provider authentication failed. Please contact support.", status);
      }
      if (msg.toLowerCase().includes("ai service not configured")) {
        throw new NvidiaError("AI service is not configured. Please contact support.", 0);
      }
      if (status === 400) {
        throw new NvidiaError(`AI provider error (${status}). Please try again.`, 400);
      }
      // generic config error mapped to 500
      throw new NvidiaError("AI provider error. Please try again.", status ?? 500);
    }

    if (isTransientError(e)) {
      try {
        const fallbackResult = await callNvidia(AI_CONFIG.FALLBACK_MODEL, messages, apiKey, AI_CONFIG.FALLBACK_TIMEOUT_MS);
        return fallbackResult;
      } catch (fe) {
        lastError = fe;
      }
    } else {
      const statusCode = (e as NvidiaError)?.status;
      if (statusCode === 429) {
        throw new NvidiaError("AI service is busy. Please try again in a moment.", 429);
      }
    }
  }

  const err = lastError as Error & { status?: number; name?: string };
  const status = (err as NvidiaError)?.status;
  if (err?.name === "AbortError" || (err?.message ?? "").toLowerCase().includes("timed out")) {
    throw new NvidiaError("AI request timed out. Please try again.", 504);
  }
  if (status === 429) {
    throw new NvidiaError("AI service is busy. Please try again in a moment.", 429);
  }
  if (status && status >= 500) {
    throw new NvidiaError("AI service is temporarily unavailable. Please try again.", status);
  }
  throw new NvidiaError("AI service is temporarily unavailable. Please try again.", status ?? 500);
}

export async function callVisionWithFallback(messages: NvidiaMessage[], apiKey: string): Promise<string> {
  // Vision routing: primary vision model only (entitled meta/llama-3.2-11b-vision-instruct via Cloudinary)
  // No text fallback for image; if vision fails with 404/400, surface as unavailable (do not fake).
  try {
    const result = await callNvidia(AI_CONFIG.VISION_MODEL, messages, apiKey, AI_CONFIG.VISION_TIMEOUT_MS);
    return result;
  } catch (e) {
    const status = (e as NvidiaError)?.status;
    const msg = (e as Error)?.message ?? String(e);
    if (status === 404 || msg.includes("Not found") || msg.includes("not found")) {
      throw new NvidiaError("Image analysis is currently unavailable.", 404);
    }
    if (isConfigError(e)) {
      if (status === 401 || status === 403) throw new NvidiaError("AI provider authentication failed. Please contact support.", status);
      if (status === 400) throw new NvidiaError("Image analysis is currently unavailable.", 400);
      throw e;
    }
    if (isTransientError(e)) {
      // Try vision fallback if different, otherwise rethrow with timeout mapping
      if (AI_CONFIG.VISION_FALLBACK_MODEL !== AI_CONFIG.VISION_MODEL) {
        try {
          const fb = await callNvidia(AI_CONFIG.VISION_FALLBACK_MODEL, messages, apiKey, AI_CONFIG.VISION_TIMEOUT_MS);
          return fb;
        } catch (fe) {
          const fStatus = (fe as NvidiaError)?.status;
          if (fStatus === 404) throw new NvidiaError("Image analysis is currently unavailable.", 404);
          throw fe;
        }
      }
    }
    throw e;
  }
}
