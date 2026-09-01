library;

/// Cloudinary configuration for chat image uploads.
///
/// IMPORTANT SECURITY: Never put Cloudinary API_SECRET inside Flutter.
/// Use unsigned upload preset (Option A) for client-side uploads.
///
/// How to configure:
/// 1. Go to https://console.cloudinary.com/app/c-7360394f66758067f42774046c03ba/home/dashboard
/// 2. Note your Cloud Name (Dashboard -> top left, e.g. "dxxxxxxx")
/// 3. Create an unsigned upload preset:
///    Settings -> Upload -> Upload presets -> Add upload preset
///    - Signing Mode: Unsigned
///    - Folder: tiko/chat_images (optional)
///    - Access Mode: public
///    - Name: tiko_unsigned (or any name, then update below)
/// 4. Set the values below.
/// 5. No API secret needed in Flutter.
///
/// Alternative (Option B): Use Firebase Cloud Function to generate signed uploads.
/// For now, Option A (unsigned preset) is implemented as requested.

class CloudinaryConfig {
  static const String cloudName = 'neg9ajqw';
  static const String uploadPreset = 'tiko_unsigned';
  static const String folder = 'tiko/chat_images';

  static bool get isConfigured =>
      cloudName.isNotEmpty &&
      cloudName != 'REPLACE_WITH_CLOUD_NAME' &&
      uploadPreset.isNotEmpty;

  static String get uploadUrl =>
      'https://api.cloudinary.com/v1_1/$cloudName/image/upload';
}
