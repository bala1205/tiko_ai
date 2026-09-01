import { HttpsError } from "firebase-functions/v2/https";
import { AI_CONFIG } from "../config/ai_config";
import { ChatRequest } from "../types/chat";

/**
 * Validates incoming chat request.
 * Throws HttpsError on invalid input.
 * Supports both {message} and {messages} formats.
 */
export function validateChatRequest(data: unknown): {
  message: string;
  conversationId: string | null;
  imageUrl?: string;
} {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Missing request data.");
  }
  const req = data as ChatRequest;

  // Extract message - support both message string and messages array
  let message: string | null = null;

  if (typeof req.message === "string" && req.message.trim().length > 0) {
    message = req.message.trim();
  } else if (Array.isArray(req.messages) && req.messages.length > 0) {
    // Take last user message from array
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m: any = req.messages[i];
      if (m && m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0) {
        message = m.content.trim();
        break;
      }
    }
    // Fallback: if no user message, take last string content
    if (!message) {
      const last: any = req.messages[req.messages.length - 1];
      if (last && typeof last.content === "string") {
        message = last.content.trim();
      }
    }
  }

  if (!message || message.length === 0) {
    throw new HttpsError("invalid-argument", "Message is required and cannot be empty.");
  }
  if (message.length > AI_CONFIG.MAX_MESSAGE_LENGTH) {
    throw new HttpsError(
      "invalid-argument",
      `Message too long (max ${AI_CONFIG.MAX_MESSAGE_LENGTH} chars).`
    );
  }

  // conversationId is optional per spec but if provided must be string
  let conversationId: string | null = null;
  if (req.conversationId !== undefined && req.conversationId !== null) {
    if (typeof req.conversationId !== "string") {
      throw new HttpsError("invalid-argument", "conversationId must be a string.");
    }
    const trimmed = req.conversationId.trim();
    if (trimmed.length > 0) {
      conversationId = trimmed;
    }
  }

  // imageUrl optional - validate if present
  let imageUrl: string | undefined;
  if (req.imageUrl !== undefined && req.imageUrl !== null) {
    if (typeof req.imageUrl !== "string") {
      throw new HttpsError("invalid-argument", "imageUrl must be a string.");
    }
    const t = req.imageUrl.trim();
    if (t.length > 0) {
      // Basic URL check, don't leak validation details
      if (t.length > 2000) {
        throw new HttpsError("invalid-argument", "imageUrl too long.");
      }
      imageUrl = t;
    }
  }

  return { message, conversationId, imageUrl };
}
