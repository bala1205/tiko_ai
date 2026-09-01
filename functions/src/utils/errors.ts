import { HttpsError } from "firebase-functions/v2/https";

/**
 * Maps NVIDIA HTTP errors to safe HttpsErrors.
 * Never exposes keys, headers, or raw secrets.
 */
export function mapNvidiaError(status: number, bodyText: string): never {
  console.error(`NVIDIA API error ${status}: ${bodyText.slice(0, 1000)}`);
  if (status === 401 || status === 403) {
    throw new HttpsError("internal", "AI provider authentication failed. Please contact support.");
  }
  if (status === 429) {
    throw new HttpsError("resource-exhausted", "AI service is busy. Please try again in a moment.");
  }
  if (status >= 500) {
    throw new HttpsError("unavailable", "AI service is temporarily unavailable. Please try again.");
  }
  throw new HttpsError("internal", `AI provider error (${status}). Please try again.`);
}

export function safeLog(provider: string, status: number) {
  console.log(`[${provider}] response status: ${status}`);
}
