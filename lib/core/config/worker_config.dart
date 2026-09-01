library;

/// Cloudflare Worker configuration for Tiko AI.
///
/// The Worker handles NVIDIA proxy with Firebase Auth verification.
/// Flutter must send Firebase ID token via Authorization header.
/// No secrets are stored in Flutter.
///
/// Set the Worker URL via:
///
///   flutter run --dart-define=WORKER_URL=https://tiko-ai-worker.your-subdomain.workers.dev
///   flutter build web --dart-define=WORKER_URL=...
///   flutter build apk --dart-define=WORKER_URL=...
///
/// Or edit the default below after deploying:
///
///   wrangler deploy  ->  note the workers.dev URL
///   update [WorkerConfig.defaultWorkerUrl]
///
/// For local dev with `wrangler dev`, use http://localhost:8787

class WorkerConfig {
  /// Default Worker URL (replace after `wrangler deploy`).
  /// Deployed 2026-09-01 to 45bffd31e733e40c05acdfef61152dd1:
  /// https://tiko-ai-worker.tiko-worker.workers.dev
  static const String defaultWorkerUrl = String.fromEnvironment(
    'WORKER_URL',
    defaultValue: 'https://tiko-ai-worker.tiko-worker.workers.dev',
  );

  /// Active Worker endpoint. Supports /chat path.
  static String get workerUrl => defaultWorkerUrl;

  /// Full chat endpoint (POST).
  /// Worker index.ts handles POST /chat and POST /.
  static String get chatEndpoint => '$workerUrl/chat';

  /// Whether a custom URL has been provided (not the placeholder dev default).
  static bool get isConfigured => workerUrl.isNotEmpty && workerUrl.startsWith('https://');

  /// Health endpoint for verifying deployment.
  static String get healthEndpoint => '$workerUrl/health';
}
