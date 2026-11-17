import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlossomNotFoundError,
  BlossomOriginError,
  BlossomTimeoutError,
  BlossomTooLargeError,
  BlossomUploadError,
  MAX_LOCATORS_TRIED,
  get,
  blossomMediaPorts,
  getAttachmentCiphertext,
  groupBlossomServers,
} from '@/src/lib/media/blossomClient';
import { sha256Hex } from './groupMediaFixtures';

const bytes = new Uint8Array([9, 8, 7, 6]);
const hash = sha256Hex(bytes);
const att = (locators: Array<{ kind: string; value: string }>) => ({ locators, ciphertextSha256: hash });
const blossom = (url: string) => ({ kind: 'blossom-v1', value: url });

describe('getAttachmentCiphertext', () => {
  it('returns the bytes of a trusted locator whose SHA-256 is the content address', async () => {
    const fetchBlob = vi.fn(async () => bytes);
    const out = await getAttachmentCiphertext(att([blossom(`https://blossom.band/${hash}`)]), 1024, fetchBlob);
    expect(out).toEqual(bytes);
    expect(fetchBlob).toHaveBeenCalledWith(`https://blossom.band/${hash}`, 1024);
  });

  it('never requests a locator off the operator allowlist (SSRF / IP-disclosure gate)', async () => {
    const fetchBlob = vi.fn(async () => bytes);
    await expect(getAttachmentCiphertext(att([blossom(`https://evil.example/${hash}`)]), 1024, fetchBlob)).rejects.toBeInstanceOf(BlossomOriginError);
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it('skips non-blossom-v1 locators', async () => {
    const fetchBlob = vi.fn(async () => bytes);
    await expect(getAttachmentCiphertext(att([{ kind: 'marmot-cache-v1', value: `https://blossom.band/${hash}` }]), 1024, fetchBlob)).rejects.toBeInstanceOf(BlossomOriginError);
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it('falls through an untrusted locator and a hash-mismatching response to the next good locator', async () => {
    const fetchBlob = vi.fn(async (url: string) => (url.endsWith('/bad') ? new Uint8Array([1]) : bytes));
    const out = await getAttachmentCiphertext(
      att([blossom(`https://evil.example/${hash}`), blossom('https://blossom.band/bad'), blossom(`https://blossom.band/${hash}`)]),
      1024,
      fetchBlob,
    );
    expect(out).toEqual(bytes);
    expect(fetchBlob.mock.calls.map((c) => c[0])).toEqual(['https://blossom.band/bad', `https://blossom.band/${hash}`]);
  });

  it('rejects bytes that are not the content address even from a trusted origin (never returns them)', async () => {
    const fetchBlob = vi.fn(async () => new Uint8Array([1, 2, 3]));
    await expect(getAttachmentCiphertext(att([blossom(`https://blossom.band/${hash}`)]), 1024, fetchBlob)).rejects.toBeInstanceOf(BlossomUploadError);
  });

  it('reports not-found when every tried locator was missing', async () => {
    const fetchBlob = vi.fn(async () => {
      throw new BlossomNotFoundError(hash);
    });
    await expect(getAttachmentCiphertext(att([blossom(`https://blossom.band/${hash}`)]), 1024, fetchBlob)).rejects.toBeInstanceOf(BlossomNotFoundError);
  });

  it('with no locator at all fails loudly', async () => {
    await expect(getAttachmentCiphertext(att([]), 1024, vi.fn())).rejects.toBeInstanceOf(BlossomOriginError);
  });
});

describe('blossomMediaPorts', () => {
  it('names the operator server without a trailing slash as the locator server', () => {
    const ports = blossomMediaPorts({} as never);
    expect(ports.blossomServers).toEqual(groupBlossomServers());
    expect(ports.blossomServers.every((s) => !s.endsWith('/'))).toBe(true);
    expect(typeof ports.upload).toBe('function');
    expect(typeof ports.download).toBe('function');
  });
});

describe('getAttachmentCiphertext: bounded attempts', () => {
  it('tries at most 3 blossom-v1 locators of one attachment, each with the byte limit', async () => {
    const fetchBlob = vi.fn(async () => new Uint8Array([1]));
    const locators = ['a', 'b', 'c', 'd', 'e'].map((n) => blossom(`https://blossom.band/${n}`));
    await expect(getAttachmentCiphertext(att(locators), 777, fetchBlob)).rejects.toBeInstanceOf(BlossomUploadError);
    expect(MAX_LOCATORS_TRIED).toBe(3);
    expect(fetchBlob.mock.calls).toEqual([
      ['https://blossom.band/a', 777],
      ['https://blossom.band/b', 777],
      ['https://blossom.band/c', 777],
    ]);
  });

  it('locators off the allowlist cost no request and do not use up the 3 tries', async () => {
    const fetchBlob = vi.fn(async () => bytes);
    const out = await getAttachmentCiphertext(
      att([blossom(`https://evil.example/1`), blossom(`https://evil.example/2`), blossom(`https://evil.example/3`), blossom(`https://blossom.band/${hash}`)]),
      1024,
      fetchBlob,
    );
    expect(out).toEqual(bytes);
    expect(fetchBlob).toHaveBeenCalledTimes(1);
  });

  it('bytes over the limit are never returned, even from a port that ignores the limit', async () => {
    const fetchBlob = vi.fn(async () => bytes);
    await expect(getAttachmentCiphertext(att([blossom(`https://blossom.band/${hash}`)]), 2, fetchBlob)).rejects.toBeInstanceOf(BlossomTooLargeError);
  });
});

describe('get: bounded, streamed, time-limited download', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const URL_OK = 'https://blossom.band/' + 'a'.repeat(64);

  /** A response whose body is a hand-driven reader, so what was (not) read is observable. */
  function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}, stallAfter = Infinity) {
    const reads = { count: 0, cancelled: 0 };
    const response = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(headers),
      body: {
        cancel: async () => void reads.cancelled++,
        getReader: () => ({
          read: () => {
            if (reads.count >= stallAfter) return new Promise<never>(() => undefined);
            const i = reads.count++;
            return Promise.resolve(i < chunks.length ? { done: false, value: chunks[i] } : { done: true, value: undefined });
          },
          cancel: async () => void reads.cancelled++,
        }),
      },
    };
    return { response, reads };
  }

  it('rejects a Content-Length over the limit without reading the body', async () => {
    const { response, reads } = streamed([new Uint8Array(10)], { 'content-length': '5000' });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(get(URL_OK, 100)).rejects.toBeInstanceOf(BlossomTooLargeError);
    expect(reads.count).toBe(0);
    expect(reads.cancelled).toBeGreaterThan(0);
  });

  it('aborts a streamed body as soon as it exceeds the limit (does not read the rest)', async () => {
    const chunks = Array.from({ length: 50 }, () => new Uint8Array(10));
    const { response, reads } = streamed(chunks); // no Content-Length: a lying / chunked server
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(get(URL_OK, 25)).rejects.toBeInstanceOf(BlossomTooLargeError);
    expect(reads.count).toBe(3);
    expect(reads.cancelled).toBeGreaterThan(0);
  });

  it('returns the concatenated body when within the limit', async () => {
    const { response } = streamed([new Uint8Array([1, 2]), new Uint8Array([3])]);
    vi.stubGlobal('fetch', vi.fn(async () => response));
    expect(await get(URL_OK, 100)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('a body that stalls after the headers times out (the timer stays armed until the body is read)', async () => {
    vi.useFakeTimers();
    const { response } = streamed([new Uint8Array(4)], {}, 1);
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const result = get(URL_OK, 100).then(() => 'resolved', (e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBeInstanceOf(BlossomTimeoutError);
  });

  it('follows redirects (redirect:"error" would break CDN-redirecting servers); the final-origin check is covered in blossomClient.test.ts', async () => {
    const { response } = streamed([new Uint8Array([1])]);
    const fetchStub = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchStub);
    await get(URL_OK, 100);
    expect((fetchStub.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).not.toBe('error');
  });
});
