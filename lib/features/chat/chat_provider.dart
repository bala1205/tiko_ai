import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/services/ai_service.dart';
import '../../core/services/chat_service.dart';
import '../../core/services/storage_service.dart';
import '../../models/chat_model.dart';
import '../../models/message_model.dart';

final chatServiceProvider = Provider<ChatService>((ref) => ChatService());
final aiServiceProvider = Provider<AiService>((ref) => AiService());

final conversationsProvider = StreamProvider<List<Conversation>>((ref) {
  return ref.watch(chatServiceProvider).watchConversations();
});

final messagesProvider = StreamProvider.family<List<ChatMessage>, String>((ref, conversationId) {
  if (conversationId.isEmpty) return Stream.value([]);
  return ref.watch(chatServiceProvider).watchMessages(conversationId);
});

// Currently selected conversation id (null = new chat state)
final selectedConversationIdProvider = StateProvider<String?>((ref) => null);

// Sending state
class ChatState {
  final bool isSending;
  final String? error;
  final String? streamingText;
  const ChatState({this.isSending = false, this.error, this.streamingText});
  ChatState copyWith({bool? isSending, String? error, String? streamingText}) {
    return ChatState(
      isSending: isSending ?? this.isSending,
      error: error,
      streamingText: streamingText,
    );
  }
}

class ChatNotifier extends StateNotifier<ChatState> {
  final ChatService _chatService;
  final AiService _aiService;
  final Ref _ref;
  ChatNotifier(this._chatService, this._aiService, this._ref) : super(const ChatState());

  bool _sending = false;

  Future<void> sendMessage(String text, {String? imageUrl, Uint8List? imageBytes, String? imageName}) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty && imageUrl == null && imageBytes == null) return;
    if (_sending) return;
    if (state.isSending) return;

    _sending = true;
    state = state.copyWith(isSending: true, error: null);

    try {
      String? convId = _ref.read(selectedConversationIdProvider);
      final isNew = convId == null || convId.isEmpty;

      if (isNew) {
        convId = await _chatService.ensureConversation(
          conversationId: null,
          firstUserMessage: trimmed.isEmpty ? '[Image]' : trimmed,
        );
        _ref.read(selectedConversationIdProvider.notifier).state = convId;
      }

      // For image uploaded via bytes, imageUrl is already Cloudinary URL from ChatPage,
      // but keep support for bytes fallback.
      final hasImage = imageUrl != null && imageUrl.isNotEmpty;
      await _chatService.sendUserMessage(
        conversationId: convId,
        content: trimmed.isEmpty ? '[Image]' : trimmed,
        imageUrl: imageUrl,
      );

      // Route: Image analysis via Cloudflare if image present
      // Route: Image generation if text looks like generation request and no image
      // Route: Normal chat otherwise
      try {
        if (hasImage) {
          // Prefer Cloudflare Workers AI vision for image analysis
          // Use analyzeImage with imageUrl (backend will fetch and convert to base64)
          // Fallback to chat endpoint if Cloudflare fails due to config
          String analysis;
          try {
            analysis = await _aiService.analyzeImage(
              imageUrl: imageUrl,
              imageBytes: imageBytes,
              fileName: imageName,
              prompt: trimmed.isEmpty || trimmed == '[Image]' ? 'Describe this image. What is in this image? Read any visible text if present.' : trimmed,
              conversationId: convId,
            );
          } catch (e) {
            final lower = e.toString().toLowerCase();
            // If Cloudflare not configured or unavailable, fallback to NVIDIA vision via chat
            if (lower.contains('not configured') || lower.contains('unavailable') || lower.contains('busy')) {
              // fallback to normal chat which uses NVIDIA vision
              analysis = await _aiService.chat(
                message: trimmed.isEmpty ? 'Describe this image.' : trimmed,
                conversationId: convId,
                imageUrl: imageUrl,
              );
            } else {
              rethrow;
            }
          }
          await _chatService.saveAssistantMessage(conversationId: convId, content: analysis);
          state = state.copyWith(isSending: false);
          return;
        }

        // Check for image generation intent (only when no image attached)
        if (!hasImage && AiService.isImageGenerationRequest(trimmed)) {
          final genPrompt = AiService.extractGenerationPrompt(trimmed);
          // Call Cloudflare image generation
          final result = await _aiService.generateImage(
            prompt: genPrompt.isEmpty ? trimmed : genPrompt,
            conversationId: convId,
          );
          // Upload generated image to Cloudinary for persistent https URL (compatible with existing image-message system)
          String displayImageUrl = result.dataUri;
          try {
            final bytes = base64Decode(result.base64);
            final storage = StorageService();
            // Use a descriptive filename
            final fname = 'generated_${DateTime.now().millisecondsSinceEpoch}.jpg';
            final secureUrl = await storage.uploadChatImage(fileName: fname, bytes: bytes);
            if (secureUrl.isNotEmpty) displayImageUrl = secureUrl;
          } catch (_) {
            // If upload fails, keep dataUri as fallback (Firestore will store data URI, may be large but works for display)
          }
          final caption = 'Generated image for: "${result.prompt}"';
          await _chatService.saveAssistantMessage(
            conversationId: convId,
            content: caption,
            imageUrl: displayImageUrl,
          );
          state = state.copyWith(isSending: false);
          return;
        }

        // Normal text chat
        final aiResponse = await _aiService.chat(
          message: trimmed,
          conversationId: convId,
          imageUrl: null,
        );
        await _chatService.saveAssistantMessage(conversationId: convId, content: aiResponse);
        state = state.copyWith(isSending: false);
      } catch (e) {
        final raw = e.toString().replaceFirst('Exception: ', '');
        final friendly = _friendlyAiError(raw);
        // Avoid double-saving if we already saved fallback? Check if error was from analyze fallback
        // Just save friendly as assistant message for visibility
        try {
          await _chatService.saveAssistantMessage(conversationId: convId, content: friendly);
        } catch (_) {}
        state = state.copyWith(isSending: false, error: friendly);
        return;
      }
    } catch (e) {
      state = state.copyWith(isSending: false, error: _friendlyAiError(e.toString()));
    } finally {
      _sending = false;
    }
  }

  Future<void> regenerateLastResponse(String conversationId) async {
    if (_sending || state.isSending) return;
    _sending = true;
    state = state.copyWith(isSending: true, error: null);
    try {
      final recent = await _chatService.fetchRecentMessages(conversationId, limit: 20);
      if (recent.isEmpty) {
        state = state.copyWith(isSending: false, error: 'No messages to regenerate');
        return;
      }
      ChatMessage? lastUser;
      for (var i = recent.length - 1; i >= 0; i--) {
        if (recent[i].isUser) {
          lastUser = recent[i];
          break;
        }
      }
      if (lastUser == null) {
        state = state.copyWith(isSending: false, error: 'No user message found');
        return;
      }
      String aiResponse;
      try {
        // If last user had image, use analyze path
        if (lastUser.imageUrl != null && lastUser.imageUrl!.isNotEmpty) {
          try {
            aiResponse = await _aiService.analyzeImage(
              imageUrl: lastUser.imageUrl,
              prompt: lastUser.content,
              conversationId: conversationId,
            );
          } catch (e) {
            final lower = e.toString().toLowerCase();
            if (lower.contains('not configured') || lower.contains('unavailable')) {
              aiResponse = await _aiService.chat(
                message: lastUser.content,
                conversationId: conversationId,
                imageUrl: lastUser.imageUrl,
              );
            } else {
              rethrow;
            }
          }
        } else if (AiService.isImageGenerationRequest(lastUser.content)) {
          final genPrompt = AiService.extractGenerationPrompt(lastUser.content);
          final result = await _aiService.generateImage(
            prompt: genPrompt.isEmpty ? lastUser.content : genPrompt,
            conversationId: conversationId,
          );
          String displayImageUrl = result.dataUri;
          try {
            final bytes = base64Decode(result.base64);
            final storage = StorageService();
            final fname = 'generated_${DateTime.now().millisecondsSinceEpoch}.jpg';
            final secureUrl = await storage.uploadChatImage(fileName: fname, bytes: bytes);
            if (secureUrl.isNotEmpty) displayImageUrl = secureUrl;
          } catch (_) {}
          final caption = 'Generated image for: "${result.prompt}"';
          await _chatService.saveAssistantMessage(conversationId: conversationId, content: caption, imageUrl: displayImageUrl);
          state = state.copyWith(isSending: false);
          return;
        } else {
          aiResponse = await _aiService.chat(
            message: lastUser.content,
            conversationId: conversationId,
            imageUrl: lastUser.imageUrl,
          );
        }
      } catch (e) {
        final friendly = _friendlyAiError(e.toString().replaceFirst('Exception: ', ''));
        await _chatService.saveAssistantMessage(conversationId: conversationId, content: friendly);
        state = state.copyWith(isSending: false, error: friendly);
        return;
      }
      await _chatService.saveAssistantMessage(conversationId: conversationId, content: aiResponse);
      state = state.copyWith(isSending: false);
    } catch (e) {
      state = state.copyWith(isSending: false, error: _friendlyAiError(e.toString()));
    } finally {
      _sending = false;
    }
  }

  String _friendlyAiError(String raw) {
    final lower = raw.toLowerCase();
    // Preserve detailed Cloudflare/config errors for debugging (safe, no token)
    if (lower.contains('cloudflare') || lower.contains('missing cloudflare') || lower.contains('c_') || lower.contains('model not found') || lower.contains('model=')) {
      // Return the raw safe detail (truncate to 300 chars for UI)
      return raw.length > 300 ? '${raw.substring(0, 300)}...' : raw;
    }
    if (lower.contains('invalid or expired session') || lower.contains('session has expired') || lower.contains('unauthorized') || lower.contains('forbidden')) {
      return 'Your session has expired. Please sign in again.';
    }
    if (lower.contains('ai service busy') || lower.contains('rate limit') || lower.contains('too many requests') || lower.contains('429')) {
      return 'The AI service is busy. Please wait a moment and try again.';
    }
    if (lower.contains('timed out') || lower.contains('timeout') || lower.contains('504')) {
      return 'Request timed out. Please try again.';
    }
    if (lower.contains('invalid image') || lower.contains('unsupported image') || lower.contains('image too large') || lower.contains('cloudflare 400')) {
      // Pass through the detailed 400 but keep user-friendly prefix
      if (raw.length > 250) return 'Invalid image: ${raw.substring(0, 220)}...';
      return raw;
    }
    if (lower.contains('invalid prompt') || lower.contains('prompt too long') || lower.contains('prompt is required')) {
      return raw.length > 250 ? raw.substring(0, 250) : raw;
    }
    if (lower.contains('ai service not configured') || lower.contains('not configured')) {
      // Surface which var missing (safe)
      return raw.length > 300 ? raw.substring(0, 300) : raw;
    }
    if (lower.contains('ai provider') || lower.contains('failed to reach ai') || lower.contains('502') || lower.contains('503')) {
      // If raw already has Cloudflare details, keep it
      if (lower.contains('cloudflare')) return raw.length > 300 ? raw.substring(0, 300) : raw;
      return 'AI service is temporarily unavailable. Please try again. (${raw.length > 100 ? raw.substring(0, 100) : raw})';
    }
    // Fallback: if raw looks like a useful error (not empty, not generic html), show it
    if (raw.trim().isNotEmpty && raw.length < 400 && !lower.contains('exception:') && !lower.contains('unexpected response')) {
      return raw;
    }
    return 'AI service is temporarily unavailable. Please try again.';
  }

  Future<void> deleteConversation(String conversationId) async {
    await _chatService.deleteConversation(conversationId);
    final selected = _ref.read(selectedConversationIdProvider);
    if (selected == conversationId) {
      _ref.read(selectedConversationIdProvider.notifier).state = null;
    }
  }

  Future<void> renameConversation(String conversationId, String newTitle) async {
    await _chatService.updateTitle(conversationId, newTitle);
  }

  void startNewChat() {
    _ref.read(selectedConversationIdProvider.notifier).state = null;
    state = const ChatState();
  }

  void clearError() {
    state = state.copyWith(error: null);
  }
}

final chatNotifierProvider = StateNotifierProvider<ChatNotifier, ChatState>((ref) {
  return ChatNotifier(ref.watch(chatServiceProvider), ref.watch(aiServiceProvider), ref);
});
