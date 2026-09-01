class AppConstants {
  static const String appName = 'Tiko AI';
  static const String appTagline = 'Your intelligent assistant';

  // Firestore collections
  static const String usersCollection = 'users';
  static const String conversationsCollection = 'conversations';
  static const String messagesSubcollection = 'messages';

  // Limits
  static const int maxTitleLength = 80;
  static const int maxMessageLength = 10000;
  static const int maxContextMessages = 30;

  // UI
  static const double sidebarWidth = 280;
  static const double maxChatWidth = 800;
  static const double mobileBreakpoint = 700;
  static const double tabletBreakpoint = 1100;

  // System prompt (client-visible default - backend is authoritative)
  static const String defaultSystemPrompt =
      'You are Tiko AI, a helpful, accurate, and friendly AI assistant. '
      'Provide clear and concise answers. Use Markdown formatting when useful. '
      'Explain technical topics in an understandable way. Be supportive and engaging.';
}
