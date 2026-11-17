/**
 * Shared fixtures for the group media unit tests: a library-shaped fake group whose "encryption" is a
 * real, reversible byte transform (so ciphertext differs from plaintext and round trips), and valid
 * encrypted-media-v1 imeta tags built with the library codec.
 */
import { encodeMediaImetaTag, type MediaAttachment } from '@941design/marmot-engine/core';
import { createHash } from 'node:crypto';

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const SERVER = 'https://blossom.band';

export function makeAttachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    version: 'encrypted-media-v1',
    locators: [{ kind: 'blossom-v1', value: `${SERVER}/${'c'.repeat(64)}` }],
    ciphertextSha256: 'c'.repeat(64),
    plaintextSha256: 'd'.repeat(64),
    nonce: 'e'.repeat(24),
    mediaType: 'image/webp',
    filename: 'photo.webp',
    dim: '800x600',
    ...overrides,
  };
}

export const makeTag = (overrides: Partial<MediaAttachment> = {}, extra: string[] = []): string[] => [
  ...encodeMediaImetaTag(makeAttachment(overrides)),
  ...extra,
];

/** Reversible transform standing in for the AEAD: output differs from input and carries a marker prefix. */
export function fakeEncrypt(plain: Uint8Array): Uint8Array {
  const out = new Uint8Array(plain.length + 4);
  out.set([0xfe, 0xed, 0xfa, 0xce]);
  for (let i = 0; i < plain.length; i++) out[i + 4] = plain[i] ^ 0xa5;
  return out;
}
export function fakeDecrypt(cipher: Uint8Array): Uint8Array {
  const out = new Uint8Array(cipher.length - 4);
  for (let i = 0; i < out.length; i++) out[i] = cipher[i + 4] ^ 0xa5;
  return out;
}

export interface EncryptCall {
  bytes: Uint8Array;
  options: { mediaType?: string; filename?: string; dim?: string; thumbhash?: string; blossomServers?: readonly string[] };
}

/** A group with the library's `encryptMedia` / `decryptMedia` shape; records calls. */
export function fakeMediaGroup(id = 'g'.repeat(64)) {
  const encryptCalls: EncryptCall[] = [];
  const decryptCalls: Array<{ ciphertext: Uint8Array; imeta: readonly (readonly string[])[]; locator: string }> = [];
  const sent: unknown[] = [];
  let nonceCounter = 0;
  const group = {
    id,
    epoch: 1n,
    send: async (intent: unknown) => {
      sent.push(intent);
    },
    pendingIntents: async () => [],
    async encryptMedia(bytes: Uint8Array, options: EncryptCall['options'] = {}) {
      encryptCalls.push({ bytes, options });
      const ciphertext = fakeEncrypt(bytes);
      const locator = sha256Hex(ciphertext);
      const servers = options.blossomServers ?? [];
      const attachment = makeAttachment({
        ciphertextSha256: locator,
        plaintextSha256: sha256Hex(bytes),
        nonce: (++nonceCounter).toString(16).padStart(24, '0'),
        mediaType: options.mediaType ?? 'application/octet-stream',
        filename: options.filename ?? 'media',
        locators: servers.map((s) => ({ kind: 'blossom-v1', value: `${s}/${locator}` })),
        ...(options.dim !== undefined ? { dim: options.dim } : {}),
        ...(options.thumbhash !== undefined ? { thumbhash: options.thumbhash } : {}),
      });
      return { ciphertext, imeta: [encodeMediaImetaTag(attachment)], locator };
    },
    async decryptMedia(media: { ciphertext: Uint8Array; imeta: readonly (readonly string[])[]; locator: string }) {
      decryptCalls.push(media);
      return fakeDecrypt(media.ciphertext);
    },
  };
  return { group, encryptCalls, decryptCalls, sent };
}

/** An in-memory cache port (counts reads). */
export function memoryCache() {
  const blobs = new Map<string, { bytes: Uint8Array; type: string }>();
  const refs = new Map<string, Set<string>>();
  return {
    blobs,
    refs,
    getBlob: async (g: string, f: string) => blobs.get(`${g}:${f}`) ?? null,
    setBlob: async (g: string, f: string, d: { bytes: Uint8Array; type: string }) => void blobs.set(`${g}:${f}`, d),
    addMessageRef: async (g: string, f: string, m: string) => void (refs.get(`${g}:${f}`) ?? refs.set(`${g}:${f}`, new Set()).get(`${g}:${f}`)!).add(m),
  };
}
