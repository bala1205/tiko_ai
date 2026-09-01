/**
 * Backend AI configuration - single source of truth.
 * Centralized model configuration - do not scatter model names elsewhere.
 * Change values here and redeploy to swap models without touching Flutter.
 */
export const AI_CONFIG = {
  // Primary and fallback models
  PRIMARY_MODEL: "moonshotai/kimi-k3",
  FALLBACK_MODEL: "google/diffusiongemma-26b-a4b-it",
  PRIMARY_TIMEOUT_MS: 30_000,
  FALLBACK_TIMEOUT_MS: 30_000,

  // Legacy aliases for backward compatibility (do not use directly; use PRIMARY_* above)
  get MODEL_NAME(): string {
    return this.PRIMARY_MODEL;
  },
  get TIMEOUT_MS(): number {
    return this.PRIMARY_TIMEOUT_MS;
  },

  NVIDIA_URL: "https://integrate.api.nvidia.com/v1/chat/completions",
  SYSTEM_PROMPT:
    "You are Tiko AI, a helpful, accurate, and friendly AI assistant. " +
    "Answer clearly and naturally. Use Markdown when useful. " +
    "Explain technical concepts in an understandable way. " +
    "Be supportive and engaging.",
  MAX_CONTEXT_MESSAGES: 30,
  MAX_MESSAGE_LENGTH: 10000,
  TEMPERATURE: 0.7,
  MAX_TOKENS: 2048,
} as const;
