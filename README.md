# Tiko AI

**Tiko AI** — Modern AI Chat Assistant (Flutter Android + Web, Supabase, NVIDIA NIM)

A ChatGPT-style AI chat experience built with **one Flutter codebase** for Android and Web. Backend proxies securely to **NVIDIA Integrate API (`moonshotai/kimi-k3`)** via **Supabase Edge Functions**. No Firebase required.

## Architecture

```
Flutter Android / Web (supabase_flutter)
        │
        ├── Supabase Auth (email/password) ──┐
        │                                    │
        └── Supabase Database (Postgres) ─────┤
                     │                       │
                     └───────┬───────────────┘
                             │
                             ▼
                Supabase Edge Function: chat-with-ai (Deno, verify_jwt=true)
                             │
                             │ Bearer NVIDIA_API_KEY (secret, never in client)
                             ▼
               https://integrate.api.nvidia.com/v1/chat/completions
                             │
                             ▼
                      moonshotai/kimi-k3
                             │
                             ▼
                        AI Response → Flutter Chat UI
```

- No NVIDIA key in Flutter, DB, or client constants.
- No artificial daily limits — only provider/Supabase limits + duplicate-send guard.
- Supabase project: `egnfsrrgdlhrdnzkykaw` (https://egnfsrrgdlhrdnzkykaw.supabase.co, Oceania Sydney)

## Prerequisites

- Flutter 3.22+ / Dart 3.12+ (tested 3.44.5)
- Supabase CLI `npm i -g supabase` + `supabase login --token <PAT>`
- Access to Supabase project `egnfsrrgdlhrdnzkykaw`
- NVIDIA API key from https://build.nvidia.com (Integrate/NIM)

## Install

```bash
flutter pub get
```

## Supabase Configuration

`lib/core/config/supabase_config.dart`:

```dart
static const url = 'https://egnfsrrgdlhrdnzkykaw.supabase.co';
static const anonKey = 'eyJhbG...'; // anon JWT (client-safe)
 // alternatively sb_publishable_e7-Omu3...
```

These are publishable/anon keys (client-safe). Do NOT put `service_role` or `NVIDIA_API_KEY` in Flutter.

Supabase linked:

```bash
supabase link --project-ref egnfsrrgdlhrdnzkykaw
```

## Database — Migrations

Tables created via `supabase/migrations/`:

```
profiles (id uuid PK → auth.users, email, display_name, created_at, updated_at)
  trigger handle_new_user() on auth.users insert → auto-create profile

conversations (id uuid PK, user_id → auth.users, title, created_at, updated_at, last_message_preview)
  indexes: (user_id, updated_at desc), (user_id)

messages (id uuid PK, conversation_id → conversations, role check, content, image_url, created_at)
  indexes: (conversation_id, created_at)
```

Apply:

```bash
supabase db push --linked
```

RLS enabled on all three. Policies use `auth.uid()` only — no client userId trust.

## Storage

Bucket: `chat-images` (private, false)

Path: `{userId}/{conversationId}/{uuid}.{ext}`

Policies on `storage.objects` where `bucket_id='chat-images'` and `(storage.foldername(name))[1] = auth.uid()::text` (select/insert/update/delete).

Migrated via `supabase/migrations/20250831000002_storage.sql`.

## Edge Function — chat-with-ai

`supabase/functions/chat-with-ai/index.ts` (Deno, supabase-js 2.45.4)

- CORS + OPTIONS handled
- Requires `Authorization: Bearer <Supabase JWT>` — `supabase.auth.getUser(jwt)` verifies
- Validates `message` (or `messages` array), `conversationId`, `imageUrl`
- Verifies `conversations.user_id == auth.uid()` (403 if not)
- Loads last 30 messages for context, builds `[system + history + user]`
- Calls NVIDIA `Bearer NVIDIA_API_KEY` (from `Deno.env.get`), timeout 60s, handles 401/429/5xx/timeout safely, never logs key.

Deploy:

```bash
supabase functions deploy chat-with-ai
# verify
supabase functions list
```

### NVIDIA Secret

Never commit key. Set as Edge Function secret:

```bash
supabase secrets set NVIDIA_API_KEY=YOUR_NEW_NVIDIA_API_KEY
supabase secrets list
```

Current placeholder is `YOUR_NEW_NVIDIA_API_KEY` — replace with newly generated key (do NOT reuse old exposed key). After `secrets set`, no redeploy needed.

## Run

```bash
flutter run                 # Android
flutter run -d chrome       # Web
```

## Build

```bash
flutter build apk --debug
flutter build apk
flutter build web
flutter build web --no-wasm-dry-run   # if wasm dry run fails
```

Artifacts: `build/app/outputs/flutter-apk/app-debug.apk`, `build/web/`

## Supabase Auth Flow

```dart
supabase.auth.signUp(email, password, data:{display_name})
supabase.auth.signInWithPassword(email, password)
supabase.auth.signOut()
supabase.auth.onAuthStateChange → StreamProvider<User?>
```

Session persists via `supabase_flutter` (SharedPreferences). No manual password storage.

## Flutter Services (Migrated)

```
lib/core/services/auth_service.dart     → supabase.auth
lib/core/services/chat_service.dart     → supabase.from('conversations'/'messages').stream() + insert/update/delete + RLS
lib/core/services/ai_service.dart       → supabase.functions.invoke('chat-with-ai', {message, conversationId, imageUrl})
lib/core/services/storage_service.dart  → supabase.storage.from('chat-images').uploadBinary() path {uid}/{conv}/{uuid}
lib/core/config/supabase_config.dart    → URL + anonKey
lib/models/*                            → fromSupabase/toSupabase (no Firestore Timestamp)
```

No `cloud_functions`, `firebase_*` in `pubspec.yaml`. `lib/firebase_options.dart` kept as comment-only reference, not imported.

## Image Upload

- Picker: `image_picker` maxWidth 1024, quality 75
- Bucket `chat-images` private, RLS path-based.
- `StorageService.isImageAnalysisSupported = false` — `moonshotai/kimi-k3` vision unverified at NVIDIA endpoint, so edge function logs & ignores `imageUrl` to avoid invalid multimodal payload. Upload still works for future use; enable by verifying docs and switching to multimodal `{type:"image_url"}` and setting flag true.

## Model Configuration

Backend single source: `MODEL_NAME` in `supabase/functions/chat-with-ai/index.ts`. Replace and redeploy to swap without Flutter change.

Example NVIDIA payload:

```json
{"model":"moonshotai/kimi-k3","messages":[{"role":"system","content":"..."}, {"role":"user","content":"Hello"}],"temperature":0.7,"max_tokens":2048,"stream":false}
```

## Streaming

Edge function is non-streaming with typing indicator. No fake streaming. True streaming would need SSE; kept reliable non-streaming.

## Troubleshooting

- `flutter build web` wasm dry run failure (255) → use `--no-wasm-dry-run` or ignore, `flutter build web` still succeeds after `flutter clean`.
- APK `kotlin incremental caches` D: vs C: pub-cache → `android/gradle.properties` has `kotlin.incremental=false`.
- `flutter analyze` 16 infos (withOpacity deprecation) — 0 errors.
- Supabase CLI config parse error → keep `supabase/config.toml` minimal (only `project_id` + `[functions.chat-with-ai]`).

## Validation

- `flutter pub get` ✅ (removed 16 Firebase packages, added supabase_flutter)
- `flutter analyze` ✅ 16 infos 0 errors
- `flutter build web --no-wasm-dry-run` ✅ (58.6s, build/web)
- `flutter build apk --debug` ✅ (263s, app-debug.apk)
- `supabase db push --linked` ✅ (2 migrations applied)
- `supabase functions deploy chat-with-ai` ✅ (ACTIVE v3)
- `supabase secrets list` ✅ (NVIDIA_API_KEY digest present)
- `curl` unauthenticated → 401 Missing auth, anon JWT → 401 Invalid session (RLS correct)
- No Firebase required at runtime (`lib/firebase_options.dart` not imported)

## Migration Summary

Firebase → Supabase mapping:
- Firebase Auth → Supabase Auth (GoTrue)
- Firestore users/conversations/messages → Postgres profiles/conversations/messages + RLS + triggers
- Firebase Storage `users/{uid}/chat_images` → Supabase Storage `chat-images` bucket `{uid}/{conv}/{uuid}`
- Firebase Functions `chatWithAI` callable → Supabase Edge Function `chat-with-ai` (Deno, verify_jwt, Deno.env NVIDIA_API_KEY)
- `firebase_core` init → `Supabase.initialize(url, anonKey)`
