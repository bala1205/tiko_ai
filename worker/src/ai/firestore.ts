export interface Env {
  FIREBASE_PROJECT_ID: string;
  NVIDIA_API_KEY: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  // optional override
  FIREBASE_PROJECT_ID_OVERRIDE?: string;
}

type AccessTokenCache = { token: string; expiresAt: number };
let cachedToken: AccessTokenCache | null = null;

export class FirestoreError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FirestoreError";
    this.status = status;
  }
}

function getProjectId(env: Env): string {
  return env.FIREBASE_PROJECT_ID || "tiko-6a169";
}

// -- JWT helpers for service account --

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function strToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function createServiceAccountJwt(clientEmail: string, privateKeyPem: string, scope: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const headerB64 = base64UrlEncode(strToBytes(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(strToBytes(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const keyBuffer = pemToArrayBuffer(privateKeyPem);
  const subtle = (globalThis as any).crypto.subtle as SubtleCrypto;
  const key = await subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle.sign("RSASSA-PKCS1-v1_5", key, strToBytes(signingInput) as unknown as BufferSource);
  const sigB64 = base64UrlEncode(new Uint8Array(sig));
  return `${signingInput}.${sigB64}`;
}

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  project_id?: string;
}

function parseServiceAccount(env: Env): { clientEmail: string; privateKey: string; projectId?: string } | null {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const j = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as ServiceAccountJson;
      if (j.client_email && j.private_key) {
        // private_key from JSON has \n escaped; JSON.parse already unescapes
        return { clientEmail: j.client_email, privateKey: j.private_key, projectId: j.project_id };
      }
    } catch (e) {
      console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON", e);
    }
  }
  if (env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    // Wrangler stores \n as literal \n, need to replace
    const pk = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
    return { clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: pk };
  }
  return null;
}

export async function getAccessToken(env: Env): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt - 60_000) return cachedToken.token;

  const sa = parseServiceAccount(env);
  if (!sa) throw new Error("Firebase service account not configured");

  const jwt = await createServiceAccountJwt(sa.clientEmail, sa.privateKey, "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/cloud-platform");

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new FirestoreError(`Failed to get access token ${resp.status}: ${t.slice(0, 500)}`, resp.status);
  }
  const j: any = await resp.json();
  const token = j.access_token as string;
  const expiresIn = (j.expires_in as number) ?? 3600;
  cachedToken = { token, expiresAt: now + expiresIn * 1000 };
  return token;
}

// -- Firestore REST helpers --

function firestoreBase(projectId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

function firestoreFieldToValue(field: any): any {
  if (!field || typeof field !== "object") return null;
  if ("stringValue" in field) return field.stringValue;
  if ("integerValue" in field) return parseInt(field.integerValue, 10);
  if ("doubleValue" in field) return field.doubleValue;
  if ("booleanValue" in field) return field.booleanValue;
  if ("timestampValue" in field) return field.timestampValue;
  if ("nullValue" in field) return null;
  if ("mapValue" in field) {
    const out: any = {};
    for (const [k, v] of Object.entries(field.mapValue.fields ?? {})) out[k] = firestoreFieldToValue(v);
    return out;
  }
  if ("arrayValue" in field) return (field.arrayValue.values ?? []).map(firestoreFieldToValue);
  return null;
}

function docFieldsToObject(fields: Record<string, any> | undefined): Record<string, any> {
  if (!fields) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = firestoreFieldToValue(v);
  return out;
}

export async function getConversation(
  projectId: string,
  accessToken: string,
  conversationId: string,
): Promise<{ exists: boolean; data?: Record<string, any> }> {
  const url = `${firestoreBase(projectId)}/conversations/${encodeURIComponent(conversationId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return { exists: false };
  if (!res.ok) {
    const t = await res.text();
    throw new FirestoreError(`Firestore getConversation ${res.status}: ${t.slice(0, 500)}`, res.status);
  }
  const j: any = await res.json();
  return { exists: true, data: docFieldsToObject(j.fields) };
}

export async function loadHistory(
  projectId: string,
  accessToken: string,
  conversationId: string,
  maxMessages: number,
): Promise<Array<{ role: string; content: string }>> {
  // Use runQuery with structuredQuery to get ordered messages
  const runQueryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: "messages", allDescendants: false }],
      where: undefined,
      orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
      limit: maxMessages,
    },
    // parent = projects/.../databases/(default)/documents/conversations/{conversationId}
    // Unfortunately runQuery with parent requires explicit parent field outside structuredQuery
  } as any;

  // Correct format: POST with parent in URL query? Actually runQuery body needs `parent` field.
  const parent = `projects/${projectId}/databases/(default)/documents/conversations/${conversationId}`;
  body.parent = parent;

  // Alternative structuredQuery approach: use from with collectionId messages and filter by __name__ prefix?
  // Simpler: use list with orderBy via runQuery above.

  const res = await fetch(runQueryUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent,
      structuredQuery: {
        from: [{ collectionId: "messages" }],
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
        limit: maxMessages,
      },
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    // fallback to list API if runQuery fails (e.g., needing index)
    console.error(`runQuery failed ${res.status}: ${t.slice(0, 1000)}`);
    // fallback: list documents
    return await listMessagesFallback(projectId, accessToken, conversationId, maxMessages);
  }

  const arr: any[] = await res.json();
  const docs: Array<{ role: string; content: string }> = [];
  for (const item of arr) {
    const doc = item.document;
    if (!doc?.fields) continue;
    const obj = docFieldsToObject(doc.fields);
    const role = typeof obj.role === "string" ? obj.role : "user";
    const content = typeof obj.content === "string" ? obj.content : "";
    if (content.length > 0) docs.push({ role, content });
  }
  // runQuery returned DESC, reverse to ASC for history
  docs.reverse();
  return docs;
}

async function listMessagesFallback(
  projectId: string,
  accessToken: string,
  conversationId: string,
  maxMessages: number,
): Promise<Array<{ role: string; content: string }>> {
  // List then order client side. Firestore list default is by name, not createdAt.
  // We will list pageSize 100 and sort by createdAt if available, then take last maxMessages.
  const url = `${firestoreBase(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages?pageSize=${Math.min(100, maxMessages * 3)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const t = await res.text();
    throw new FirestoreError(`Firestore list fallback ${res.status}: ${t.slice(0, 500)}`, res.status);
  }
  const j: any = await res.json();
  const docsRaw: any[] = j.documents ?? [];
  const parsed = docsRaw
    .map((d) => {
      const obj = docFieldsToObject(d.fields);
      // try to parse createdAt timestamp
      let ts = 0;
      const rawTs = obj.createdAt ?? obj.created_at;
      if (typeof rawTs === "string") ts = Date.parse(rawTs) || 0;
      return { role: obj.role as string, content: obj.content as string, ts };
    })
    .filter((x) => typeof x.content === "string" && x.content.length > 0)
    .sort((a, b) => a.ts - b.ts)
    .slice(-maxMessages)
    .map(({ role, content }) => ({ role, content }));
  return parsed;
}

export async function updateConversationMetadata(
  projectId: string,
  accessToken: string,
  conversationId: string,
  assistantText: string,
): Promise<void> {
  const url =
    `${firestoreBase(projectId)}/conversations/${encodeURIComponent(conversationId)}?updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=lastMessagePreview`;
  const now = new Date().toISOString();
  const preview = assistantText.slice(0, 80);
  const body = {
    fields: {
      updatedAt: { timestampValue: now },
      lastMessagePreview: { stringValue: preview },
    },
  };
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error(`Failed to update conversation ${conversationId}: ${res.status} ${t.slice(0, 500)}`);
    // non-fatal
  }
}
