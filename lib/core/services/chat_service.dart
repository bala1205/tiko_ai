import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../../models/chat_model.dart';
import '../../models/message_model.dart';

class ChatService {
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;
  final FirebaseAuth _auth = FirebaseAuth.instance;

  String get _uid {
    final uid = _auth.currentUser?.uid;
    if (uid == null) throw StateError('Not authenticated');
    return uid;
  }

  // Streams via Firestore snapshots
  Stream<List<Conversation>> watchConversations() {
    final uid = _auth.currentUser?.uid;
    if (uid == null) return Stream.value([]);
    return _firestore
        .collection('conversations')
        .where('userId', isEqualTo: uid)
        .orderBy('updatedAt', descending: true)
        .snapshots()
        .map((snap) => snap.docs.map((d) => Conversation.fromFirestore(d)).toList());
  }

  Stream<List<ChatMessage>> watchMessages(String conversationId) {
    return _firestore
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .orderBy('createdAt', descending: false)
        .snapshots()
        .map((snap) => snap.docs.map((d) => ChatMessage.fromFirestore(d)).toList());
  }

  // Fallback fetch once (non-realtime) for regenerate / context
  Future<List<ChatMessage>> fetchRecentMessages(String conversationId, {int limit = 30}) async {
    final snap = await _firestore
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .orderBy('createdAt', descending: true)
        .limit(limit)
        .get();
    final list = snap.docs.map((d) => ChatMessage.fromFirestore(d)).toList();
    return list.reversed.toList();
  }

  Future<List<ChatMessage>> fetchMessagesOnce(String conversationId, {int limit = 50}) async {
    final snap = await _firestore
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .orderBy('createdAt', descending: false)
        .limit(limit)
        .get();
    return snap.docs.map((d) => ChatMessage.fromFirestore(d)).toList();
  }

  String _generateTitle(String firstMessage) {
    final trimmed = firstMessage.trim();
    if (trimmed.length <= 45) return trimmed;
    return '${trimmed.substring(0, 45).trim()}...';
  }

  Future<String> ensureConversation({String? conversationId, required String firstUserMessage}) async {
    if (conversationId != null && conversationId.isNotEmpty) {
      final doc = await _firestore.collection('conversations').doc(conversationId).get();
      if (doc.exists && (doc.data()?['userId'] as String?) == _uid) {
        return conversationId;
      }
    }
    final title = _generateTitle(firstUserMessage);
    final docRef = _firestore.collection('conversations').doc();
    await docRef.set({
      'userId': _uid,
      'title': title,
      'lastMessagePreview': firstUserMessage.length > 80 ? '${firstUserMessage.substring(0, 80)}...' : firstUserMessage,
      'createdAt': FieldValue.serverTimestamp(),
      'updatedAt': FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  Future<void> sendUserMessage({
    required String conversationId,
    required String content,
    String? imageUrl,
  }) async {
    final trimmed = content.trim();
    if (trimmed.isEmpty && imageUrl == null) throw ArgumentError('Message is empty');
    final msgRef = _firestore.collection('conversations').doc(conversationId).collection('messages').doc();
    await msgRef.set({
      'role': MessageRole.user.name,
      'content': trimmed.isEmpty && imageUrl != null ? '[Image]' : trimmed,
      if (imageUrl != null) 'imageUrl': imageUrl,
      'createdAt': FieldValue.serverTimestamp(),
      'userId': _uid,
    });
    await _firestore.collection('conversations').doc(conversationId).update({
      'updatedAt': FieldValue.serverTimestamp(),
      'lastMessagePreview': trimmed.isEmpty && imageUrl != null
          ? '[Image]'
          : (trimmed.length > 80 ? '${trimmed.substring(0, 80)}...' : trimmed),
    });
  }

  Future<void> saveAssistantMessage({
    required String conversationId,
    required String content,
    String? imageUrl,
  }) async {
    final msgRef = _firestore.collection('conversations').doc(conversationId).collection('messages').doc();
    await msgRef.set({
      'role': MessageRole.assistant.name,
      'content': content,
      if (imageUrl != null && imageUrl.isNotEmpty) 'imageUrl': imageUrl,
      'createdAt': FieldValue.serverTimestamp(),
    });
    final preview = imageUrl != null && imageUrl.isNotEmpty
        ? (content.isNotEmpty ? '${content.substring(0, content.length > 40 ? 40 : content.length)} [Image]' : '[Generated Image]')
        : (content.length > 80 ? '${content.substring(0, 80)}...' : content);
    await _firestore.collection('conversations').doc(conversationId).update({
      'updatedAt': FieldValue.serverTimestamp(),
      'lastMessagePreview': preview,
    });
  }

  Future<void> updateTitle(String conversationId, String newTitle) async {
    final trimmed = newTitle.trim();
    if (trimmed.isEmpty) throw ArgumentError('Title cannot be empty');
    if (trimmed.length > 80) throw ArgumentError('Title too long');
    final doc = await _firestore.collection('conversations').doc(conversationId).get();
    if (!doc.exists || (doc.data()?['userId'] as String?) != _uid) {
      throw StateError('Conversation not found or access denied');
    }
    await _firestore.collection('conversations').doc(conversationId).update({'title': trimmed, 'updatedAt': FieldValue.serverTimestamp()});
  }

  Future<void> deleteConversation(String conversationId) async {
    final doc = await _firestore.collection('conversations').doc(conversationId).get();
    if (!doc.exists || (doc.data()?['userId'] as String?) != _uid) {
      throw StateError('Conversation not found or access denied');
    }
    // Delete messages subcollection first (batch)
    final messagesSnap = await _firestore.collection('conversations').doc(conversationId).collection('messages').get();
    final batch = _firestore.batch();
    for (final m in messagesSnap.docs) {
      batch.delete(m.reference);
    }
    batch.delete(_firestore.collection('conversations').doc(conversationId));
    await batch.commit();
  }
}
