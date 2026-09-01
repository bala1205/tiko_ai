import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

class ChatInput extends StatefulWidget {
  final Future<void> Function(String text, {String? imageUrl, Uint8List? imageBytes, String? imageName}) onSend;
  final bool isSending;
  final bool imageSupported;
  const ChatInput({super.key, required this.onSend, required this.isSending, this.imageSupported = false});

  @override
  State<ChatInput> createState() => _ChatInputState();
}

class _ChatInputState extends State<ChatInput> {
  final _controller = TextEditingController();
  final _focusNode = FocusNode();
  Uint8List? _pickedBytes;
  String? _pickedName;
  // ignore: unused_field
  bool _uploading = false;

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  Future<void> _pickImage() async {
    // Allow image picking always; Cloudinary upload works regardless of AI vision support.
    // Vision support (kimi-k3) is not verified, but imageUrl will still be saved in Firestore.
    final picker = ImagePicker();
    final picked = await picker.pickImage(source: ImageSource.gallery, imageQuality: 75, maxWidth: 1024);
    if (picked != null) {
      final bytes = await picked.readAsBytes();
      setState(() {
        _pickedBytes = bytes;
        _pickedName = picked.name;
      });
    }
  }

  Future<void> _submit() async {
    final text = _controller.text.trim();
    if (text.isEmpty && _pickedBytes == null) return;
    if (widget.isSending || _uploading) return;
    final bytes = _pickedBytes;
    final name = _pickedName;
    _controller.clear();
    setState(() {
      _pickedBytes = null;
      _pickedName = null;
    });
    // For now, if image is picked but not supported, just send text
    // If supported in future, upload happens inside widget or via provider with StorageService
    await widget.onSend(text, imageBytes: bytes, imageName: name);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      decoration: BoxDecoration(
        color: Theme.of(context).scaffoldBackgroundColor,
        border: Border(top: BorderSide(color: scheme.outlineVariant.withOpacity(0.5))),
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 800),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_pickedBytes != null)
                Container(
                  margin: const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(color: scheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(12)),
                  child: Row(
                    children: [
                      ClipRRect(borderRadius: BorderRadius.circular(8), child: Image.memory(_pickedBytes!, width: 56, height: 56, fit: BoxFit.cover)),
                      const SizedBox(width: 12),
                      Expanded(child: Text(_pickedName ?? 'image', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13))),
                      IconButton(icon: const Icon(Icons.close_rounded), onPressed: () => setState(() { _pickedBytes = null; _pickedName = null; })),
                    ],
                  ),
                ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  IconButton(
                    tooltip: 'Attach image (stored via Cloudinary)',
                    icon: Icon(Icons.attach_file_rounded, color: scheme.primary),
                    onPressed: _pickImage,
                  ),
                  Expanded(
                    child: TextField(
                      controller: _controller,
                      focusNode: _focusNode,
                      minLines: 1,
                      maxLines: 5,
                      textCapitalization: TextCapitalization.sentences,
                      textInputAction: TextInputAction.send,
                      decoration: InputDecoration(
                        hintText: 'Message Tiko AI...',
                        filled: true,
                        fillColor: scheme.surface,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide(color: scheme.outlineVariant)),
                      ),
                      onSubmitted: (_) => _submit(),
                      enabled: !widget.isSending,
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: widget.isSending ? null : _submit,
                    style: FilledButton.styleFrom(shape: const CircleBorder(), padding: const EdgeInsets.all(14), minimumSize: const Size(48, 48)),
                    child: widget.isSending
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.send_rounded, size: 20),
                  ),
                ],
              ),
              const SizedBox(height: 2),
            ],
          ),
        ),
      ),
    );
  }
}
