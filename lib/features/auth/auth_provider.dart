import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../../core/services/auth_service.dart';

final authServiceProvider = Provider<AuthService>((ref) => AuthService());

final authStateProvider = StreamProvider<User?>((ref) {
  final service = ref.watch(authServiceProvider);
  return service.authStateChanges();
});

class AuthFormState {
  final bool isLoading;
  final String? errorMessage;
  final int cooldownSeconds; // 0 means no cooldown
  const AuthFormState({
    this.isLoading = false,
    this.errorMessage,
    this.cooldownSeconds = 0,
  });
  bool get isCooldownActive => cooldownSeconds > 0;
  bool get isSubmitting => isLoading;
  AuthFormState copyWith({
    bool? isLoading,
    String? errorMessage,
    int? cooldownSeconds,
    bool clearError = false,
  }) {
    return AuthFormState(
      isLoading: isLoading ?? this.isLoading,
      errorMessage: clearError ? null : (errorMessage ?? this.errorMessage),
      cooldownSeconds: cooldownSeconds ?? this.cooldownSeconds,
    );
  }
}

class AuthNotifier extends StateNotifier<AuthFormState> {
  final AuthService _service;
  Timer? _cooldownTimer;

  AuthNotifier(this._service) : super(const AuthFormState());

  @override
  void dispose() {
    _cooldownTimer?.cancel();
    super.dispose();
  }

  void _startCooldown(int seconds) {
    _cooldownTimer?.cancel();
    state = state.copyWith(cooldownSeconds: seconds, clearError: false);
    _cooldownTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      final remaining = state.cooldownSeconds - 1;
      if (remaining <= 0) {
        t.cancel();
        state = state.copyWith(cooldownSeconds: 0);
      } else {
        state = state.copyWith(cooldownSeconds: remaining);
      }
    });
  }

  bool _isRateLimitError(FirebaseAuthException e) {
    final code = e.code.toLowerCase();
    final msg = (e.message ?? '').toLowerCase();
    return code.contains('too-many-requests') ||
        code.contains('429') ||
        msg.contains('too many requests') ||
        msg.contains('rate limit') ||
        msg.contains('429');
  }

  Future<bool> signUp({
    required String email,
    required String password,
    required String displayName,
  }) async {
    // Guard: only one active request
    if (state.isLoading) return false;
    if (state.isCooldownActive) {
      state = state.copyWith(
        errorMessage: 'Please wait ${state.cooldownSeconds}s before trying again.',
      );
      return false;
    }
    state = state.copyWith(isLoading: true, clearError: true, cooldownSeconds: 0);
    _cooldownTimer?.cancel();
    try {
      await _service.signUp(email: email, password: password, displayName: displayName);
      state = state.copyWith(isLoading: false, clearError: true);
      return true;
    } on FirebaseAuthException catch (e) {
      if (_isRateLimitError(e)) {
        _startCooldown(60);
        state = state.copyWith(
          isLoading: false,
          errorMessage: 'Too many signup attempts were made. Please wait a few minutes before trying again.',
        );
        return false;
      }
      state = state.copyWith(isLoading: false, errorMessage: _friendly(e));
      return false;
    } catch (e) {
      state = state.copyWith(isLoading: false, errorMessage: e.toString());
      return false;
    } finally {
      if (state.isLoading) {
        state = state.copyWith(isLoading: false);
      }
    }
  }

  Future<bool> signIn({required String email, required String password}) async {
    if (state.isLoading) return false;
    if (state.isCooldownActive) {
      state = state.copyWith(
        errorMessage: 'Please wait ${state.cooldownSeconds}s before trying again.',
      );
      return false;
    }
    state = state.copyWith(isLoading: true, clearError: true);
    try {
      await _service.signIn(email: email, password: password);
      state = state.copyWith(isLoading: false, clearError: true);
      return true;
    } on FirebaseAuthException catch (e) {
      if (_isRateLimitError(e)) {
        _startCooldown(30);
        state = state.copyWith(
          isLoading: false,
          errorMessage: 'Too many sign-in attempts. Please wait a moment and try again.',
        );
        return false;
      }
      state = state.copyWith(isLoading: false, errorMessage: _friendly(e));
      return false;
    } catch (e) {
      state = state.copyWith(isLoading: false, errorMessage: e.toString());
      return false;
    } finally {
      if (state.isLoading) state = state.copyWith(isLoading: false);
    }
  }

  Future<void> signOut() async {
    await _service.signOut();
  }

  void clearError() {
    state = state.copyWith(clearError: true);
  }

  void clearCooldown() {
    _cooldownTimer?.cancel();
    state = state.copyWith(cooldownSeconds: 0, clearError: true);
  }

  String _friendly(FirebaseAuthException e) {
    final code = e.code;
    final msg = (e.message ?? '').toLowerCase();
    if (code == 'invalid-email' || msg.contains('invalid email') || code == 'invalid-credential' || msg.contains('invalid credential') || msg.contains('invalid login')) {
      return 'Invalid email or password.';
    }
    if (code == 'user-disabled') return 'This account has been disabled.';
    if (code == 'user-not-found' || code == 'wrong-password' || code == 'invalid-credential') {
      return 'Invalid email or password.';
    }
    if (code == 'email-already-in-use' || msg.contains('already in use') || msg.contains('already registered') || msg.contains('already exists')) {
      return 'An account with this email already exists. Try signing in.';
    }
    if (code == 'weak-password' || msg.contains('weak password') || msg.contains('password should be at least')) {
      return 'Password is too weak. Use at least 6 characters.';
    }
    if (code == 'too-many-requests' || msg.contains('too many requests') || msg.contains('rate limit')) {
      return 'Too many attempts. Please wait a moment and try again.';
    }
    if (code == 'network-request-failed' || msg.contains('network') || msg.contains('failed to fetch') || msg.contains('socket')) {
      return 'Unable to connect. Check your internet connection and try again.';
    }
    if (e.message != null && e.message!.isNotEmpty) {
      return e.message!;
    }
    return 'Something went wrong. Please try again.';
  }
}

final authNotifierProvider = StateNotifierProvider<AuthNotifier, AuthFormState>((ref) {
  return AuthNotifier(ref.watch(authServiceProvider));
});
