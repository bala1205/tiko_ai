import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/constants/app_constants.dart';
import '../../core/services/storage_service.dart';
import 'chat_provider.dart';
import 'widgets/chat_input.dart';
import 'widgets/message_bubble.dart';
import 'widgets/sidebar.dart';
import 'widgets/typing_indicator.dart';

class ChatPage extends ConsumerStatefulWidget {
  const ChatPage({super.key});
  @override
  ConsumerState<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends ConsumerState<ChatPage> {
  final _scrollCtrl = ScrollController();

  @override
  void dispose() {
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(_scrollCtrl.position.maxScrollExtent, duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
      }
    });
  }

  Future<void> _handleSend(String text, {String? imageUrl, Uint8List? imageBytes, String? imageName}) async {
    // Cloudinary upload: wait for valid secure_url, then send SAME url to Worker vision model
    if (imageBytes != null && imageName != null) {
      final storage = StorageService();
      try {
        final secureUrl = await storage.uploadChatImage(fileName: imageName, bytes: imageBytes);
        if (secureUrl.isEmpty) throw Exception('Cloudinary returned empty secure_url');
        imageUrl = secureUrl;
      } catch (e) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Image upload failed: $e')));
        return;
      }
    }
    // Ensure we never send a null/empty imageUrl when an image was selected — verification for Worker contract
    if (imageBytes != null && (imageUrl == null || imageUrl.isEmpty)) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Image upload did not return a URL. Please try again.')));
      return;
    }
    await ref.read(chatNotifierProvider.notifier).sendMessage(text, imageUrl: imageUrl);
    _scrollToBottom();
  }

  @override
  Widget build(BuildContext context) {
    final selectedId = ref.watch(selectedConversationIdProvider);
    final chatState = ref.watch(chatNotifierProvider);
    final isWide = MediaQuery.of(context).size.width >= AppConstants.mobileBreakpoint;

    ref.listen(chatNotifierProvider, (prev, next) {
      if (next.error != null && next.error!.isNotEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(next.error!), backgroundColor: Theme.of(context).colorScheme.error));
        ref.read(chatNotifierProvider.notifier).clearError();
      }
    });

    // Auto-scroll on new messages
    ref.listen(messagesProvider(selectedId ?? ''), (prev, next) {
      _scrollToBottom();
    });

    final messagesAsync = selectedId == null ? null : ref.watch(messagesProvider(selectedId));

    Widget chatArea = Column(
      children: [
        Expanded(
          child: selectedId == null
              ? _EmptyState(onSuggestionTap: (s) => _handleSend(s))
              : messagesAsync!.when(
                  data: (messages) {
                    if (messages.isEmpty && !chatState.isSending) {
                      return _EmptyState(onSuggestionTap: (s) => _handleSend(s));
                    }
                    return ListView.builder(
                      controller: _scrollCtrl,
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                      itemCount: messages.length + (chatState.isSending ? 1 : 0),
                      itemBuilder: (context, index) {
                        if (index < messages.length) {
                          final msg = messages[index];
                          return MessageBubble(
                            message: msg,
                            onRegenerate: msg.isAssistant
                                ? () => ref.read(chatNotifierProvider.notifier).regenerateLastResponse(selectedId)
                                : null,
                          );
                        } else {
                          return const Align(alignment: Alignment.centerLeft, child: Padding(padding: EdgeInsets.symmetric(vertical: 8), child: TypingIndicator()));
                        }
                      },
                    );
                  },
                  loading: () => const Center(child: CircularProgressIndicator()),
                  error: (e, _) => Center(child: Text('Failed to load messages: $e')),
                ),
        ),
        ChatInput(
          onSend: _handleSend,
          isSending: chatState.isSending,
          // Allow image picking always; vision support is false (kimi-k3), but Cloudinary upload still works.
          imageSupported: true,
        ),
      ],
    );

    if (isWide) {
      return Scaffold(
        body: Row(
          children: [
            const ChatSidebar(),
            Expanded(child: chatArea),
          ],
        ),
      );
    } else {
      return Scaffold(
        appBar: AppBar(
          title: const Row(children: [Icon(Icons.smart_toy_rounded), SizedBox(width: 8), Text('Tiko AI')]),
        ),
        drawer: const Drawer(child: ChatSidebar()),
        body: chatArea,
      );
    }
  }
}

class _EmptyState extends StatelessWidget {
  final void Function(String) onSuggestionTap;
  const _EmptyState({required this.onSuggestionTap});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 600),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(color: scheme.primaryContainer, shape: BoxShape.circle),
                child: Icon(Icons.smart_toy_rounded, size: 48, color: scheme.onPrimaryContainer),
              ),
              const SizedBox(height: 20),
              Text("Hello, I'm Tiko AI", style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Text('How can I help you today?', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 16)),
              const SizedBox(height: 32),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                alignment: WrapAlignment.center,
                children: [
                  _Chip(label: 'Explain a concept', icon: Icons.lightbulb_outline, onTap: () => onSuggestionTap('Explain quantum computing in simple terms')),
                  _Chip(label: 'Help me write code', icon: Icons.code_rounded, onTap: () => onSuggestionTap('Help me write a Flutter function to fetch data from an API')),
                  _Chip(label: 'Summarize something', icon: Icons.summarize_outlined, onTap: () => onSuggestionTap('Summarize the key ideas of clean architecture')),
                  _Chip(label: 'Give me ideas', icon: Icons.auto_awesome_outlined, onTap: () => onSuggestionTap('Give me creative ideas for a productivity app')),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  final String label;
  final IconData icon;
  final VoidCallback onTap;
  const _Chip({required this.label, required this.icon, required this.onTap});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ActionChip(
      avatar: Icon(icon, size: 18, color: scheme.primary),
      label: Text(label),
      onPressed: onTap,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24), side: BorderSide(color: scheme.outlineVariant)),
      backgroundColor: scheme.surface,
    );
  }
}
