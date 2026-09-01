import 'package:cloud_firestore/cloud_firestore.dart';

class Conversation {
  final String id;
  final String userId;
  final String title;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final String? lastMessagePreview;

  const Conversation({
    required this.id,
    required this.userId,
    required this.title,
    this.createdAt,
    this.updatedAt,
    this.lastMessagePreview,
  });

  factory Conversation.fromFirestore(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return Conversation(
      id: doc.id,
      userId: data['userId'] as String? ?? data['user_id'] as String? ?? '',
      title: data['title'] as String? ?? 'New Chat',
      createdAt: _parseDate(data['createdAt'] ?? data['created_at']),
      updatedAt: _parseDate(data['updatedAt'] ?? data['updated_at']),
      lastMessagePreview: data['lastMessagePreview'] as String? ?? data['last_message_preview'] as String?,
    );
  }

  factory Conversation.fromMap(Map<String, dynamic> data, String id) {
    return Conversation(
      id: id,
      userId: data['userId'] as String? ?? data['user_id'] as String? ?? '',
      title: data['title'] as String? ?? 'New Chat',
      createdAt: _parseDate(data['createdAt'] ?? data['created_at']),
      updatedAt: _parseDate(data['updatedAt'] ?? data['updated_at']),
      lastMessagePreview: data['lastMessagePreview'] as String? ?? data['last_message_preview'] as String?,
    );
  }

  factory Conversation.fromSupabase(Map<String, dynamic> data) {
    return Conversation(
      id: data['id'] as String? ?? '',
      userId: data['user_id'] as String? ?? data['userId'] as String? ?? '',
      title: data['title'] as String? ?? 'New Chat',
      createdAt: data['created_at'] != null ? DateTime.tryParse(data['created_at'].toString()) : null,
      updatedAt: data['updated_at'] != null ? DateTime.tryParse(data['updated_at'].toString()) : null,
      lastMessagePreview: data['last_message_preview'] as String? ?? data['lastMessagePreview'] as String?,
    );
  }

  Map<String, dynamic> toFirestore() {
    return {
      'userId': userId,
      'title': title,
      'lastMessagePreview': lastMessagePreview,
      'updatedAt': FieldValue.serverTimestamp(),
      'createdAt': FieldValue.serverTimestamp(),
    };
  }

  Map<String, dynamic> toSupabase() {
    return {
      'user_id': userId,
      'title': title,
      'last_message_preview': lastMessagePreview,
    };
  }

  Conversation copyWith({
    String? title,
    String? lastMessagePreview,
    DateTime? updatedAt,
  }) {
    return Conversation(
      id: id,
      userId: userId,
      title: title ?? this.title,
      createdAt: createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      lastMessagePreview: lastMessagePreview ?? this.lastMessagePreview,
    );
  }

  static DateTime? _parseDate(dynamic value) {
    if (value == null) return null;
    if (value is Timestamp) return value.toDate();
    if (value is DateTime) return value;
    if (value is String) return DateTime.tryParse(value);
    return null;
  }
}
