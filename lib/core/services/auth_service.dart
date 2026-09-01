import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../../models/user_model.dart';

class AuthService {
  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;

  Stream<User?> authStateChanges() => _auth.authStateChanges();

  User? get currentUser => _auth.currentUser;

  /// Single responsibility signup — calls Firebase exactly once, no retry.
  /// Creates Firestore user profile document.
  Future<UserCredential> signUp({
    required String email,
    required String password,
    required String displayName,
  }) async {
    final credential = await _auth.createUserWithEmailAndPassword(
      email: email.trim(),
      password: password,
    );
    final user = credential.user;
    if (user != null) {
      // Update displayName in Firebase Auth
      try {
        await user.updateDisplayName(displayName.trim());
      } catch (_) {}
      // Create Firestore user profile
      try {
        await _firestore.collection('users').doc(user.uid).set({
          'email': email.trim(),
          'displayName': displayName.trim(),
          'createdAt': FieldValue.serverTimestamp(),
          'updatedAt': FieldValue.serverTimestamp(),
        }, SetOptions(merge: true));
      } catch (_) {
        // Non-fatal, user still created
      }
    }
    return credential;
  }

  Future<UserCredential> signIn({
    required String email,
    required String password,
  }) async {
    final credential = await _auth.signInWithEmailAndPassword(
      email: email.trim(),
      password: password,
    );
    // Update last login
    try {
      final uid = credential.user?.uid;
      if (uid != null) {
        await _firestore.collection('users').doc(uid).set({
          'lastLoginAt': FieldValue.serverTimestamp(),
          'updatedAt': FieldValue.serverTimestamp(),
        }, SetOptions(merge: true));
      }
    } catch (_) {}
    return credential;
  }

  Future<void> signOut() => _auth.signOut();

  Future<UserProfile?> fetchProfile(String uid) async {
    try {
      final doc = await _firestore.collection('users').doc(uid).get();
      if (!doc.exists) return null;
      return UserProfile.fromFirestore(doc);
    } catch (_) {
      return null;
    }
  }
}
