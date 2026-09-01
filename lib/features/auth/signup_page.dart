import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/utils/validators.dart';
import 'auth_provider.dart';

class SignupPage extends ConsumerStatefulWidget {
  const SignupPage({super.key});

  @override
  ConsumerState<SignupPage> createState() => _SignupPageState();
}

class _SignupPageState extends ConsumerState<SignupPage> {
  final _formKey = GlobalKey<FormState>();
  final _nameCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  final _confirmCtrl = TextEditingController();
  bool _obscure = true;
  bool _obscure2 = true;

  @override
  void dispose() {
    _nameCtrl.dispose();
    _emailCtrl.dispose();
    _passCtrl.dispose();
    _confirmCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    // Guard: prevent duplicate submissions (UI-level) — provider also guards
    final state = ref.read(authNotifierProvider);
    if (state.isLoading || state.isCooldownActive) return;
    if (!_formKey.currentState!.validate()) return;
    final ok = await ref.read(authNotifierProvider.notifier).signUp(
          email: _emailCtrl.text,
          password: _passCtrl.text,
          displayName: _nameCtrl.text,
        );
    if (!mounted) return;
    if (ok) {
      // Check if email confirmation is required (mailer_autoconfirm=false)
      // Provider sets errorMessage to info; we have already shown SnackBar via listener.
      // Navigate back to login regardless — user will see confirmation message.
      if (Navigator.canPop(context)) {
        Navigator.pop(context);
        // Show success info on login page via SnackBar already set in provider state
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(authNotifierProvider);
    final isBusy = state.isLoading || state.isCooldownActive;

    ref.listen(authNotifierProvider, (prev, next) {
      // Show error/info whenever errorMessage changes and is not empty
      // Avoid duplicate SnackBar on same message
      if (next.errorMessage != null &&
          next.errorMessage!.isNotEmpty &&
          next.errorMessage != prev?.errorMessage) {
        final isRateLimit = next.isCooldownActive ||
            next.errorMessage!.toLowerCase().contains('too many') ||
            next.errorMessage!.toLowerCase().contains('wait');
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(next.errorMessage!),
            backgroundColor: isRateLimit
                ? Theme.of(context).colorScheme.error
                : next.errorMessage!.contains('Account created')
                    ? Theme.of(context).colorScheme.primary
                    : Theme.of(context).colorScheme.error,
            duration: Duration(seconds: isRateLimit ? 4 : 3),
          ),
        );
      }
    });

    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Create account')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(Icons.person_add_alt_1_rounded, size: 56, color: scheme.primary),
                  const SizedBox(height: 12),
                  Text('Join Tiko AI', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold), textAlign: TextAlign.center),
                  const SizedBox(height: 24),
                  if (state.isCooldownActive)
                    Container(
                      padding: const EdgeInsets.all(12),
                      margin: const EdgeInsets.only(bottom: 16),
                      decoration: BoxDecoration(
                        color: scheme.errorContainer,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: scheme.error.withOpacity(0.3)),
                      ),
                      child: Row(
                        children: [
                          Icon(Icons.hourglass_top_rounded, color: scheme.error, size: 20),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              'Too many attempts. Please wait ${state.cooldownSeconds}s before trying again.',
                              style: TextStyle(color: scheme.onErrorContainer, fontSize: 13, fontWeight: FontWeight.w500),
                            ),
                          ),
                        ],
                      ),
                    ),
                  TextFormField(
                    controller: _nameCtrl,
                    decoration: const InputDecoration(labelText: 'Display Name', prefixIcon: Icon(Icons.person_outline)),
                    validator: Validators.validateDisplayName,
                    enabled: !state.isLoading,
                    textInputAction: TextInputAction.next,
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _emailCtrl,
                    keyboardType: TextInputType.emailAddress,
                    decoration: const InputDecoration(labelText: 'Email', prefixIcon: Icon(Icons.email_outlined)),
                    validator: Validators.validateEmail,
                    enabled: !state.isLoading,
                    textInputAction: TextInputAction.next,
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _passCtrl,
                    obscureText: _obscure,
                    decoration: InputDecoration(
                      labelText: 'Password',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility), onPressed: () => setState(() => _obscure = !_obscure)),
                    ),
                    validator: Validators.validatePassword,
                    enabled: !state.isLoading,
                    textInputAction: TextInputAction.next,
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _confirmCtrl,
                    obscureText: _obscure2,
                    decoration: InputDecoration(
                      labelText: 'Confirm Password',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(icon: Icon(_obscure2 ? Icons.visibility_off : Icons.visibility), onPressed: () => setState(() => _obscure2 = !_obscure2)),
                    ),
                    validator: (v) => Validators.validateConfirmPassword(_passCtrl.text, v),
                    enabled: !state.isLoading,
                    onFieldSubmitted: (_) => _submit(),
                    textInputAction: TextInputAction.done,
                  ),
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: isBusy ? null : _submit,
                    child: state.isLoading
                        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : state.isCooldownActive
                            ? Text('Wait ${state.cooldownSeconds}s')
                            : const Text('Create Account'),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text('Already have an account?', style: TextStyle(color: scheme.onSurfaceVariant)),
                      TextButton(onPressed: isBusy ? null : () => Navigator.pop(context), child: const Text('Sign In')),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
