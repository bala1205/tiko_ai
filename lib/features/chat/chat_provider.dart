import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/services/ai_service.dart';
import '../../core/services/chat_service.dart';
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

  Future<void> sendMessage(String text, {String? imageUrl}) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty && imageUrl == null) return;
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

      await _chatService.sendUserMessage(
        conversationId: convId,
        content: trimmed.isEmpty ? '[Image]' : trimmed,
        imageUrl: imageUrl,
      );

      String aiResponse;
      try {
        aiResponse = await _aiService.chat(
          message: trimmed,
          conversationId: convId,
          imageUrl: imageUrl,
        );
      } catch (e) {
        final raw = e.toString().replaceFirst('Exception: ', '');
        final friendly = _friendlyAiError(raw);
        aiResponse = friendly;
        await _chatService.saveAssistantMessage(conversationId: convId, content: aiResponse);
        state = state.copyWith(isSending: false, error: friendly);
        return;
      }

      await _chatService.saveAssistantMessage(conversationId: convId, content: aiResponse);
      state = state.copyWith(isSending: false);
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
        aiResponse = await _aiService.chat(
          message: lastUser.content,
          conversationId: conversationId,
          imageUrl: lastUser.imageUrl,
        );
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
    if (lower.contains('ai service not configured') || lower.contains('not configured')) {
      return 'AI service is temporarily unavailable. Please try again later.';
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
    if (lower.contains('ai provider') || lower.contains('ai service unavailable') || lower.contains('failed to reach ai') || lower.contains('unavailable') || lower.contains('502') || lower.contains('503')) {
      return 'AI service is temporarily unavailable. Please try again.';
    }
    // Fallback: do not expose raw backend details
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
