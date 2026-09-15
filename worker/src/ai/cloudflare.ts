// Cloudflare Workers AI REST integration for Tiko.
// Secure backend-only: uses CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN secrets.
// Never expose these to the client. Never log them.

export const CF_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
export const CF_VISION_FALLBACK_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const CF_IMAGE_GEN_MODEL = "@cf/black-forest-labs/flux-1-schnell";
export const CF_IMAGE_GEN_FALLBACK = "@cf/stabilityai/stable-diffusion-xl-base-1.0";

export const CF_VISION_TIMEOUT_MS = 30000;
export const CF_IMAGE_GEN_TIMEOUT_MS = 45000;
export const CF_FETCH_IMAGE_TIMEOUT_MS = 10000;

export class CloudflareAIError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "CloudflareAIError";
    this.status = status;
    this.code = code;
  }
}

function cfRunUrl(accountId: string, model: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
}

function isAllowedMime(mime: string): boolean {
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "image/jpg"];
  return allowed.includes(mime.toLowerCase());
}

export function mimeFromExtension(ext: string): string {
  const e = ext.toLowerCase().replace(".", "");
  switch (e) {
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "heic": return "image/heic";
    case "heif": return "image/heif";
    case "jpg":
    case "jpeg":
    default: return "image/jpeg";
  }
}

export function dataUriFromBytes(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    // Avoid stack overflow for large arrays
    binary += String.fromCharCode(...slice);
  }
  const b64 = btoa(binary);
  return `data:${mime};base64,${b64}`;
}

export function extractBase64FromDataUri(dataUri: string): { base64: string; mime: string } | null {
  const m = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

export function isDataUri(s: string): boolean {
  return s.startsWith("data:image/");
}

export function validateImageBytes(bytes: Uint8Array, mime?: string): void {
  if (!bytes || bytes.length === 0) throw new CloudflareAIError("Image is empty", 400, "invalid-argument");
  if (bytes.length > 10 * 1024 * 1024) throw new CloudflareAIError("Image too large (max 10MB)", 400, "invalid-argument");
  if (mime && !isAllowedMime(mime)) throw new CloudflareAIError(`Unsupported image type: ${mime}. Use jpeg, png, webp, gif`, 400, "invalid-argument");
  // Basic magic number check (optional, non-strict)
  if (bytes.length < 4) throw new CloudflareAIError("Invalid image data", 400, "invalid-argument");
}

export async function fetchImageAsDataUri(url: string, timeoutMs = CF_FETCH_IMAGE_TIMEOUT_MS): Promise<{ dataUri: string; bytes: Uint8Array; mime: string; size: number }> {
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new CloudflareAIError("Invalid imageUrl", 400, "invalid-argument");
  }
  if (url.length > 2048) throw new CloudflareAIError("imageUrl too long", 400, "invalid-argument");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, { signal: ctrl.signal });
  } catch (e: any) {
    clearTimeout(t);
    if (e?.name === "AbortError") throw new CloudflareAIError("Fetching image timed out", 504, "deadline-exceeded");
    throw new CloudflareAIError(`Failed to fetch image: ${e?.message ?? String(e)}`, 500, "internal");
  }
  clearTimeout(t);
  if (!resp.ok) throw new CloudflareAIError(`Failed to fetch image (${resp.status})`, 400, "invalid-argument");
  const contentType = resp.headers.get("content-type")?.split(";")[0]?.trim() ?? "image/jpeg";
  if (!contentType.startsWith("image/")) throw new CloudflareAIError("URL does not point to an image", 400, "invalid-argument");
  if (!isAllowedMime(contentType) && !contentType.startsWith("image/")) {
    throw new CloudflareAIError(`Unsupported image type: ${contentType}`, 400, "invalid-argument");
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  validateImageBytes(buf, contentType);
  const dataUri = dataUriFromBytes(buf, contentType);
  return { dataUri, bytes: buf, mime: contentType, size: buf.length };
}

// --- Vision via REST ---
// CORRECTED per official tutorial https://developers.cloudflare.com/workers-ai/guides/tutorials/llama-vision-tutorial/
// Cloudflare REST for llama-3.2-11b-vision-instruct expects:
// POST https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct
// Body: { messages: [{role:"system", content:"..."}, {role:"user", content:"...what is in this image?"}], image: "data:image/jpeg;base64,..." }
// NOT messages with image_url inside. The tutorial's Worker binding uses messages + image fields.
// We try primary schema (messages string + image dataUri), then fallback to image_url nested for compatibility.
// Also handles Meta license "agree" flow if model requires it.

async function ensureVisionLicenseAgreed(accountId: string, apiToken: string): Promise<void> {
  // One-time per account: POST {prompt:"agree"} to accept Meta license. Safe to call multiple times.
  const url = cfRunUrl(accountId, CF_VISION_MODEL);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "agree" }),
      signal: ctrl.signal,
    });
  } catch (_) {
    // ignore - best effort
  } finally {
    clearTimeout(t);
  }
}

export async function callCloudflareVision(params: {
  accountId: string;
  apiToken: string;
  dataUri: string; // data:image/...;base64,...
  prompt: string;
  systemPrompt?: string;
  timeoutMs?: number;
  model?: string;
}): Promise<string> {
  const { accountId, apiToken, dataUri, prompt, systemPrompt, timeoutMs, model } = params;
  if (!accountId || accountId.length < 5) throw new CloudflareAIError("Cloudflare AI not configured (missing account ID)", 500, "failed-precondition");
  if (!apiToken || apiToken.length < 10) throw new CloudflareAIError("Cloudflare AI not configured", 500, "failed-precondition");
  const chosenModel = model ?? CF_VISION_MODEL;
  const url = cfRunUrl(accountId, chosenModel);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs ?? CF_VISION_TIMEOUT_MS);

  // Primary correct payload per tutorial: messages as strings + image as data URI string
  // Keep prompt as user content string (not array) for this model
  const system = systemPrompt ?? "You are a helpful vision assistant. Describe images accurately, read visible text when present, and answer questions about the image clearly. Use Markdown when useful.";
  const primaryBody = JSON.stringify({
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    image: dataUri,
    max_tokens: 1024,
    temperature: 0.6,
  });

  // Fallback payload: OpenAI-style with image_url inside messages (for alternative models or if primary fails with 400)
  const fallbackBody = JSON.stringify({
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      },
    ],
    max_tokens: 1024,
    temperature: 0.6,
  });

  // Third variant: some REST deployments expect image as array of integers (raw bytes)
  // We prepare but only use if string fails
  let imageArrayBody: string | null = null;
  try {
    const b64Part = dataUri.split(",")[1] ?? "";
    if (b64Part.length > 100) {
      const binary = atob(b64Part);
      const arr = new Array(binary.length);
      for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
      imageArrayBody = JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        image: arr,
        max_tokens: 1024,
      });
    }
  } catch (_) {}

  const tryFetch = async (bodyStr: string, attempt: string): Promise<Response> => {
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: bodyStr,
        signal: ctrl.signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") throw new CloudflareAIError(`Image analysis timed out (${attempt}). Please try again.`, 504, "deadline-exceeded");
      throw new CloudflareAIError(`Cloudflare vision network error (${attempt}): ${e?.message ?? String(e)}`, 500, "internal");
    }
  };

  let resp: Response | null = null;
  let lastSnippet = "";
  let lastStatus = 0;

  // Attempt 1: primary
  try {
    resp = await tryFetch(primaryBody, "primary");
  } catch (e) {
    clearTimeout(t);
    throw e;
  }

  // If primary fails with 400 and error mentions license/agree, auto-agree and retry once
  if (resp && !resp.ok) {
    const text = await resp.text();
    lastSnippet = text.slice(0, 1200);
    lastStatus = resp.status;
    const lower = lastSnippet.toLowerCase();
    if (lower.includes("license") || lower.includes("agree") || lower.includes("meta")) {
      console.warn("Vision model requires license agreement, sending agree and retrying");
      await ensureVisionLicenseAgreed(accountId, apiToken);
      // retry primary after agree
      try {
        resp = await tryFetch(primaryBody, "retry-after-agree");
        if (resp.ok) {
          // proceed to parse below
        } else {
          const retryText = await resp.text();
          lastSnippet = retryText.slice(0, 1200);
          lastStatus = resp.status;
        }
      } catch (e) {
        clearTimeout(t);
        throw e;
      }
    }
  }

  // If still not ok and status 400, try fallbackBody
  if (resp && !resp.ok && resp.status === 400) {
    const lowerFallback = lastSnippet.toLowerCase();
    // Try fallback if primary says invalid image or schema error (but not license)
    if (lowerFallback.includes("invalid") || lowerFallback.includes("image") || lowerFallback.includes("messages") || lowerFallback.includes("schema")) {
      console.warn(`Primary vision payload failed 400, trying fallback image_url schema. snippet=${lastSnippet.slice(0, 200)}`);
      try {
        const resp2 = await tryFetch(fallbackBody, "fallback-image_url");
        if (resp2.ok) {
          resp = resp2;
        } else {
          const t2 = await resp2.text();
          console.warn(`Fallback also failed ${resp2.status}: ${t2.slice(0, 300)}`);
          // Keep original resp but update snippet/status for error reporting
          // Try third variant if available
          if (imageArrayBody) {
            const resp3 = await tryFetch(imageArrayBody, "fallback-array");
            if (resp3.ok) {
              resp = resp3;
            } else {
              const t3 = await resp3.text();
              lastSnippet = t3.slice(0, 1200);
              lastStatus = resp3.status;
              // keep resp as last failed for error below
              resp = resp3;
            }
          } else {
            lastSnippet = t2.slice(0, 1200);
            lastStatus = resp2.status;
            resp = resp2;
          }
        }
      } catch (e) {
        // fallback network error, keep original
      }
    }
  }

  clearTimeout(t);

  if (!resp) throw new CloudflareAIError("No response from Cloudflare vision", 500, "internal");

  if (!resp.ok) {
    // We have already consumed body for some attempts; need to ensure we have snippet
    // If resp was primary and we already read text, lastSnippet is set. For fallback, we updated.
    // For safety, if snippet empty, read it
    if (!lastSnippet) {
      try { lastSnippet = (await resp.text()).slice(0, 1200); } catch {}
      lastStatus = resp.status;
    }
    // Do not leak token or dataUri - snippet is safe
    if (resp.status === 401 || resp.status === 403) throw new CloudflareAIError(`Cloudflare AI authentication failed (${resp.status}). Check CLOUDFLARE_API_TOKEN has Workers AI Read/Write. Details: ${lastSnippet.slice(0, 200)}`, 500, "internal");
    if (resp.status === 429) throw new CloudflareAIError(`AI service is busy (429). Details: ${lastSnippet.slice(0, 200)}`, 429, "resource-exhausted");
    if (resp.status === 400) {
      // Surface actual Cloudflare 400 for debugging (safe, no token)
      throw new CloudflareAIError(`Cloudflare 400: ${lastSnippet.slice(0, 500)}`, 400, "invalid-argument");
    }
    if (resp.status === 404) throw new CloudflareAIError(`Image analysis model not found (404). Model=${chosenModel}. Details: ${lastSnippet.slice(0, 200)}`, 404, "not-found");
    if (resp.status >= 500) throw new CloudflareAIError(`Cloudflare AI temporarily unavailable (${resp.status}). Details: ${lastSnippet.slice(0, 300)}`, 503, "unavailable");
    throw new CloudflareAIError(`Cloudflare vision error ${resp.status}: ${lastSnippet.slice(0, 500)}`, resp.status, "internal");
  }

  // Success - parse JSON (need to re-parse if we already consumed? We consumed for error case only, for success we haven't consumed yet for primary success path)
  // For success path, we haven't consumed body yet for primary success; for fallback success we have not consumed? Actually we replaced resp but not consumed for success, so safe to json()
  // However if resp was from primary success, body not yet read. If resp was fallback success, also not read.
  // For license retry success, also not read.
  let json: any;
  try {
    json = await resp.json();
  } catch (e) {
    throw new CloudflareAIError("Invalid JSON from Cloudflare vision", 500, "internal");
  }
  const result = json?.result;
  if (typeof result === "string" && result.trim().length > 0) return result.trim();
  if (result && typeof result.response === "string" && result.response.trim().length > 0) return result.response.trim();
  if (result && typeof result.description === "string" && result.description.trim().length > 0) return result.description.trim();
  if (result && typeof result.answer === "string" && result.answer.trim().length > 0) return result.answer.trim();
  if (result && typeof result.text === "string" && result.text.trim().length > 0) return result.text.trim();
  if (json?.response && typeof json.response === "string") return json.response.trim();
  if (result && typeof result === "object") {
    for (const v of Object.values(result)) {
      if (typeof v === "string" && (v as string).trim().length > 20) return (v as string).trim();
    }
  }
  throw new CloudflareAIError(`Empty response from image analysis model (${chosenModel}). Raw: ${JSON.stringify(json).slice(0, 500)}`, 500, "internal");
}

export async function callCloudflareVisionWithFallback(params: {
  accountId: string;
  apiToken: string;
  dataUri: string;
  prompt: string;
  systemPrompt?: string;
}): Promise<{ text: string; model: string }> {
  try {
    const text = await callCloudflareVision({ ...params, model: CF_VISION_MODEL });
    return { text, model: CF_VISION_MODEL };
  } catch (e: any) {
    const status = (e as CloudflareAIError)?.status;
    const msg = (e as Error)?.message ?? String(e);
    // Retry on transient or 404 with fallback model
    const shouldFallback = status === 404 || status === 503 || status === 500 || status === 429 || msg.toLowerCase().includes("temporarily") || (CF_VISION_FALLBACK_MODEL as string) !== (CF_VISION_MODEL as string);
    if (shouldFallback && (CF_VISION_FALLBACK_MODEL as string) !== (CF_VISION_MODEL as string)) {
      // Only fallback on server/availability errors, not on 400 invalid image
      if (status === 400 || msg.toLowerCase().includes("invalid image") || msg.toLowerCase().includes("unsupported")) throw e;
      try {
        const text2 = await callCloudflareVision({ ...params, model: CF_VISION_FALLBACK_MODEL, timeoutMs: CF_VISION_TIMEOUT_MS });
        return { text: text2, model: CF_VISION_FALLBACK_MODEL };
      } catch (fe: any) {
        throw fe;
      }
    }
    throw e;
  }
}

// --- Image Generation via REST ---
// Flux-1-schnell: POST /ai/run/@cf/black-forest-labs/flux-1-schnell
// Body: { prompt: string, steps?: number, seed?: number }
// Returns: { result: { image: "base64..." } } or binary? REST returns JSON with base64
// For SDXL fallback: { prompt, height, width, num_steps, guidance, seed }

export async function callCloudflareImageGeneration(params: {
  accountId: string;
  apiToken: string;
  prompt: string;
  steps?: number;
  seed?: number;
  width?: number;
  height?: number;
  model?: string;
  timeoutMs?: number;
}): Promise<{ base64: string; dataUri: string; mime: string }> {
  const { accountId, apiToken, prompt, steps, seed, width, height, model, timeoutMs } = params;
  if (!accountId || accountId.length < 5) throw new CloudflareAIError("Cloudflare AI not configured (missing account ID)", 500, "failed-precondition");
  if (!apiToken || apiToken.length < 10) throw new CloudflareAIError("Cloudflare AI not configured", 500, "failed-precondition");
  if (!prompt || prompt.trim().length === 0) throw new CloudflareAIError("Prompt is required", 400, "invalid-argument");
  if (prompt.length > 2048) throw new CloudflareAIError("Prompt too long (max 2048 chars)", 400, "invalid-argument");
  const chosenModel = model ?? CF_IMAGE_GEN_MODEL;
  const url = cfRunUrl(accountId, chosenModel);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs ?? CF_IMAGE_GEN_TIMEOUT_MS);

  // Build model-specific payload
  let payload: any;
  if (chosenModel.includes("flux")) {
    payload = {
      prompt: prompt.trim(),
      steps: steps ?? 4, // flux schnell max 8
    };
    if (seed !== undefined) payload.seed = seed;
  } else {
    // SDXL style
    payload = {
      prompt: prompt.trim(),
      num_steps: steps ?? 20,
      guidance: 7.5,
      width: width ?? 1024,
      height: height ?? 1024,
    };
    if (seed !== undefined) payload.seed = seed;
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(t);
    if (e?.name === "AbortError") throw new CloudflareAIError("Image generation timed out. Please try again.", 504, "deadline-exceeded");
    throw new CloudflareAIError(`Cloudflare image generation network error: ${e?.message ?? String(e)}`, 500, "internal");
  }
  clearTimeout(t);

  if (!resp.ok) {
    const text = await resp.text();
    const snippet = text.slice(0, 800);
    if (resp.status === 401 || resp.status === 403) throw new CloudflareAIError("Cloudflare AI authentication failed. Please contact support.", 500, "internal");
    if (resp.status === 429) throw new CloudflareAIError("AI service is busy. Please try again in a moment.", 429, "resource-exhausted");
    if (resp.status === 400) throw new CloudflareAIError(snippet.toLowerCase().includes("prompt") ? "Invalid prompt for image generation" : "Invalid image generation request", 400, "invalid-argument");
    if (resp.status === 404) throw new CloudflareAIError("Image generation model not found", 404, "not-found");
    if (resp.status >= 500) throw new CloudflareAIError("AI service is temporarily unavailable. Please try again.", 503, "unavailable");
    throw new CloudflareAIError(`Cloudflare image generation error ${resp.status}: ${snippet.slice(0, 300)}`, resp.status, "internal");
  }

  // Response may be JSON or binary depending on model and Accept header.
  // For REST, typically JSON: { result: "base64" } or { result: { image: "base64" } } or { result: ReadableStream } ?
  // Try to parse as JSON first.
  const contentType = resp.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json: any = await resp.json();
    const result = json?.result;
    // Cases: result is base64 string, or object with image field, or nested
    let b64: string | null = null;
    if (typeof result === "string" && result.length > 100) b64 = result;
    else if (result && typeof result.image === "string") b64 = result.image;
    else if (result && typeof result.data === "string") b64 = result.data;
    else if (json?.image && typeof json.image === "string") b64 = json.image;
    // Some flux responses: { result: { image: "base64", seed: ... } }
    if (!b64) {
      // Try to find any long base64 string in result
      if (result && typeof result === "object") {
        for (const [k, v] of Object.entries(result)) {
          if (typeof v === "string" && (v as string).length > 1000 && /^[A-Za-z0-9+/=]+$/.test((v as string).slice(0, 100))) {
            b64 = v as string;
            break;
          }
        }
      }
    }
    if (!b64) throw new CloudflareAIError("Empty image from generation model", 500, "internal");
    // Ensure no data URI prefix yet, add it
    const mime = "image/jpeg";
    const dataUri = b64.startsWith("data:") ? b64 : `data:${mime};base64,${b64}`;
    const cleanB64 = b64.includes(",") ? b64.split(",")[1] : b64;
    return { base64: cleanB64, dataUri, mime };
  } else {
    // Binary image response (e.g., image/jpeg)
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length === 0) throw new CloudflareAIError("Empty image from generation model", 500, "internal");
    const mime = contentType.split(";")[0] ?? "image/jpeg";
    const dataUri = dataUriFromBytes(buf, mime);
    let binary = "";
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
    const b64 = btoa(binary);
    return { base64: b64, dataUri, mime };
  }
}

export async function callCloudflareImageGenerationWithFallback(params: {
  accountId: string;
  apiToken: string;
  prompt: string;
  steps?: number;
  seed?: number;
}): Promise<{ base64: string; dataUri: string; mime: string; model: string }> {
  try {
    const res = await callCloudflareImageGeneration({ ...params, model: CF_IMAGE_GEN_MODEL });
    return { ...res, model: CF_IMAGE_GEN_MODEL };
  } catch (e: any) {
    const status = (e as CloudflareAIError)?.status;
    const msg = (e as Error)?.message ?? "";
    if ((status === 503 || status === 500 || status === 404 || status === 429 || msg.includes("temporarily")) && (CF_IMAGE_GEN_FALLBACK as string) !== (CF_IMAGE_GEN_MODEL as string)) {
      if (status === 400) throw e;
      const res2 = await callCloudflareImageGeneration({ ...params, model: CF_IMAGE_GEN_FALLBACK });
      return { ...res2, model: CF_IMAGE_GEN_FALLBACK };
    }
    throw e;
  }
}
