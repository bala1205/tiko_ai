import 'package:cloud_firestore/cloud_firestore.dart';

enum MessageRole { user, assistant, system }

extension MessageRoleX on MessageRole {
  String get name => toString().split('.').last;
  static MessageRole fromString(String s) {
    switch (s) {
      case 'assistant':
        return MessageRole.assistant;
      case 'system':
        return MessageRole.system;
      default:
        return MessageRole.user;
    }
  }
}

enum MessageStatus { sending, sent, error, streaming }

class ChatMessage {
  final String id;
  final MessageRole role;
  final String content;
  final String? imageUrl;
  final DateTime? createdAt;
  final MessageStatus status;

  const ChatMessage({
    required this.id,
    required this.role,
    required this.content,
    this.imageUrl,
    this.createdAt,
    this.status = MessageStatus.sent,
  });

  factory ChatMessage.fromFirestore(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return ChatMessage(
      id: doc.id,
      role: MessageRoleX.fromString(data['role'] as String? ?? 'user'),
      content: data['content'] as String? ?? '',
      imageUrl: data['imageUrl'] as String? ?? data['image_url'] as String?,
      createdAt: _parseDate(data['createdAt'] ?? data['created_at']),
      status: MessageStatus.sent,
    );
  }

  factory ChatMessage.fromMap(Map<String, dynamic> data, String id) {
    return ChatMessage(
      id: id,
      role: MessageRoleX.fromString(data['role'] as String? ?? 'user'),
      content: data['content'] as String? ?? '',
      imageUrl: data['imageUrl'] as String? ?? data['image_url'] as String?,
      createdAt: _parseDate(data['createdAt'] ?? data['created_at']),
      status: MessageStatus.sent,
    );
  }

  factory ChatMessage.fromSupabase(Map<String, dynamic> data) {
    return ChatMessage(
      id: data['id'] as String? ?? '',
      role: MessageRoleX.fromString(data['role'] as String? ?? 'user'),
      content: data['content'] as String? ?? '',
      imageUrl: data['image_url'] as String? ?? data['imageUrl'] as String?,
      createdAt: data['created_at'] != null ? DateTime.tryParse(data['created_at'].toString()) : null,
      status: MessageStatus.sent,
    );
  }

  Map<String, dynamic> toFirestore() {
    return {
      'role': role.name,
      'content': content,
      if (imageUrl != null) 'imageUrl': imageUrl,
      'createdAt': FieldValue.serverTimestamp(),
    };
  }

  Map<String, dynamic> toSupabase() {
    return {
      'role': role.name,
      'content': content,
      if (imageUrl != null) 'image_url': imageUrl,
    };
  }

  ChatMessage copyWith({
    String? content,
    String? imageUrl,
    MessageStatus? status,
    DateTime? createdAt,
  }) {
    return ChatMessage(
      id: id,
      role: role,
      content: content ?? this.content,
      imageUrl: imageUrl ?? this.imageUrl,
      createdAt: createdAt ?? this.createdAt,
      status: status ?? this.status,
    );
  }

  bool get isUser => role == MessageRole.user;
  bool get isAssistant => role == MessageRole.assistant;

  static DateTime? _parseDate(dynamic value) {
    if (value == null) return null;
    if (value is Timestamp) return value.toDate();
    if (value is DateTime) return value;
    if (value is String) return DateTime.tryParse(value);
    return null;
  }
}
