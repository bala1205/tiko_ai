export interface VerifiedToken {
  uid: string;
  email?: string;
}

const GOOGLE_CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let cachedCerts: { certs: Record<string, string>; expiresAt: number } | null = null;

// -- base64url helpers --
function b64UrlDecode(input: string): Uint8Array {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64UrlDecodeString(input: string): string {
  return new TextDecoder().decode(b64UrlDecode(input));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN CERTIFICATE-----/, "").replace(/-----END CERTIFICATE-----/, "").replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getGoogleCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && now < cachedCerts.expiresAt) return cachedCerts.certs;
  const res = await fetch(GOOGLE_CERTS_URL, { cf: { cacheTtl: 3600 } } as any);
  if (!res.ok) throw new Error(`Failed to fetch Google certs: ${res.status}`);
  const certs = (await res.json()) as Record<string, string>;
  // parse cache-control max-age if present
  const cc = res.headers.get("cache-control") ?? "";
  let maxAge = 3600;
  const m = cc.match(/max-age=(\d+)/);
  if (m) maxAge = parseInt(m[1], 10);
  cachedCerts = { certs, expiresAt: now + maxAge * 1000 * 0.9 };
  return certs;
}

async function verifyRs256Signature(
  signingInput: string,
  signatureB64Url: string,
  certPem: string,
): Promise<boolean> {
  // Primary: use Node crypto (available with nodejs_compat) — handles X509 PEM directly
  try {
    // @ts-ignore - node:crypto available with nodejs_compat
    const mod: any = await import("node:crypto");
    const createVerify = mod.createVerify as (algo: string) => { update: (d: string) => void; end: () => void; verify: (key: string, sig: Uint8Array) => boolean };
    if (createVerify) {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(signingInput);
      verifier.end();
      const sigBytes = b64UrlDecode(signatureB64Url);
      return verifier.verify(certPem, sigBytes);
    }
  } catch (e) {
    // fall through to WebCrypto
  }

  const sigBytes = b64UrlDecode(signatureB64Url);
  const certBuffer = pemToArrayBuffer(certPem);
  const subtle = (globalThis as any).crypto?.subtle as SubtleCrypto | undefined;
  if (!subtle) throw new Error("SubtleCrypto not available");
  const key = await subtle.importKey(
    "spki",
    await extractSpkiFromCert(certBuffer),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(signingInput);
  return await subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes as unknown as BufferSource, data as unknown as BufferSource);
}

// Minimal ASN.1 parsing to extract SPKI from X509 (subjectPublicKeyInfo)
// This is needed because Google certs are X509, not raw SPKI.
async function extractSpkiFromCert(certDer: ArrayBuffer): Promise<ArrayBuffer> {
  // Try direct import assuming certDer is already SPKI (fallback)
  // If cert parsing fails, attempt to locate SPKI inside X509
  // X509 structure: SEQUENCE { tbsCertificate SEQUENCE { ... subjectPublicKeyInfo SEQUENCE } ... }
  // Instead of full ASN.1, we search for RSA OID 1.2.840.113549.1.1.1 (06 09 2A 86 48 86 F7 0D 01 01 01)
  // The SPKI starts at SEQUENCE tag before OID
  try {
    const bytes = new Uint8Array(certDer);
    // Quick check: if first bytes look like SPKI SEQUENCE (0x30)
    // Attempt to see if it can be imported directly as spki – if it is already SPKI it will succeed.
    // But we can't test without trying, so we try heuristic:
    // Look for OID RSA encryption
    const oid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
    let idx = -1;
    for (let i = 0; i < bytes.length - oid.length; i++) {
      let match = true;
      for (let j = 0; j < oid.length; j++) if (bytes[i + j] !== oid[j]) { match = false; break; }
      if (match) { idx = i; break; }
    }
    if (idx !== -1) {
      // SPKI SEQUENCE starts a few bytes before OID.
      // Search backwards for SEQUENCE tag 0x30
      // SPKI = SEQUENCE { SEQUENCE { OID, NULL } BIT STRING }
      // Heuristic: find 0x30 before idx that encloses the structure
      for (let start = idx - 20; start >= 0; start--) {
        if (bytes[start] === 0x30) {
          // Try to parse length
          let spkiLen = bytes[start + 1];
          let headerLen = 2;
          if (spkiLen & 0x80) {
            const num = spkiLen & 0x7f;
            if (start + 2 + num > bytes.length) continue;
            spkiLen = 0;
            for (let k = 0; k < num; k++) spkiLen = (spkiLen << 8) | bytes[start + 2 + k];
            headerLen = 2 + num;
            spkiLen += headerLen;
          } else {
            spkiLen += 2;
          }
          if (start + spkiLen <= bytes.length && start + spkiLen > idx) {
            // candidate – try import
            const candidate = bytes.slice(start, start + spkiLen).buffer as ArrayBuffer;
            try {
              const subtle = (globalThis as any).crypto.subtle as SubtleCrypto;
              await subtle.importKey("spki", candidate, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
              return candidate;
            } catch (_) {
              continue;
            }
          }
        }
      }
    }
  } catch (_) {
    // fall through
  }
  // If extraction fails, return original (will cause import to fail and we fallback to kid-agnostic verification attempt)
  return certDer;
}

export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
): Promise<VerifiedToken> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid token format");

  const [headerB64, payloadB64, sigB64] = parts;
  let header: any, payload: any;
  try {
    header = JSON.parse(b64UrlDecodeString(headerB64));
    payload = JSON.parse(b64UrlDecodeString(payloadB64));
  } catch {
    throw new Error("Invalid token JSON");
  }

  if (header.alg !== "RS256") throw new Error("Invalid alg");
  if (!header.kid) throw new Error("Missing kid");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("Token expired");
  if (typeof payload.iat !== "number" || payload.iat > now + 60) throw new Error("Token iat in future");
  if (payload.aud !== projectId) throw new Error("Invalid aud");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Invalid iss");
  if (!payload.sub || typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("Missing sub");
  // Optional: auth_time check
  if (typeof payload.auth_time !== "number") throw new Error("Missing auth_time");

  const certs = await getGoogleCerts();
  const certPem = certs[header.kid];
  if (!certPem) throw new Error("Unknown kid");

  const signingInput = `${headerB64}.${payloadB64}`;
  let valid = false;
  try {
    valid = await verifyRs256Signature(signingInput, sigB64, certPem);
  } catch (e) {
    // fallback: try all certs if kid-specific fails (key rotation edge)
    for (const pem of Object.values(certs)) {
      try {
        if (await verifyRs256Signature(signingInput, sigB64, pem)) { valid = true; break; }
      } catch (_) {}
    }
    if (!valid) throw new Error(`Signature verification failed: ${(e as Error).message}`);
  }
  if (!valid) throw new Error("Invalid signature");

  return { uid: payload.sub, email: payload.email };
}

export function getBearerToken(request: Request): string | null {
  const h = request.headers.get("Authorization") ?? request.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
