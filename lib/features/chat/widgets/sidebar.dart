import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/constants/app_constants.dart';
import '../chat_provider.dart';
import '../../auth/auth_provider.dart';

class ChatSidebar extends ConsumerWidget {
  final VoidCallback? onClose;
  const ChatSidebar({super.key, this.onClose});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conversationsAsync = ref.watch(conversationsProvider);
    final selectedId = ref.watch(selectedConversationIdProvider);
    final scheme = Theme.of(context).colorScheme;

    return Container(
      width: AppConstants.sidebarWidth,
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(right: BorderSide(color: scheme.outlineVariant.withOpacity(0.5))),
      ),
      child: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Header — below status bar / notch via SafeArea
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: Row(
                children: [
                  Icon(Icons.smart_toy_rounded, color: scheme.primary, size: 28),
                  const SizedBox(width: 10),
                  Text('Tiko AI', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: scheme.onSurface)),
                  const Spacer(),
                  if (onClose != null) IconButton(icon: const Icon(Icons.close_rounded), onPressed: onClose),
                ],
              ),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: FilledButton.icon(
              onPressed: () {
                ref.read(chatNotifierProvider.notifier).startNewChat();
                onClose?.call();
              },
              icon: const Icon(Icons.add_rounded),
              label: const Text('New Chat'),
            ),
          ),
          const Divider(height: 1),
          // Conversations list
          Expanded(
            child: conversationsAsync.when(
              data: (conversations) {
                if (conversations.isEmpty) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Text('No conversations yet.\nStart a new chat!', textAlign: TextAlign.center, style: TextStyle(color: scheme.onSurfaceVariant)),
                    ),
                  );
                }
                return ListView.builder(
                  itemCount: conversations.length,
                  itemBuilder: (context, index) {
                    final conv = conversations[index];
                    final isSelected = conv.id == selectedId;
                    return Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      child: Material(
                        color: isSelected ? scheme.primaryContainer : Colors.transparent,
                        borderRadius: BorderRadius.circular(12),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(12),
                          onTap: () {
                            ref.read(selectedConversationIdProvider.notifier).state = conv.id;
                            onClose?.call();
                          },
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                            child: Row(
                              children: [
                                Icon(Icons.chat_bubble_outline_rounded, size: 18, color: isSelected ? scheme.onPrimaryContainer : scheme.onSurfaceVariant),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(conv.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: isSelected ? FontWeight.w600 : FontWeight.w500, fontSize: 14, color: isSelected ? scheme.onPrimaryContainer : scheme.onSurface)),
                                      if (conv.lastMessagePreview != null && conv.lastMessagePreview!.isNotEmpty)
                                        Text(conv.lastMessagePreview!, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
                                    ],
                                  ),
                                ),
                                PopupMenuButton<String>(
                                  icon: Icon(Icons.more_horiz_rounded, size: 18, color: scheme.onSurfaceVariant),
                                  onSelected: (value) async {
                                    if (value == 'rename') {
                                      final ctrl = TextEditingController(text: conv.title);
                                      final newTitle = await showDialog<String>(
                                        context: context,
                                        builder: (ctx) => AlertDialog(
                                          title: const Text('Rename chat'),
                                          content: TextField(controller: ctrl, autofocus: true, maxLength: AppConstants.maxTitleLength, decoration: const InputDecoration(hintText: 'Title')),
                                          actions: [
                                            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
                                            FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('Save')),
                                          ],
                                        ),
                                      );
                                      if (newTitle != null && newTitle.isNotEmpty && newTitle != conv.title) {
                                        try {
                                          await ref.read(chatNotifierProvider.notifier).renameConversation(conv.id, newTitle);
                                        } catch (e) {
                                          if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
                                        }
                                      }
                                    } else if (value == 'delete') {
                                      final confirm = await showDialog<bool>(
                                        context: context,
                                        builder: (ctx) => AlertDialog(
                                          title: const Text('Delete conversation?'),
                                          content: const Text('This will permanently delete the conversation and its messages.'),
                                          actions: [
                                            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
                                            FilledButton(style: FilledButton.styleFrom(backgroundColor: scheme.error), onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
                                          ],
                                        ),
                                      );
                                      if (confirm == true) {
                                        try {
                                          await ref.read(chatNotifierProvider.notifier).deleteConversation(conv.id);
                                        } catch (e) {
                                          if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
                                        }
                                      }
                                    }
                                  },
                                  itemBuilder: (ctx) => const [
                                    PopupMenuItem(value: 'rename', child: Row(children: [Icon(Icons.edit_outlined, size: 18), SizedBox(width: 8), Text('Rename')])),
                                    PopupMenuItem(value: 'delete', child: Row(children: [Icon(Icons.delete_outline, size: 18), SizedBox(width: 8), Text('Delete')])),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    );
                  },
                );
              },
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => Center(child: Padding(padding: const EdgeInsets.all(16), child: Text('Failed to load chats: $e'))),
            ),
          ),
          const Divider(height: 1),
          // Footer - user
          Consumer(builder: (context, ref, _) {
            final user = ref.watch(authStateProvider).value;
            return Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  CircleAvatar(backgroundColor: scheme.primaryContainer, child: Text((user?.email ?? 'U')[0].toUpperCase(), style: TextStyle(color: scheme.onPrimaryContainer))),
                  const SizedBox(width: 10),
                  Expanded(child: Text(user?.email ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13))),
                  IconButton(
                    tooltip: 'Sign out',
                    icon: const Icon(Icons.logout_rounded),
                    onPressed: () async {
                      await ref.read(authNotifierProvider.notifier).signOut();
                    },
                  ),
                ],
              ),
            );
          }),
        ],
      ),
      ),
    );
  }
}
