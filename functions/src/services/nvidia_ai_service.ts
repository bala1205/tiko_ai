import { HttpsError } from "firebase-functions/v2/https";
import { AI_CONFIG } from "../config/ai_config";
import { NvidiaMessage } from "../types/chat";
import { mapNvidiaError } from "../utils/errors";

/**
 * Safe response parsing — treat empty content as failure for fallback
 */
function parseAssistantContent(json: unknown): string | null {
  const j = json as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
  const choice = j?.choices?.[0];
  const raw = choice?.message?.content ?? choice?.text ?? null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return raw;
}

/**
 * Calls NVIDIA Integrate API for a specific model with timeout.
 * Throws on failure with status attached for fallback decision.
 */
export async function callNvidia(
  model: string,
  messages: NvidiaMessage[],
  apiKey: string,
  timeoutMs: number,
): Promise<string> {
  if (!apiKey || apiKey.length < 10) {
    console.error("NVIDIA_API_KEY secret not configured");
    throw new HttpsError("failed-precondition", "AI service is not configured. Please contact support.");
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
      const abortErr = new Error(`NVIDIA ${model} timeout after ${timeoutMs}ms`) as Error & { status?: number; name?: string };
      abortErr.name = "AbortError";
      throw abortErr;
    }
    console.error(`Failed to call NVIDIA ${model}`, e);
    const netErr = new Error(`NVIDIA ${model} network error: ${e?.message ?? String(e)}`) as Error & { status?: number };
    throw netErr;
  }

  clearTimeout(timeout);

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`NVIDIA ${model} ${resp.status}: ${errText.slice(0, 1000)}`);
    const err = new Error(`NVIDIA ${model} ${resp.status}: ${errText.slice(0, 200)}`) as Error & { status?: number };
    (err as unknown as Record<string, unknown>).status = resp.status;
    throw err;
  }

  const json: unknown = await resp.json();
  const content = parseAssistantContent(json);
  if (content === null) {
    console.error(`NVIDIA ${model} empty/invalid response: ${JSON.stringify(json).slice(0, 1000)}`);
    const err = new Error(`NVIDIA ${model} empty response`) as Error & { status?: number };
    throw err;
  }
  return content;
}

/**
 * Determines if error is transient and should trigger fallback.
 * Transient: timeout/AbortError, 500,502,503,504, empty response, network errors.
 */
export function isTransientError(e: unknown): boolean {
  const err = e as Error & { status?: number; name?: string };
  if (err?.name === "AbortError") return true;
  const msg = (err?.message ?? "").toLowerCase();
  if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("aborterror") || msg.includes("aborted")) return true;
  const status = err?.status;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (msg.includes("empty response") || msg.includes("unexpected ai response") || msg.includes("failed to reach ai")) return true;
  if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("connection")) return true;
  return false;
}

/**
 * Determines if error is config/auth error (do NOT fallback).
 * 401/403, missing key, 400 bad request.
 */
export function isConfigError(e: unknown): boolean {
  const msg = ((e as Error)?.message ?? "").toLowerCase();
  const status = (e as Error & { status?: number })?.status;
  if (status === 401 || status === 403) return true;
  if (msg.includes("ai service not configured") || msg.includes("auth failed") || msg.includes("invalid api key") || msg.includes("401") || msg.includes("403")) return true;
  if (status === 400) return true;
  return false;
}

/**
 * High-level wrapper with primary + fallback logic.
 * Returns assistant text or throws HttpsError.
 * - Tries PRIMARY_MODEL with PRIMARY_TIMEOUT_MS
 * - On transient failure, tries FALLBACK_MODEL with FALLBACK_TIMEOUT_MS using SAME payload
 * - Does NOT expose fallback information to client
 * - Only throws "AI unavailable" if both fail
 * - Does NOT fallback for config errors (401,403,400, missing key)
 */
export async function callNvidiaWithFallback(
  messages: NvidiaMessage[],
  apiKey: string,
): Promise<string> {
  let lastError: unknown = null;

  // Try primary
  try {
    console.log(`Trying primary ${AI_CONFIG.PRIMARY_MODEL} timeout ${AI_CONFIG.PRIMARY_TIMEOUT_MS}ms`);
    const result = await callNvidia(AI_CONFIG.PRIMARY_MODEL, messages, apiKey, AI_CONFIG.PRIMARY_TIMEOUT_MS);
    console.log(`Primary ${AI_CONFIG.PRIMARY_MODEL} succeeded len=${result.length}`);
    return result;
  } catch (e) {
    lastError = e;
    const msg = (e as Error)?.message ?? String(e);
    const status = (e as Error & { status?: number })?.status;
    console.error(`Primary ${AI_CONFIG.PRIMARY_MODEL} failed status=${status} err=${msg.slice(0, 500)}`);

    // Do NOT fallback on config errors
    if (isConfigError(e)) {
      if (status === 401 || status === 403) {
        throw new HttpsError("internal", "AI provider authentication failed. Please contact support.");
      }
      if (msg.toLowerCase().includes("ai service not configured")) {
        throw new HttpsError("failed-precondition", "AI service is not configured. Please contact support.");
      }
      // For 400 or other config errors, map to internal without fallback
      if (status === 400) {
        throw new HttpsError("invalid-argument", `AI provider error (${status}). Please try again.`);
      }
      // Fall through to mapping for other config errors
      mapNvidiaError(status ?? 500, msg);
    }

    if (isTransientError(e)) {
      console.log(`Transient error, trying fallback ${AI_CONFIG.FALLBACK_MODEL}`);
      try {
        const fallbackResult = await callNvidia(
          AI_CONFIG.FALLBACK_MODEL,
          messages,
          apiKey,
          AI_CONFIG.FALLBACK_TIMEOUT_MS,
        );
        console.log(`Fallback ${AI_CONFIG.FALLBACK_MODEL} succeeded len=${fallbackResult.length}`);
        return fallbackResult;
      } catch (fe) {
        console.error(`Fallback ${AI_CONFIG.FALLBACK_MODEL} also failed: ${(fe as Error)?.message?.slice(0, 500)}`);
        lastError = fe;
        // Both failed — map to user-friendly error
      }
    } else {
      console.error(`Non-transient primary error, not falling back`);
      // For non-transient errors (e.g. 429?), we could map directly
      const statusCode = (e as Error & { status?: number })?.status;
      if (statusCode === 429) {
        throw new HttpsError("resource-exhausted", "AI service is busy. Please try again in a moment.");
      }
      // Let it fall through to generic handling below if not already thrown
    }
  }

  // Both primary and fallback failed (or primary non-transient without fallback)
  const err = lastError as Error & { status?: number; name?: string };
  const status = err?.status;
  if (err?.name === "AbortError" || (err?.message ?? "").toLowerCase().includes("timed out")) {
    throw new HttpsError("deadline-exceeded", "AI request timed out. Please try again.");
  }
  if (status === 429) {
    throw new HttpsError("resource-exhausted", "AI service is busy. Please try again in a moment.");
  }
  if (status && status >= 500) {
    throw new HttpsError("unavailable", "AI service is temporarily unavailable. Please try again.");
  }
  // Generic fallback for other errors
  throw new HttpsError("internal", "AI service is temporarily unavailable. Please try again.");
}

/**
 * Legacy single-model call (kept for backward compatibility, but now uses fallback wrapper).
 * Prefer callNvidiaWithFallback directly.
 */
export async function callNvidiaAI(
  messages: NvidiaMessage[],
  apiKey: string,
): Promise<string> {
  return callNvidiaWithFallback(messages, apiKey);
}
