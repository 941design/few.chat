import type { EventSigner } from 'applesauce-core';
import type { MediaAttachment as EngineMediaAttachment } from '@941design/marmot-engine/core';
import { BLOSSOM_BASE_URL } from '@/src/config/blossom';
import { createLogger } from '@/src/lib/logger';
import { getNextPublicBlossomTrustedHosts } from '@/src/lib/publicEnv';

const log = createLogger('blossom');

export class BlossomUploadError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'BlossomUploadError';
  }
}

export class BlossomNotFoundError extends Error {
  constructor(sha256: string) {
    super(`Blob not found: ${sha256}`);
    this.name = 'BlossomNotFoundError';
  }
}

export class BlossomOriginError extends Error {
  constructor(blobUrl: string) {
    super(`Blob URL origin not allowed: ${blobUrl}`);
    this.name = 'BlossomOriginError';
  }
}

/**
 * Strict validation of a URL returned by *our* Blossom upload response.
 *
 * Used at upload time only: the server we just uploaded to must hand back a
 * URL on its own configured origin. A mismatch is a server-config bug, not a
 * transient failure — we surface it to the caller before stamping the URL
 * into outbound message metadata.
 */
export function assertAllowedBlossomUrl(blobUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(blobUrl);
  } catch {
    throw new BlossomOriginError(blobUrl);
  }
  const allowed = new URL(BLOSSOM_BASE_URL);
  if (parsed.origin !== allowed.origin) {
    throw new BlossomOriginError(blobUrl);
  }
  return parsed;
}

/**
 * Resolves the set of trusted Blossom origins from configuration.
 *
 * Defaults to the operator's own `BLOSSOM_BASE_URL`. Federation is opt-in:
 * additional origins are listed in `NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS` as a
 * comma-separated list. Read at call time so test stubs and server-side
 * config reloads take effect without re-importing the module.
 */
function getTrustedOrigins(): Set<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(BLOSSOM_BASE_URL).origin);
  } catch {
    // BLOSSOM_BASE_URL itself is invalid — origin set stays empty, every
    // download fails closed until the operator fixes the config.
  }
  const extra = getNextPublicBlossomTrustedHosts() || '';
  for (const raw of extra.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // Drop malformed entries; do not let a typo in the env var open a
      // bypass or disable the canonical origin.
    }
  }
  return origins;
}

/**
 * Validation of an inbound attachment URL before download.
 *
 * Receivers fetch only from origins on the operator-configured allowlist —
 * the local `BLOSSOM_BASE_URL` plus any origins explicitly listed in
 * `NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS`. Without this gate, any group member
 * could publish an attachment URL pointing at an attacker-controlled host
 * and every receiver would issue a background GET to it on render — a
 * trivial SSRF / IP-disclosure surface. Federation across non-default
 * Blossom servers is supported, but only when the operator opts in.
 */
export function assertDownloadableBlobUrl(blobUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(blobUrl);
  } catch {
    throw new BlossomOriginError(blobUrl);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BlossomOriginError(blobUrl);
  }
  const allowed = getTrustedOrigins();
  if (!allowed.has(parsed.origin)) {
    throw new BlossomOriginError(blobUrl);
  }
  return parsed;
}

export const RETRY_DELAYS = [500, 1500, 5000];

/**
 * Per-request timeout for Blossom upload/download. A stalled TCP connection
 * or hanging server response would otherwise leave the composer/lightbox
 * stuck in `uploading`/`loading` forever — the abort path turns that into
 * a retryable (upload) or terminal (download) failure.
 */
export const REQUEST_TIMEOUT_MS = 30000;

/** A response body larger than the caller's byte limit (declared by Content-Length, or counted while streaming). */
export class BlossomTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Blossom download exceeds the ${limit} byte limit`);
    this.name = 'BlossomTooLargeError';
  }
}

/** Kind of the Blossom (BUD-02) upload authorization event the app signs with the account key. */
import { BLOSSOM_AUTH_KIND } from './blossomAuthKind';
export { BLOSSOM_AUTH_KIND };

export class BlossomTimeoutError extends Error {
  constructor(operation: 'upload' | 'download') {
    super(`Blossom ${operation} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    this.name = 'BlossomTimeoutError';
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  operation: 'upload' | 'download',
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new BlossomTimeoutError(operation);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function buildBlossomAuthEvent(
  signer: EventSigner,
  ciphertextSha256: string,
): Promise<Record<string, unknown>> {
  const pubkey = await signer.getPublicKey();
  const now = Math.floor(Date.now() / 1000);
  const draft = {
    kind: BLOSSOM_AUTH_KIND,
    created_at: now,
    content: 'few image upload',
    tags: [
      ['t', 'upload'],
      ['x', ciphertextSha256],
      ['expiration', String(now + 300)],
    ],
    pubkey,
  };
  return signer.signEvent(draft) as Promise<Record<string, unknown>>;
}

function encodeAuthHeader(event: Record<string, unknown>): string {
  return 'Nostr ' + btoa(JSON.stringify(event));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function put(
  encryptedBytes: Uint8Array,
  signer: EventSigner,
  onProgress?: (pct: number) => void,
): Promise<string> {
  let lastError: unknown;

  // Materialize an exact ArrayBuffer matching the typed-array view so a
  // non-zero-offset or partial-length view does not leak surrounding bytes
  // into either the auth-event hash or the upload body.
  const bodyBuffer = encryptedBytes.buffer.slice(
    encryptedBytes.byteOffset,
    encryptedBytes.byteOffset + encryptedBytes.byteLength,
  ) as ArrayBuffer;
  const bodyHash = await sha256Hex(new Uint8Array(bodyBuffer));

  const totalAttempts = RETRY_DELAYS.length + 1;
  log.debug(
    `upload start: ${encryptedBytes.byteLength} bytes, sha256=${bodyHash.slice(0, 16)}…, server=${BLOSSOM_BASE_URL}`,
  );

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const authEvent = await buildBlossomAuthEvent(signer, bodyHash);
    log.debug(`upload attempt ${attempt + 1}/${totalAttempts}`);

    try {
      const response = await fetchWithTimeout(
        `${BLOSSOM_BASE_URL}/upload`,
        {
          method: 'PUT',
          headers: {
            Authorization: encodeAuthHeader(authEvent),
            'Content-Type': 'application/octet-stream',
            // route96 requires the body hash in this header in addition to the
            // `x` tag in the auth event. Other Blossom servers ignore it, so
            // sending it unconditionally is safe.
            'X-SHA-256': bodyHash,
          },
          body: bodyBuffer,
        },
        REQUEST_TIMEOUT_MS,
        'upload',
      );

      log.debug(`upload response: ${response.status} ${response.statusText}`);

      if (response.status >= 400 && response.status < 500) {
        // route96 (and some other Blossom servers) return the rejection reason
        // in the `x-reason` response header rather than the body — surface
        // both so any server's diagnostic surface is visible in the console.
        const reason = response.headers.get('x-reason') || '';
        const body = await response.text().catch(() => '');
        log.debug(
          `upload terminal 4xx — not retrying (status=${response.status}, x-reason=${reason}, body=${body.slice(0, 500)})`,
        );
        throw new BlossomUploadError(
          `Upload rejected: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      if (!response.ok) {
        lastError = new BlossomUploadError(
          `Upload failed: ${response.status} ${response.statusText}`,
          response.status,
        );
        if (attempt < RETRY_DELAYS.length) {
          log.debug(`upload http ${response.status} — retrying in ${RETRY_DELAYS[attempt]}ms`);
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        log.debug(`upload exhausted retries (last status=${response.status})`);
        throw lastError;
      }

      const json = await response.json();
      const rawUrl = json.url as string;
      // Validate the server-returned URL against the allowed Blossom origin
      // before stamping it into outbound message metadata. A misconfigured
      // server that responds with a non-canonical origin would otherwise
      // produce attachments every receiver rejects as BlossomOriginError.
      assertAllowedBlossomUrl(rawUrl);
      onProgress?.(100);
      log.debug(`upload success on attempt ${attempt + 1}: ${rawUrl}`);
      return rawUrl;
    } catch (err) {
      if (err instanceof BlossomUploadError && err.status !== undefined && err.status < 500) {
        throw err;
      }
      // Origin mismatch in the upload response is a server-config bug,
      // not a transient failure — fail immediately rather than retry.
      if (err instanceof BlossomOriginError) {
        log.debug(`upload origin mismatch — not retrying: ${err.message}`);
        throw err;
      }
      lastError = err;
      if (attempt < RETRY_DELAYS.length) {
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        log.debug(`upload error — retrying in ${RETRY_DELAYS[attempt]}ms (${reason})`);
        await sleep(RETRY_DELAYS[attempt]);
      } else {
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        log.debug(`upload exhausted retries (${reason})`);
      }
    }
  }

  // Preserve the original error subclass (BlossomUploadError, BlossomTimeoutError,
  // ...) so callers can react to specific failure modes — wrapping everything
  // in BlossomUploadError would mask retryable-vs-terminal distinctions.
  if (lastError instanceof Error) throw lastError;
  throw new BlossomUploadError(String(lastError));
}

/**
 * Downloads a blob, never holding more than `maxBytes` of it.
 *
 * A declared Content-Length over the limit is rejected without reading the body; otherwise the body is read as a
 * stream and aborted as soon as the running total exceeds the limit. The timeout is an IDLE timeout: armed for the
 * headers and re-armed on every body chunk, so a slow but steady link succeeds while a stalled connection or body
 * times out. Overall caps belong to the callers. Redirects are followed (BUD-01 lets a server 307/308 to a CDN), but
 * the FINAL response URL must be on the same trusted-origin allowlist as the requested one, else the download is
 * rejected with {@link BlossomOriginError}; callers hash-check the content.
 */
export async function get(blobUrl: string, maxBytes: number = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
  const validated = assertDownloadableBlobUrl(blobUrl);
  const controller = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new BlossomTimeoutError('download')));
  });
  timeout.catch(() => undefined); // an unconsumed rejection (success path) is not an unhandled one
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  };
  arm();
  try {
    const work = (async (): Promise<Uint8Array> => {
      const response = await fetch(validated.toString(), { signal: controller.signal });

      // A redirect may have led anywhere: the final origin must be allowlisted too (an empty url is a response
      // that was not fetched over the network, so there is nothing to check).
      if (typeof response.url === 'string' && response.url !== '') assertDownloadableBlobUrl(response.url);

      if (response.status === 404) {
        const sha256 = validated.pathname.split('/').pop() ?? blobUrl;
        throw new BlossomNotFoundError(sha256);
      }
      if (!response.ok) {
        throw new BlossomUploadError(`Download failed: ${response.status} ${response.statusText}`, response.status);
      }

      const declared = response.headers?.get?.('content-length');
      if (declared != null && declared !== '' && Number(declared) > maxBytes) {
        await response.body?.cancel?.().catch(() => undefined);
        throw new BlossomTooLargeError(maxBytes);
      }

      if (!response.body || typeof response.body.getReader !== 'function') {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes) throw new BlossomTooLargeError(maxBytes);
        return new Uint8Array(buffer);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new BlossomTooLargeError(maxBytes);
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    })();
    work.catch(() => undefined); // when the timeout wins the race, the abandoned work's rejection is not unhandled
    return await Promise.race([work, timeout]);
  } catch (err) {
    if (controller.signal.aborted && !(err instanceof BlossomTimeoutError)) throw new BlossomTimeoutError('download');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  // TS 5.7 narrows `BufferSource` to `ArrayBufferView<ArrayBuffer>`, but in
  // this codebase we never use SharedArrayBuffer-backed views — cast through
  // `unknown` to satisfy the digest signature without copying the bytes.
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Group media (encrypted-media-v1): ports of the group image service.
// ---------------------------------------------------------------------------

/** The Blossom servers written into new attachments' locators: the operator's server, no trailing slash. */
export function groupBlossomServers(): string[] {
  return [BLOSSOM_BASE_URL.replace(/\/+$/, '')];
}

/** Most `blossom-v1` locators (on allowed origins) tried for one attachment. */
export const MAX_LOCATORS_TRIED = 3;

/**
 * Fetches the ciphertext of a group attachment, at most `maxBytes` of it per locator.
 *
 * Only `blossom-v1` locators on the operator allowlist are tried (a locator on any other origin is
 * skipped without a request: the SSRF / IP-disclosure gate of {@link assertDownloadableBlobUrl}), in the
 * order the sender listed them. Bytes are accepted only when their SHA-256 is the attachment's
 * `ciphertextSha256`: a server answering with other bytes counts as a failed locator, never as content.
 * Throws {@link BlossomNotFoundError} when every tried locator was missing, otherwise the last failure,
 * and {@link BlossomOriginError} when no locator was on an allowed origin.
 */
export async function getAttachmentCiphertext(
  attachment: Pick<EngineMediaAttachment, 'locators' | 'ciphertextSha256'>,
  maxBytes: number,
  fetchBlob: (blobUrl: string, maxBytes: number) => Promise<Uint8Array> = get,
): Promise<Uint8Array> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new TypeError('getAttachmentCiphertext: maxBytes must be a positive number');
  let lastError: unknown;
  let tried = 0;
  let missing = 0;
  for (const locator of attachment.locators) {
    if (locator.kind !== 'blossom-v1') continue;
    // The sender lists the locators: bound the requests one attachment can make a receiver issue.
    if (tried >= MAX_LOCATORS_TRIED) break;
    try {
      assertDownloadableBlobUrl(locator.value);
    } catch (err) {
      lastError = err;
      continue;
    }
    tried++;
    try {
      const bytes = await fetchBlob(locator.value, maxBytes);
      if (bytes.length > maxBytes) throw new BlossomTooLargeError(maxBytes);
      if ((await sha256Hex(bytes)) === attachment.ciphertextSha256) return bytes;
      lastError = new BlossomUploadError(`Blob at ${locator.value} does not match its content address`);
    } catch (err) {
      if (err instanceof BlossomNotFoundError) missing++;
      lastError = err;
    }
  }
  if (tried > 0 && missing === tried) throw new BlossomNotFoundError(attachment.ciphertextSha256);
  if (lastError instanceof Error) throw lastError;
  throw new BlossomOriginError(attachment.locators.map((l) => l.value).join(','));
}

/** Production wiring of the group image service's Blossom ports (ciphertext only goes through `upload`). */
export function blossomMediaPorts(signer: EventSigner): {
  upload: (ciphertext: Uint8Array) => Promise<string>;
  download: (attachment: EngineMediaAttachment, maxBytes: number) => Promise<Uint8Array>;
  blossomServers: string[];
} {
  return {
    upload: (ciphertext) => put(ciphertext, signer),
    download: (attachment, maxBytes) => getAttachmentCiphertext(attachment, maxBytes),
    blossomServers: groupBlossomServers(),
  };
}
