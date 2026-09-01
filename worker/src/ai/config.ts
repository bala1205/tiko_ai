export const AI_CONFIG = {
  PRIMARY_MODEL: "moonshotai/kimi-k3",
  FALLBACK_MODEL: "google/diffusiongemma-26b-a4b-it",
  PRIMARY_TIMEOUT_MS: 12_000,
  FALLBACK_TIMEOUT_MS: 20_000,

  // Vision routing (only when imageUrl present, verified via Cloudinary secure_url)
  VISION_MODEL: "meta/llama-3.2-11b-vision-instruct",
  VISION_TIMEOUT_MS: 25_000,
  VISION_FALLBACK_MODEL: "meta/llama-3.2-11b-vision-instruct",

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
    "Be supportive and engaging. " +
    "You understand English, Tamil (தமிழ்), Tanglish / Romanized Tamil (e.g., 'enna panra', 'itha explain pannu', 'enaku java easy ahh sollu', 'ithu epdi work aguthu', 'simple ahh explain pannu', 'tanglish la answer kudu'), and mixed Tamil+English. " +
    "Always respond naturally in the SAME language and style the user prefers. " +
    "If the user writes in Tanglish (e.g., 'Java enaku easy ahh explain pannu'), answer in friendly Tanglish (e.g., 'Java na oru programming language. Simple ahh sonna...'). " +
    "If the user writes in Tamil script (e.g., 'ஜாவாவை எளிமையாக விளக்கவும்'), answer in Tamil. " +
    "If the user writes mixed Tamil+English, match that mix. " +
    "Preserve emojis and informal spelling if present. Do not translate unnecessarily. Do not force English-only.",
  MAX_CONTEXT_MESSAGES: 30,
  MAX_MESSAGE_LENGTH: 10000,
  TEMPERATURE: 0.7,
  MAX_TOKENS: 2048,
} as const;

export type NvidiaMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};
