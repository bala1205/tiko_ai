import 'dart:convert';
import 'dart:typed_data';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import '../config/worker_config.dart';

class GeneratedImageResult {
  final String dataUri;
  final String base64;
  final String prompt;
  final String model;
  final String mime;
  const GeneratedImageResult({
    required this.dataUri,
    required this.base64,
    required this.prompt,
    required this.model,
    required this.mime,
  });
}

class AiService {
  final FirebaseAuth _auth = FirebaseAuth.instance;
  final http.Client _client;

  AiService({http.Client? client}) : _client = client ?? http.Client();

  Future<String> _getIdToken() async {
    final user = _auth.currentUser;
    if (user == null) throw Exception('You must be signed in to chat.');
    final idToken = await user.getIdToken(true);
    if (idToken == null || idToken.isEmpty) throw Exception('Failed to get authentication token. Please sign in again.');
    return idToken;
  }

  Map<String, dynamic> _parseJson(http.Response response) {
    try {
      return jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      if (response.statusCode == 401) throw Exception('Your session has expired. Please sign in again.');
      if (response.statusCode == 429) throw Exception('AI service is busy. Please try again in a moment.');
      if (response.statusCode >= 500) throw Exception('AI service is temporarily unavailable. Please try again.');
      throw Exception('Unexpected response from AI service (${response.statusCode})');
    }
  }

  void _throwForStatus(int status, Map<String, dynamic> data) {
    final errMsg = data['error'] is String ? data['error'] as String : 'AI service error ($status)';
    if (status == 401 || status == 403) throw Exception('Your session has expired. Please sign in again.');
    if (status == 429) throw Exception('AI service is busy. Please try again in a moment.');
    if (status == 504) throw Exception('Request timed out. Please try again.');
    throw Exception(errMsg);
  }

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
    final idToken = await _getIdToken();
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

    final data = _parseJson(response);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (data['response'] is String && (data['response'] as String).isNotEmpty) {
        return data['response'] as String;
      }
      if (data['message'] is Map && (data['message'] as Map)['content'] is String) {
        final c = (data['message'] as Map)['content'] as String;
        if (c.isNotEmpty) return c;
      }
      if (data['error'] is String) throw Exception(data['error']);
      throw Exception('Unexpected response from AI service: $data');
    } else {
      _throwForStatus(response.statusCode, data);
      throw Exception('AI service error');
    }
  }

  /// Image analysis via Cloudflare Workers AI (vision model).
  /// Secure: image is sent to backend which proxies to Cloudflare REST with secret token.
  /// Supports both base64 bytes and imageUrl (backend will fetch URL if needed).
  /// Returns natural-language description/analysis.
  Future<String> analyzeImage({
    Uint8List? imageBytes,
    String? fileName,
    String? imageUrl,
    String? prompt,
    required String conversationId,
  }) async {
    if ((imageBytes == null || imageBytes.isEmpty) && (imageUrl == null || imageUrl.isEmpty)) {
      throw Exception('Image is required for analysis');
    }
    if (imageBytes != null && imageBytes.length > 10 * 1024 * 1024) {
      throw Exception('Image too large (max 10MB)');
    }

    final idToken = await _getIdToken();
    final uri = Uri.parse(WorkerConfig.analyzeImageEndpoint);
    final headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': 'Bearer $idToken',
    };

    // Build payload: prefer base64 if bytes provided, else imageUrl
    Map<String, dynamic> payload = {
      'conversationId': conversationId,
      if (prompt != null && prompt.trim().isNotEmpty) 'prompt': prompt.trim(),
      if (prompt != null && prompt.trim().isNotEmpty) 'question': prompt.trim(),
    };

    if (imageBytes != null && imageBytes.isNotEmpty) {
      // Validate MIME from filename
      final ext = fileName?.contains('.') == true ? fileName!.split('.').last.toLowerCase() : 'jpg';
      final mime = _mimeFromExt(ext);
      final b64 = base64Encode(imageBytes);
      // Send as data URI to match backend expectation, but also support raw base64
      payload['imageBase64'] = 'data:$mime;base64,$b64';
      // Also include mime hint
      payload['mime'] = mime;
    } else if (imageUrl != null && imageUrl.isNotEmpty) {
      payload['imageUrl'] = imageUrl;
    }

    http.Response response;
    try {
      response = await _client
          .post(uri, headers: headers, body: jsonEncode(payload))
          .timeout(const Duration(seconds: 45));
    } on http.ClientException catch (e) {
      throw Exception('Failed to reach AI service: ${e.message}');
    } catch (e) {
      final lower = e.toString().toLowerCase();
      if (lower.contains('timeout') || lower.contains('timed out')) {
        throw Exception('Request timed out. Please try again.');
      }
      rethrow;
    }

    final data = _parseJson(response);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      // Expected: { success:true, type:"image_analysis", text:"...", response:"..." }
      if (data['text'] is String && (data['text'] as String).isNotEmpty) return data['text'] as String;
      if (data['response'] is String && (data['response'] as String).isNotEmpty) return data['response'] as String;
      if (data['answer'] is String && (data['answer'] as String).isNotEmpty) return data['answer'] as String;
      throw Exception('Unexpected response from AI service: $data');
    } else {
      _throwForStatus(response.statusCode, data);
      throw Exception('AI service error');
    }
  }

  /// Image generation via Cloudflare Workers AI (flux-1-schnell).
  /// Returns GeneratedImageResult with dataUri ready for display via Image.memory / Image.network.
  Future<GeneratedImageResult> generateImage({
    required String prompt,
    required String conversationId,
    int? steps,
    int? seed,
  }) async {
    final trimmed = prompt.trim();
    if (trimmed.isEmpty) throw Exception('Prompt is required for image generation');
    if (trimmed.length > 2048) throw Exception('Prompt too long (max 2048 chars)');

    final idToken = await _getIdToken();
    final uri = Uri.parse(WorkerConfig.generateImageEndpoint);
    final headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': 'Bearer $idToken',
    };
    final body = jsonEncode({
      'prompt': trimmed,
      'conversationId': conversationId,
      if (steps != null) 'steps': steps,
      if (seed != null) 'seed': seed,
    });

    http.Response response;
    try {
      response = await _client
          .post(uri, headers: headers, body: body)
          .timeout(const Duration(seconds: 60));
    } on http.ClientException catch (e) {
      throw Exception('Failed to reach AI service: ${e.message}');
    } catch (e) {
      final lower = e.toString().toLowerCase();
      if (lower.contains('timeout') || lower.contains('timed out')) {
        throw Exception('Request timed out. Please try again.');
      }
      rethrow;
    }

    final data = _parseJson(response);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      // Expected: { success:true, type:"image_generation", dataUri:"data:image/jpeg;base64,...", imageBase64:"...", prompt:"...", model:"..." }
      String? dataUri = data['dataUri'] as String? ?? data['imageBase64'] as String? ?? data['image'] as String?;
      // Also handle nested result?
      if (dataUri == null && data['result'] is Map) {
        final r = data['result'] as Map;
        dataUri = r['dataUri'] as String? ?? r['image'] as String?;
      }
      if (dataUri == null || dataUri.isEmpty) throw Exception('Image generation returned empty image');
      // Ensure dataUri has prefix
      String finalDataUri = dataUri;
      String base64 = dataUri;
      String mime = (data['mime'] as String?) ?? 'image/jpeg';
      String model = (data['model'] as String?) ?? 'flux-1-schnell';

      if (dataUri.startsWith('data:image/')) {
        base64 = dataUri.split(',').length > 1 ? dataUri.split(',')[1] : dataUri;
        final mimeMatch = RegExp(r'data:([^;]+);').firstMatch(dataUri);
        if (mimeMatch != null) mime = mimeMatch.group(1) ?? mime;
      } else {
        // raw base64
        base64 = dataUri;
        finalDataUri = 'data:$mime;base64,$base64';
      }

      // Validate base64 length
      if (base64.length < 100) throw Exception('Image generation returned invalid image');

      return GeneratedImageResult(
        dataUri: finalDataUri,
        base64: base64,
        prompt: data['prompt'] as String? ?? trimmed,
        model: model,
        mime: mime,
      );
    } else {
      _throwForStatus(response.statusCode, data);
      throw Exception('AI service error');
    }
  }

  /// Detects if user message is an image generation request.
  /// Used by ChatProvider to route to generateImage instead of chat.
  static bool isImageGenerationRequest(String text) {
    final lower = text.toLowerCase().trim();
    if (lower.isEmpty) return false;
    // Explicit patterns
    final patterns = [
      RegExp(r'\bgenerate\b.*\bimage\b'),
      RegExp(r'\bcreate\b.*\bimage\b'),
      RegExp(r'\bdraw\b.*'),
      RegExp(r'\bmake\b.*\bimage\b'),
      RegExp(r'\bgenerate\s+an?\s+image\b'),
      RegExp(r'\bgenerate\s+image\b'),
      RegExp(r'\bcreate\s+an?\s+image\b'),
      RegExp(r'\btext\s*to\s*image\b'),
      RegExp(r'\bimagine\b'),
      RegExp(r'\bpaint\b.*\bimage\b'),
      RegExp(r'\brender\b.*\bimage\b'),
      RegExp(r'\bfuturistic.*city.*sunset'), // example from spec, but generic catch via generate?
    ];
    for (final p in patterns) {
      if (p.hasMatch(lower)) return true;
    }
    // Heuristic: starts with "generate image" or "create image"
    if (lower.startsWith('generate image') || lower.startsWith('create image') || lower.startsWith('draw ')) return true;
    // If contains "generate" + "image" anywhere, even separated
    if (lower.contains('generate') && lower.contains('image')) return true;
    return false;
  }

  static String extractGenerationPrompt(String text) {
    // Remove common prefixes to isolate the actual prompt
    String t = text.trim();
    // Strip leading instruction phrases
    final prefixes = [
      RegExp(r'^\s*generate\s+(an?\s+)?image\s+of\s*', caseSensitive: false),
      RegExp(r'^\s*generate\s+(an?\s+)?image\s*:\s*', caseSensitive: false),
      RegExp(r'^\s*create\s+(an?\s+)?image\s+of\s*', caseSensitive: false),
      RegExp(r'^\s*create\s+(an?\s+)?image\s*:\s*', caseSensitive: false),
      RegExp(r'^\s*draw\s+', caseSensitive: false),
      RegExp(r'^\s*make\s+(an?\s+)?image\s+of\s*', caseSensitive: false),
      RegExp(r'^\s*imagine\s+', caseSensitive: false),
    ];
    for (final re in prefixes) {
      if (re.hasMatch(t)) {
        t = t.replaceFirst(re, '').trim();
        break;
      }
    }
    if (t.isEmpty) t = text.trim();
    return t;
  }

  String _mimeFromExt(String ext) {
    switch (ext) {
      case 'png':
        return 'image/png';
      case 'webp':
        return 'image/webp';
      case 'heic':
      case 'heif':
        return 'image/heic';
      case 'gif':
        return 'image/gif';
      default:
        return 'image/jpeg';
    }
  }
}
