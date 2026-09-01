import 'dart:convert';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import '../config/worker_config.dart';

class AiService {
  final FirebaseAuth _auth = FirebaseAuth.instance;
  final http.Client _client;

  AiService({http.Client? client}) : _client = client ?? http.Client();

  /// Calls Cloudflare Worker AI endpoint.
  /// Replaces Firebase Callable Function.
  ///
  /// Flow:
  ///  - Get Firebase ID token (verified server-side)
  ///  - POST to Worker /chat with `Authorization: Bearer` token
  ///  - Worker verifies ownership, loads 30 history, calls NVIDIA (primary 30s + fallback 30s)
  ///  - Returns assistant text (never empty)
  Future<String> chat({
    required String message,
    required String conversationId,
    String? imageUrl,
  }) async {
    final user = _auth.currentUser;
    if (user == null) {
      throw Exception('You must be signed in to chat.');
    }

    // Force refresh if token is near expiry; getIdToken handles caching
    final idToken = await user.getIdToken(true);
    if (idToken == null || idToken.isEmpty) {
      throw Exception('Failed to get authentication token. Please sign in again.');
    }

    final uri = Uri.parse(WorkerConfig.chatEndpoint);
    final headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': 'Bearer $idToken',
    };
    // Ensure imageUrl is the SAME Cloudinary secure_url saved in Firestore; never null when image selected
    final body = jsonEncode({
      'message': message,
      'conversationId': conversationId,
      if (imageUrl != null && imageUrl.isNotEmpty) 'imageUrl': imageUrl,
    });

    http.Response response;
    try {
      response = await _client
          .post(uri, headers: headers, body: body)
          .timeout(const Duration(seconds: 65));
    } on http.ClientException catch (e) {
      throw Exception('Failed to reach AI service: ${e.message}');
    } catch (e) {
      final lower = e.toString().toLowerCase();
      if (lower.contains('timeout') || lower.contains('timed out')) {
        throw Exception('Request timed out. Please try again.');
      }
      rethrow;
    }

    // Parse response
    Map<String, dynamic> data;
    try {
      data = jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      if (response.statusCode == 401) {
        throw Exception('Your session has expired. Please sign in again.');
      }
      if (response.statusCode == 429) {
        throw Exception('AI service is busy. Please try again in a moment.');
      }
      if (response.statusCode >= 500) {
        throw Exception('AI service is temporarily unavailable. Please try again.');
      }
      throw Exception('Unexpected response from AI service (${response.statusCode})');
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (data['response'] is String && (data['response'] as String).isNotEmpty) {
        return data['response'] as String;
      }
      if (data['message'] is Map && (data['message'] as Map)['content'] is String) {
        final c = (data['message'] as Map)['content'] as String;
        if (c.isNotEmpty) return c;
      }
      if (data['error'] is String) {
        throw Exception(data['error']);
      }
      throw Exception('Unexpected response from AI service: $data');
    } else {
      // Error status: map to friendly message but preserve code for provider
      final errMsg = data['error'] is String ? data['error'] as String : 'AI service error (${response.statusCode})';
      // Map common statuses to the same strings ChatNotifier expects
      if (response.statusCode == 401 || response.statusCode == 403) {
        throw Exception('Your session has expired. Please sign in again.');
      }
      if (response.statusCode == 429) {
        throw Exception('AI service is busy. Please try again in a moment.');
      }
      if (response.statusCode == 504) {
        throw Exception('Request timed out. Please try again.');
      }
      throw Exception(errMsg);
    }
  }
}
