import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';
import '../config/cloudinary_config.dart';

class StorageService {
  final _uuid = const Uuid();

  /// Uploads chat image to Cloudinary via unsigned upload preset.
  /// Returns secure_url.
  /// Throws with clear instruction if Cloudinary is not configured.
  Future<String> uploadChatImage({
    required String fileName,
    Uint8List? bytes,
    String? contentType,
    String? conversationId,
  }) async {
    if (!CloudinaryConfig.isConfigured) {
      throw StateError(
        'Cloudinary not configured. Please set CloudinaryConfig.cloudName and create an unsigned upload preset '
        '"${CloudinaryConfig.uploadPreset}" in Cloudinary Console: '
        'https://console.cloudinary.com/app/c-7360394f66758067f42774046c03ba/settings/upload '
        '-> Upload presets -> Add upload preset (Unsigned). Then set cloudName to your Cloudinary cloud name.',
      );
    }
    if (bytes == null || bytes.isEmpty) {
      throw ArgumentError('bytes must be provided');
    }
    // ext used for mime detection if needed; Cloudinary infers content type
    final ext = fileName.contains('.') ? fileName.split('.').last.toLowerCase() : 'jpg';
    // ignore: unused_local_variable
    final effectiveMime = contentType ?? _mimeFromExt(ext);

    final uri = Uri.parse(CloudinaryConfig.uploadUrl);
    final request = http.MultipartRequest('POST', uri)
      ..fields['upload_preset'] = CloudinaryConfig.uploadPreset
      ..fields['folder'] = CloudinaryConfig.folder
      ..fields['public_id'] = _uuid.v4()
      ..files.add(http.MultipartFile.fromBytes('file', bytes, filename: fileName));

    // Cloudinary will infer content type; we don't need to set header manually for multipart

    final streamed = await request.send();
    final response = await http.Response.fromStream(streamed);
    if (response.statusCode != 200 && response.statusCode != 201) {
      throw Exception('Cloudinary upload failed (${response.statusCode}): ${response.body}');
    }
    final json = jsonDecode(response.body) as Map<String, dynamic>;
    final secureUrl = json['secure_url'] as String?;
    if (secureUrl == null || secureUrl.isEmpty) {
      throw Exception('Cloudinary upload succeeded but no secure_url returned: ${response.body}');
    }
    return secureUrl;
  }

  bool get isImageAnalysisSupported => true;

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
