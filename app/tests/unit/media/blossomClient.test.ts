import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Polyfill Web Crypto
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

// Polyfill btoa/atob for Node
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (str: string) => Buffer.from(str, 'binary').toString('base64');
}
if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = (str: string) => Buffer.from(str, 'base64').toString('binary');
}

import type { EventSigner } from 'applesauce-core';

const blossomModule = await import('@/src/lib/media/blossomClient');
const { BLOSSOM_BASE_URL } = await import('@/src/config/blossom');
const {
  buildBlossomAuthEvent,
  put,
  get,
  BlossomUploadError,
  BlossomNotFoundError,
  BlossomOriginError,
  BlossomTimeoutError,
  assertAllowedBlossomUrl,
} = blossomModule;
// Override retry delays to 0 ms so retry tests complete instantly
(blossomModule.RETRY_DELAYS as number[]).splice(0, 3, 0, 0, 0);

// Canonical origin derived from BLOSSOM_BASE_URL — the module freezes this at
// import time from NEXT_PUBLIC_BLOSSOM_BASE_URL, so the tests must read what
// the runtime read instead of hardcoding "https://blossom.band".
const CANONICAL_ORIGIN = new URL(BLOSSOM_BASE_URL).origin;
const canonicalUrl = (path: string): string => `${CANONICAL_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;

// ---- Helpers ----

function makeSigner(pubkey = 'a'.repeat(64)): EventSigner {
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (draft: any) => ({
      ...draft,
      id: 'fakeid',
      sig: 'fakesig',
      pubkey,
    }),
  };
}

function makeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (_name: string) => null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : ''),
    arrayBuffer: async () => new ArrayBuffer(4),
  } as unknown as Response;
}

// ---- Tests ----

describe('buildBlossomAuthEvent', () => {
  it('returns event with kind 24242', async () => {
    const signer = makeSigner();
    const event = await buildBlossomAuthEvent(signer, 'x'.repeat(64));
    expect((event as any).kind).toBe(24242);
  });

  it('includes ["t", "upload"] tag', async () => {
    const signer = makeSigner();
    const event = await buildBlossomAuthEvent(signer, 'x'.repeat(64));
    expect((event as any).tags).toContainEqual(['t', 'upload']);
  });

  it('includes ["x", ciphertextSha256] tag', async () => {
    const signer = makeSigner();
    const sha = 'f'.repeat(64);
    const event = await buildBlossomAuthEvent(signer, sha);
    expect((event as any).tags).toContainEqual(['x', sha]);
  });

  it('includes expiration tag approximately now+300', async () => {
    const before = Math.floor(Date.now() / 1000);
    const signer = makeSigner();
    const event = await buildBlossomAuthEvent(signer, 'x'.repeat(64));
    const after = Math.floor(Date.now() / 1000);
    const expTag = (event as any).tags.find((t: string[]) => t[0] === 'expiration');
    expect(expTag).toBeDefined();
    const expiration = parseInt(expTag![1], 10);
    expect(expiration).toBeGreaterThanOrEqual(before + 295);
    expect(expiration).toBeLessThanOrEqual(after + 305);
  });
});

describe('put', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends PUT to BLOSSOM_BASE_URL/upload with Authorization header and returns url', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse(200, { url: canonicalUrl('/abc') }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await put(new Uint8Array([1, 2, 3]), makeSigner());
    expect(result).toBe(canonicalUrl('/abc'));

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/upload$/);
    expect((opts as RequestInit).method).toBe('PUT');
    expect((opts as RequestInit).headers as Record<string, string>).toMatchObject({
      Authorization: expect.stringMatching(/^Nostr /),
    });
  });

  it('throws BlossomUploadError immediately on 4xx without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(put(new Uint8Array([1]), makeSigner())).rejects.toBeInstanceOf(
      BlossomUploadError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx up to 3 times then throws BlossomUploadError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    await expect(put(new Uint8Array([1]), makeSigner())).rejects.toBeInstanceOf(BlossomUploadError);
    // 1 initial + 3 retries = 4 calls total
    expect(fetchMock.mock.calls.length).toBe(4);
  });

  it('succeeds on retry after initial 5xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(200, { url: canonicalUrl('/ok') }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await put(new Uint8Array([1]), makeSigner());
    expect(result).toBe(canonicalUrl('/ok'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('calls onProgress with 100 on success', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse(200, { url: canonicalUrl('/x') }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const onProgress = vi.fn();
    await put(new Uint8Array([1]), makeSigner(), onProgress);
    expect(onProgress).toHaveBeenCalledWith(100);
  });

  it('uploads and hashes only the view bytes when input is a non-zero-offset Uint8Array', async () => {
    let capturedBody: ArrayBuffer | null = null;
    let capturedAuth: Record<string, unknown> | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url, opts: RequestInit) => {
      capturedBody = opts.body as ArrayBuffer;
      const authHeader = (opts.headers as Record<string, string>).Authorization;
      capturedAuth = JSON.parse(globalThis.atob(authHeader.replace(/^Nostr /, '')));
      return makeResponse(200, { url: canonicalUrl('/sliced') });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 8-byte backing buffer; view covers only bytes [4..8) → [5,6,7,8].
    // If the upload path passes the raw .buffer, both the hash and the
    // upload body would include the leading [1,2,3,4] — corrupting blobs
    // and breaking decryption on the receiver. This test pins the contract.
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = backing.subarray(4);
    expect(view.byteOffset).toBe(4);
    expect(view.byteLength).toBe(4);

    await put(view, makeSigner());

    // Body byte-length matches the view, not the backing buffer.
    expect(capturedBody).not.toBeNull();
    expect((capturedBody as unknown as ArrayBuffer).byteLength).toBe(4);
    expect(Array.from(new Uint8Array(capturedBody as unknown as ArrayBuffer))).toEqual([5, 6, 7, 8]);

    // Auth event 'x' tag must hash only the view bytes.
    const tags = (capturedAuth as unknown as { tags: string[][] }).tags;
    const xTag = tags.find((t) => t[0] === 'x');
    expect(xTag).toBeDefined();

    const expectedDigest = await crypto.subtle.digest(
      'SHA-256',
      new Uint8Array([5, 6, 7, 8]),
    );
    const expectedHex = Array.from(new Uint8Array(expectedDigest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(xTag![1]).toBe(expectedHex);
  });
});

describe('get', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns Uint8Array of response body on success', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: '200',
      arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await get(canonicalUrl('/abc123'));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([9, 8, 7]);
  });

  it('throws BlossomNotFoundError on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: '404',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(get(canonicalUrl('/missingsha'))).rejects.toBeInstanceOf(
      BlossomNotFoundError,
    );
  });

  it('throws BlossomUploadError on non-404 error', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse(500));
    vi.stubGlobal('fetch', fetchMock);

    await expect(get(canonicalUrl('/x'))).rejects.toBeInstanceOf(BlossomUploadError);
  });

  it('refuses to download from an untrusted origin without making a network request', async () => {
    // Defense-in-depth: an attacker-supplied attachment URL must not let
    // every group member fan out a GET to an arbitrary host. Receivers
    // download only from origins on the operator-configured allowlist.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(get('https://attacker.example/abc')).rejects.toBeInstanceOf(BlossomOriginError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads from a foreign origin once it is added via NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS', async () => {
    // Federation is opt-in: the operator explicitly trusts additional
    // Blossom hosts via env. A URL whose origin is on that list passes.
    vi.stubEnv('NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS', 'https://other-blossom.example');
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: '200',
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await get('https://other-blossom.example/abc');
    expect(Array.from(result)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it('downloads from an http localhost origin when allowlisted (local dev / e2e mock)', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS', 'http://localhost:3001');
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: '200',
      arrayBuffer: async () => new Uint8Array([4, 5]).buffer,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await get('http://localhost:3001/abc');
    expect(Array.from(result)).toEqual([4, 5]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it('rejects URLs with non-http(s) schemes without making a network request', async () => {
    // data:, file:, javascript: etc. would let an attacker-crafted message
    // exfiltrate data or execute unintended fetches — we still gate the
    // download on a safe network scheme.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(get('file:///etc/passwd')).rejects.toBeInstanceOf(BlossomOriginError);
    await expect(get('data:text/plain,hello')).rejects.toBeInstanceOf(BlossomOriginError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed URLs without making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(get('not-a-url')).rejects.toBeInstanceOf(BlossomOriginError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('put — origin validation on upload response', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws BlossomOriginError when server returns a foreign origin URL', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse(200, { url: 'https://attacker.example/abc' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(put(new Uint8Array([1]), makeSigner())).rejects.toBeInstanceOf(
      BlossomOriginError,
    );
    // Origin mismatch is a server-config bug, not a transient failure —
    // it must short-circuit retries so the caller fails fast.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws BlossomOriginError when server returns a malformed URL', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse(200, { url: 'not-a-url' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(put(new Uint8Array([1]), makeSigner())).rejects.toBeInstanceOf(
      BlossomOriginError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns url unchanged when server returns the canonical origin', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse(200, { url: canonicalUrl('/canonical') }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await put(new Uint8Array([1]), makeSigner());
    expect(result).toBe(canonicalUrl('/canonical'));
  });
});

describe('put — timeout on stalled requests', () => {
  afterEach(() => vi.restoreAllMocks());

  it('aborts the request and surfaces BlossomTimeoutError when fetch hangs', async () => {
    // Simulate a stalled connection: fetch never resolves on its own,
    // but it observes the AbortSignal and rejects with a DOMException.
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Replace the real WebCrypto digest with a microtask-only stub. The
    // production digest (node:crypto.webcrypto) resolves on a libuv tick,
    // which `runAllTimersAsync` does not pump — leaving the retry loop
    // stuck on `await sha256Hex(...)` after the first abort fires. A
    // synchronous-equivalent Promise keeps the whole loop on the
    // microtask queue, where Vitest's fake-timer driver can drain it.
    const digestSpy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockImplementation(async () => new ArrayBuffer(32));

    vi.useFakeTimers();
    const promise = put(new Uint8Array([1]), makeSigner());
    // Attach a rejection handler synchronously so the in-flight rejection
    // from each aborted attempt never floats unobserved past a microtask
    // boundary (which would trip Vitest's unhandled-rejection guard even
    // though the final await catches it).
    const captured = promise.catch((err) => err);
    // Drain the retry loop in one pump: each timed-out attempt schedules
    // the next abort timer inside its catch handler, so a hand-rolled
    // advance-by-timeout loop is fragile (must know the attempt count,
    // burns wall clock per iteration). runAllTimersAsync walks the whole
    // chain until put() rejects and no timers remain.
    await vi.runAllTimersAsync();
    const err = await captured;
    vi.useRealTimers();
    digestSpy.mockRestore();
    expect(err).toBeInstanceOf(BlossomTimeoutError);
    // Each timed-out attempt counts as a retryable failure, so all four
    // attempts run before the final rejection.
    expect(fetchMock.mock.calls.length).toBe(4);
  });

  it('clears the timeout timer when the request resolves normally', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse(200, { url: canonicalUrl('/x') }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // No timer leak: if clearTimeout were missing, vitest would warn about
    // pending timers. Asserting success is enough — the contract is that
    // the happy path does not depend on the abort firing.
    await expect(put(new Uint8Array([1]), makeSigner())).resolves.toBe(
      canonicalUrl('/x'),
    );
  });
});

describe('get — timeout on stalled downloads', () => {
  afterEach(() => vi.restoreAllMocks());

  it('aborts the request and surfaces BlossomTimeoutError when fetch hangs', async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    vi.useFakeTimers();
    const promise = get(canonicalUrl('/abc'));
    const captured = promise.catch((err) => err);
    await vi.advanceTimersByTimeAsync(30001);
    const err = await captured;
    vi.useRealTimers();
    // Download has no retry loop — the first timeout is terminal so the
    // lightbox can move from `loading` to `failed` without hanging.
    expect(err).toBeInstanceOf(BlossomTimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes an AbortSignal to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: '200',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await get(canonicalUrl('/abc'));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('assertDownloadableBlobUrl — origin allowlist', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts the canonical BLOSSOM_BASE_URL origin', () => {
    const parsed = blossomModule.assertDownloadableBlobUrl(canonicalUrl('/abc'));
    expect(parsed.pathname).toBe('/abc');
  });

  it('rejects a foreign origin not on the allowlist', () => {
    expect(() => blossomModule.assertDownloadableBlobUrl('https://attacker.example/abc')).toThrow(
      BlossomOriginError,
    );
  });

  it('accepts an origin added via NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS', 'https://other-blossom.example');
    const parsed = blossomModule.assertDownloadableBlobUrl('https://other-blossom.example/x');
    expect(parsed.origin).toBe('https://other-blossom.example');
  });

  it('parses the comma-separated allowlist and rejects origins not present', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS', 'https://a.example, https://b.example');
    expect(blossomModule.assertDownloadableBlobUrl('https://a.example/x').origin).toBe(
      'https://a.example',
    );
    expect(blossomModule.assertDownloadableBlobUrl('https://b.example/y').origin).toBe(
      'https://b.example',
    );
    expect(() => blossomModule.assertDownloadableBlobUrl('https://c.example/z')).toThrow(
      BlossomOriginError,
    );
  });

  it('still rejects non-http(s) schemes regardless of allowlist', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS', 'https://blossom.band');
    expect(() => blossomModule.assertDownloadableBlobUrl('file:///etc/passwd')).toThrow(
      BlossomOriginError,
    );
    expect(() => blossomModule.assertDownloadableBlobUrl('data:text/plain,hi')).toThrow(
      BlossomOriginError,
    );
  });

  it('ignores malformed entries in NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS', () => {
    // A typo in the env var must not silently disable the canonical origin
    // or open up a bypass — bad entries are dropped, good entries kept.
    vi.stubEnv('NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS', 'not-a-url, https://other.example');
    expect(blossomModule.assertDownloadableBlobUrl(canonicalUrl('/x')).origin).toBe(
      CANONICAL_ORIGIN,
    );
    expect(blossomModule.assertDownloadableBlobUrl('https://other.example/x').origin).toBe(
      'https://other.example',
    );
    expect(() => blossomModule.assertDownloadableBlobUrl('https://attacker.example/x')).toThrow(
      BlossomOriginError,
    );
  });
});

describe('assertAllowedBlossomUrl', () => {
  it('returns parsed URL for matching origin', () => {
    const url = assertAllowedBlossomUrl(canonicalUrl('/abc'));
    expect(url.pathname).toBe('/abc');
  });

  it('throws on different host', () => {
    expect(() => assertAllowedBlossomUrl('https://evil.example/abc')).toThrow(BlossomOriginError);
  });

  it('throws on different port', () => {
    // Build a same-host-different-port URL by mutating the canonical origin.
    const canonical = new URL(BLOSSOM_BASE_URL);
    const mismatchedPort = canonical.port === '8443' ? '8444' : '8443';
    const wrongPortUrl = `${canonical.protocol}//${canonical.hostname}:${mismatchedPort}/abc`;
    expect(() => assertAllowedBlossomUrl(wrongPortUrl)).toThrow(BlossomOriginError);
  });
});

describe('get: redirects and idle timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const streamResponse = (body: ReadableStream<Uint8Array>, url: string): Response =>
    ({ ok: true, status: 200, statusText: '200', url, headers: { get: () => null }, body }) as unknown as Response;
  const oneShot = (bytes: number[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(bytes));
        c.close();
      },
    });

  it('follows redirects (default fetch behaviour: no redirect:"error")', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(streamResponse(oneShot([1, 2]), canonicalUrl('/abc')));
    vi.stubGlobal('fetch', fetchMock);
    await get(canonicalUrl('/abc'));
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).not.toBe('error');
  });

  it('accepts a download whose final URL (after a redirect) is on another allowlisted origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOSSOM_TRUSTED_HOSTS', 'https://cdn.allowed.example');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(streamResponse(oneShot([7, 8]), 'https://cdn.allowed.example/abc')));
    expect(Array.from(await get(canonicalUrl('/abc')))).toEqual([7, 8]);
    vi.unstubAllEnvs();
  });

  it('rejects, without returning content, a download redirected to a non-allowlisted origin', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(streamResponse(oneShot([7, 8]), 'https://attacker.example/abc')));
    await expect(get(canonicalUrl('/abc'))).rejects.toBeInstanceOf(BlossomOriginError);
  });

  it('a slow but steady body (each gap under the idle timeout, total over it) succeeds', async () => {
    vi.useFakeTimers();
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (c) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (n++ < 4) c.enqueue(new Uint8Array([n]));
            else c.close();
            resolve();
          }, 20000);
        }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(streamResponse(body, canonicalUrl('/abc'))));
    const p = get(canonicalUrl('/abc'));
    await vi.advanceTimersByTimeAsync(100000);
    expect(Array.from(await p)).toEqual([1, 2, 3, 4]);
  });

  it('a body that stalls mid-stream times out', async () => {
    vi.useFakeTimers();
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (c) => {
        if (n++ === 0) {
          c.enqueue(new Uint8Array([1]));
          return;
        }
        return new Promise<void>(() => undefined); // never delivers again
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(streamResponse(body, canonicalUrl('/abc'))));
    const captured = get(canonicalUrl('/abc')).catch((e) => e);
    await vi.advanceTimersByTimeAsync(31000);
    expect(await captured).toBeInstanceOf(BlossomTimeoutError);
  });
});
