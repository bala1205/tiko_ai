export interface ChatRequest {
  conversationId?: string;
  message?: string;
  messages?: Array<{ role: string; content: string | unknown }>;
  imageUrl?: string;
}

export interface NvidiaMessage {
  role: "system" | "user" | "assistant";
  content: string | unknown;
}

export interface ChatResponse {
  success: boolean;
  message: {
    role: "assistant";
    content: string;
  };
  // Legacy field for existing Flutter client compatibility
  response: string;
}
