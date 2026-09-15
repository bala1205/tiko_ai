import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../../../models/message_model.dart';

class MessageBubble extends StatelessWidget {
  final ChatMessage message;
  final VoidCallback? onCopy;
  final VoidCallback? onRegenerate;
  const MessageBubble({super.key, required this.message, this.onCopy, this.onRegenerate});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final isUser = message.isUser;

    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 720),
        child: Container(
          margin: EdgeInsets.only(
            left: isUser ? 48 : 0,
            right: isUser ? 0 : 48,
            top: 8,
            bottom: 8,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            color: isUser ? scheme.primaryContainer : scheme.surfaceContainerHighest.withOpacity(0.7),
            borderRadius: BorderRadius.circular(18).copyWith(
              bottomRight: isUser ? const Radius.circular(4) : null,
              bottomLeft: !isUser ? const Radius.circular(4) : null,
            ),
            border: isUser ? null : Border.all(color: scheme.outlineVariant.withOpacity(0.4)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (!isUser)
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.smart_toy_rounded, size: 16, color: scheme.primary),
                    const SizedBox(width: 6),
                    Text('Tiko AI', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: scheme.primary)),
                  ],
                ),
              if (!isUser) const SizedBox(height: 6),
              if (message.imageUrl != null) ...[
                _ImageWithSave(imageUrl: message.imageUrl!),
                const SizedBox(height: 8),
              ],
              // Use selectable markdown for assistant, plain selectable text for user
              if (isUser)
                SelectableText(message.content, style: TextStyle(color: scheme.onPrimaryContainer, fontSize: 15, height: 1.5))
              else
                MarkdownBody(
                  data: message.content,
                  selectable: true,
                  styleSheet: MarkdownStyleSheet(
                    p: TextStyle(color: scheme.onSurface, fontSize: 15, height: 1.6),
                    h1: TextStyle(color: scheme.onSurface, fontWeight: FontWeight.bold, fontSize: 22),
                    h2: TextStyle(color: scheme.onSurface, fontWeight: FontWeight.bold, fontSize: 18),
                    h3: TextStyle(color: scheme.onSurface, fontWeight: FontWeight.w600, fontSize: 16),
                    listBullet: TextStyle(color: scheme.onSurface),
                    code: TextStyle(backgroundColor: scheme.surfaceContainerHighest, color: scheme.onSurface, fontFamily: 'monospace', fontSize: 13),
                    codeblockDecoration: BoxDecoration(
                      color: scheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: scheme.outlineVariant.withOpacity(0.5)),
                    ),
                    codeblockPadding: const EdgeInsets.all(12),
                    blockquoteDecoration: BoxDecoration(
                      color: scheme.primaryContainer.withOpacity(0.3),
                      border: Border(left: BorderSide(color: scheme.primary, width: 3)),
                    ),
                  ),
                  onTapLink: (text, href, title) {},
                ),
              const SizedBox(height: 6),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (!isUser) ...[
                    IconButton(
                      tooltip: 'Copy',
                      icon: const Icon(Icons.content_copy_rounded, size: 18),
                      onPressed: () {
                        Clipboard.setData(ClipboardData(text: message.content));
                        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied to clipboard')));
                        onCopy?.call();
                      },
                    ),
                    if (message.imageUrl != null)
                      IconButton(
                        tooltip: 'Save image',
                        icon: const Icon(Icons.download_rounded, size: 18),
                        onPressed: () => _handleSaveImage(context, message.imageUrl!),
                      ),
                    if (onRegenerate != null)
                      IconButton(
                        tooltip: 'Regenerate',
                        icon: const Icon(Icons.refresh_rounded, size: 18),
                        onPressed: onRegenerate,
                      ),
                  ] else ...[
                    IconButton(
                      tooltip: 'Copy',
                      icon: Icon(Icons.content_copy_rounded, size: 16, color: scheme.onPrimaryContainer.withOpacity(0.7)),
                      onPressed: () {
                        Clipboard.setData(ClipboardData(text: message.content));
                        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied to clipboard')));
                      },
                    ),
                    if (message.imageUrl != null)
                      IconButton(
                        tooltip: 'Copy image URL',
                        icon: Icon(Icons.link_rounded, size: 16, color: scheme.onPrimaryContainer.withOpacity(0.7)),
                        onPressed: () => _handleSaveImage(context, message.imageUrl!),
                      ),
                  ]
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

void _handleSaveImage(BuildContext context, String imageUrl) {
  // For data URIs and https URLs, copy URL and show hint.
  // On web, browser allows right-click Save; on mobile, user can long-press.
  Clipboard.setData(ClipboardData(text: imageUrl));
  final isDataUri = imageUrl.startsWith('data:image/');
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(isDataUri ? 'Image data copied. Paste in browser to save.' : 'Image URL copied. Open in browser to save.'),
      duration: const Duration(seconds: 2),
    ),
  );
  // On web, also try to trigger download for https URLs via anchor (best-effort)
  if (kIsWeb && !isDataUri) {
    // No url_launcher, just clipboard feedback is enough; user can right-click image.
  }
}

class _ImageWithSave extends StatelessWidget {
  final String imageUrl;
  const _ImageWithSave({required this.imageUrl});

  @override
  Widget build(BuildContext context) {
    // Data URI handling: render via memory, otherwise network
    if (imageUrl.startsWith('data:image/')) {
      try {
        final base64Part = imageUrl.split(',').length > 1 ? imageUrl.split(',')[1] : imageUrl;
        final bytes = base64Decode(base64Part);
        return ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: GestureDetector(
            onTap: () => _showFullImage(context, bytes, isDataUri: true),
            child: Image.memory(bytes, height: 220, fit: BoxFit.cover, width: double.infinity, errorBuilder: (_, __, ___) => const Icon(Icons.broken_image)),
          ),
        );
      } catch (_) {
        return const Icon(Icons.broken_image);
      }
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: GestureDetector(
        onTap: () => _showFullImageNetwork(context, imageUrl),
        child: Image.network(imageUrl, height: 220, fit: BoxFit.cover, width: double.infinity, errorBuilder: (_, __, ___) => const Icon(Icons.broken_image)),
      ),
    );
  }

  void _showFullImage(BuildContext context, Uint8List bytes, {required bool isDataUri}) {
    showDialog(
      context: context,
      builder: (_) => Dialog(
        insetPadding: const EdgeInsets.all(16),
        child: InteractiveViewer(
          child: Image.memory(bytes, fit: BoxFit.contain),
        ),
      ),
    );
  }

  void _showFullImageNetwork(BuildContext context, String url) {
    showDialog(
      context: context,
      builder: (_) => Dialog(
        insetPadding: const EdgeInsets.all(16),
        child: InteractiveViewer(
          child: Image.network(url, fit: BoxFit.contain, errorBuilder: (_, __, ___) => const Padding(padding: EdgeInsets.all(24), child: Text('Failed to load image'))),
        ),
      ),
    );
  }
}
