import 'package:cloud_firestore/cloud_firestore.dart';

class UserProfile {
  final String uid;
  final String email;
  final String displayName;
  final DateTime? createdAt;
  final DateTime? lastLoginAt;

  const UserProfile({
    required this.uid,
    required this.email,
    required this.displayName,
    this.createdAt,
    this.lastLoginAt,
  });

  factory UserProfile.fromFirestore(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return UserProfile(
      uid: doc.id,
      email: data['email'] as String? ?? '',
      displayName: data['displayName'] as String? ?? data['display_name'] as String? ?? '',
      createdAt: _parseDate(data['createdAt'] ?? data['created_at']),
      lastLoginAt: _parseDate(data['lastLoginAt'] ?? data['updatedAt'] ?? data['updated_at']),
    );
  }

  factory UserProfile.fromMap(Map<String, dynamic> data, String uid) {
    return UserProfile(
      uid: uid,
      email: data['email'] as String? ?? '',
      displayName: data['displayName'] as String? ?? data['display_name'] as String? ?? '',
      createdAt: _parseDate(data['createdAt'] ?? data['created_at']),
      lastLoginAt: _parseDate(data['lastLoginAt'] ?? data['updatedAt'] ?? data['updated_at']),
    );
  }

  // Legacy Supabase factory kept for historical compatibility (not used at runtime)
  factory UserProfile.fromSupabase(Map<String, dynamic> data) {
    return UserProfile(
      uid: data['id'] as String? ?? '',
      email: data['email'] as String? ?? '',
      displayName: data['display_name'] as String? ?? data['displayName'] as String? ?? '',
      createdAt: data['created_at'] != null ? DateTime.tryParse(data['created_at'].toString()) : null,
      lastLoginAt: data['updated_at'] != null ? DateTime.tryParse(data['updated_at'].toString()) : null,
    );
  }

  Map<String, dynamic> toFirestore() {
    return {
      'email': email,
      'displayName': displayName,
      'createdAt': createdAt != null ? Timestamp.fromDate(createdAt!) : FieldValue.serverTimestamp(),
      'updatedAt': FieldValue.serverTimestamp(),
    };
  }

  Map<String, dynamic> toSupabase() {
    return {
      'id': uid,
      'email': email,
      'display_name': displayName,
    };
  }

  UserProfile copyWith({
    String? displayName,
    String? email,
    DateTime? lastLoginAt,
  }) {
    return UserProfile(
      uid: uid,
      email: email ?? this.email,
      displayName: displayName ?? this.displayName,
      createdAt: createdAt,
      lastLoginAt: lastLoginAt ?? this.lastLoginAt,
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
