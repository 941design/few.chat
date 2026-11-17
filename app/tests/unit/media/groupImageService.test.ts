import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGroupImageService,
  extractGroupAttachmentsByRole,
  groupAttachmentFingerprint,
  GroupMediaError,
  GROUP_IMAGE_MEDIA_TYPES,
  MAX_GROUP_IMAGE_BYTES,
  MAX_GROUP_IMAGE_CIPHERTEXT_BYTES,
  MAX_GROUP_THUMB_BYTES,
  MAX_GROUP_THUMB_CIPHERTEXT_BYTES,
  type GroupMediaGroup,
} from '@/src/lib/media/imageMessage';
import { createGroupRumorSender, createOwnRowTracker } from '@/src/lib/marmot/send';
import { fakeEncrypt, fakeMediaGroup, makeTag, memoryCache, sha256Hex, SERVER } from './groupMediaFixtures';

const OWN = 'ab'.repeat(32);
const FULL = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const THUMB = new Uint8Array([9, 9, 9]);

function setup(over: { upload?: (c: Uint8Array) => Promise<string>; download?: (a: never) => Promise<Uint8Array>; warn?: () => void; cache?: ReturnType<typeof memoryCache> } = {}) {
  const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
  const sender = createGroupRumorSender({ ownPubkey: OWN, tracker });
  const uploads: Uint8Array[] = [];
  const store = new Map<string, Uint8Array>();
  const cache = over.cache ?? memoryCache();
  const upload =
    over.upload ??
    (async (c: Uint8Array) => {
      uploads.push(c);
      const h = sha256Hex(c);
      store.set(h, c);
      return `${SERVER}/${h}`;
    });
  const download = vi.fn(over.download ?? (async (a: { ciphertextSha256: string }) => store.get(a.ciphertextSha256)!));
  const warn = vi.fn(over.warn);
  const service = createGroupImageService({ sender, upload, download: download as never, cache, blossomServers: [`${SERVER}/`], warn });
  return { service, uploads, store, cache, download, warn, tracker };
}

describe('createGroupImageService: required ports are validated at construction', () => {
  const ok = () => {
    const s = setup();
    return { sender: createGroupRumorSender({ ownPubkey: OWN, tracker: s.tracker }), upload: async () => '', download: async () => new Uint8Array(), cache: memoryCache(), blossomServers: [SERVER] };
  };
  it.each(['sender', 'upload', 'download', 'cache', 'blossomServers'] as const)('throws without %s', (name) => {
    const deps: Record<string, unknown> = ok();
    delete deps[name];
    expect(() => createGroupImageService(deps as never)).toThrow(TypeError);
  });
  it('throws on an empty server list and on a partial cache port', () => {
    expect(() => createGroupImageService({ ...ok(), blossomServers: [] })).toThrow(TypeError);
    expect(() => createGroupImageService({ ...ok(), cache: { getBlob: async () => null } as never })).toThrow(TypeError);
    expect(() => createGroupImageService(undefined as never)).toThrow(TypeError);
  });
});

describe('AC-MEDIA-1 sendImage', () => {
  it('encrypts both blobs through group.encryptMedia with the Blossom server and the image metadata', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    await t.service.sendImage(g.group, { caption: 'hi', full: { bytes: FULL, dim: '800x600', thumbhash: 'th' }, thumb: { bytes: THUMB, dim: '80x60' }, baseName: 'cat' });
    expect(g.encryptCalls).toHaveLength(2);
    expect(g.encryptCalls[0].bytes).toBe(FULL);
    expect(g.encryptCalls[0].options).toMatchObject({ mediaType: 'image/webp', filename: 'cat.webp', dim: '800x600', thumbhash: 'th', blossomServers: [SERVER] });
    expect(g.encryptCalls[1].options).toMatchObject({ filename: 'cat.thumb.webp', dim: '80x60' });
    expect(g.encryptCalls[1].options.thumbhash).toBeUndefined();
  });

  it('uploads only the ciphertext: no uploaded byte sequence equals or contains the plaintext', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    expect(t.uploads).toHaveLength(2);
    expect(t.uploads[0]).toEqual(fakeEncrypt(FULL));
    expect(t.uploads[0]).not.toEqual(FULL);
    expect(Buffer.from(t.uploads[0]).includes(Buffer.from(FULL))).toBe(false);
    expect(t.uploads[1]).toEqual(fakeEncrypt(THUMB));
  });

  it('sends ONE kind-9 rumor via the sender whose imeta tags are the library metadata plus a role, and no plaintext', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    const out = await t.service.sendImage(g.group, { caption: 'the caption', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    expect(g.sent).toHaveLength(1);
    const rumor = (g.sent[0] as { rumor: { kind: number; pubkey: string; content: string; tags: string[][]; id: string } }).rumor;
    expect(rumor.kind).toBe(9);
    expect(rumor.pubkey).toBe(OWN);
    expect(JSON.parse(rumor.content)).toEqual({ type: 'image', version: 1, caption: 'the caption' });
    expect(out.rumorId).toBe(rumor.id);
    const roled = extractGroupAttachmentsByRole(rumor.tags);
    expect(roled.full!.attachment.ciphertextSha256).toBe(sha256Hex(t.uploads[0]));
    expect(roled.full!.attachment.plaintextSha256).toBe(sha256Hex(FULL));
    expect(roled.thumb!.attachment.ciphertextSha256).toBe(sha256Hex(t.uploads[1]));
    expect(roled.full!.attachment.locators[0].value).toBe(`${SERVER}/${sha256Hex(t.uploads[0])}`);
    expect(JSON.stringify(rumor)).not.toContain(Buffer.from(FULL).toString('hex'));
    expect(JSON.stringify(rumor)).not.toContain(Buffer.from(FULL).toString('base64'));
  });

  it('reports progress 0..100 across both uploads', async () => {
    const t = setup();
    const seen: number[] = [];
    await t.service.sendImage(fakeMediaGroup().group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB }, onProgress: (p) => seen.push(p) });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(100);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('caches the plaintext of both blobs under the group, keyed by the attachment fingerprint, with a message ref', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    const out = await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    expect(t.cache.blobs.size).toBe(2);
    expect([...t.cache.blobs.values()].map((b) => b.bytes)).toEqual(expect.arrayContaining([FULL, THUMB]));
    expect([...t.cache.refs.values()].every((set) => set.has(out.rumorId))).toBe(true);
  });

  it('a failing upload rejects and nothing is sent', async () => {
    const t = setup({ upload: async () => { throw new Error('blossom down'); } });
    const g = fakeMediaGroup();
    await expect(t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toThrow('blossom down');
    expect(g.sent).toHaveLength(0);
  });

  it('a failing thumb upload after a good full upload still sends nothing', async () => {
    let n = 0;
    const t = setup({ upload: async (c) => { if (++n === 2) throw new Error('thumb failed'); return `${SERVER}/${sha256Hex(c)}`; } });
    const g = fakeMediaGroup();
    await expect(t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toThrow('thumb failed');
    expect(g.sent).toHaveLength(0);
  });

  it('refuses to upload when the library hands back the plaintext as the "ciphertext"', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    g.group.encryptMedia = async (bytes: Uint8Array) => ({ ciphertext: bytes, imeta: [makeTag()], locator: sha256Hex(bytes) });
    await expect(t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toMatchObject({ code: 'plaintext-upload-refused' });
    expect(t.uploads).toHaveLength(0);
  });

  it('refuses an empty ciphertext', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    g.group.encryptMedia = async () => ({ ciphertext: new Uint8Array(), imeta: [makeTag()], locator: '' });
    await expect(t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toBeInstanceOf(GroupMediaError);
  });

  it('an imeta no receiver could render (http server) fails BEFORE any upload', async () => {
    const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
    const uploads: Uint8Array[] = [];
    const service = createGroupImageService({
      sender: createGroupRumorSender({ ownPubkey: OWN, tracker }),
      upload: async (c) => { uploads.push(c); return 'x'; },
      download: async () => new Uint8Array(),
      cache: memoryCache(),
      blossomServers: ['http://blossom.local'],
    });
    await expect(service.sendImage(fakeMediaGroup().group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toThrow(/https/);
    expect(uploads).toHaveLength(0);
  });

  it('a server that stored another blob than the locator names is refused (nothing sent)', async () => {
    const t = setup({ upload: async () => `${SERVER}/${'0'.repeat(64)}` });
    const g = fakeMediaGroup();
    await expect(t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toMatchObject({ code: 'bad-upload' });
    expect(g.sent).toHaveLength(0);
  });

  it('accepts a server URL with a file extension on the content address', async () => {
    const t = setup({ upload: async (c) => `${SERVER}/${sha256Hex(c)}.webp` });
    await expect(t.service.sendImage(fakeMediaGroup().group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).resolves.toBeDefined();
  });

  it('a failing send rejects with the sender error, and the cache is not written', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    g.group.send = async () => { throw new Error('publish failed'); };
    await expect(t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toThrow('publish failed');
    expect(t.cache.blobs.size).toBe(0);
  });

  it('a cache failure after the publish does NOT fail the send (a retry would duplicate the message); it is reported', async () => {
    const cache = memoryCache();
    cache.setBlob = async () => { throw new Error('idb full'); };
    const t = setup({ cache });
    const out = await t.service.sendImage(fakeMediaGroup().group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    expect(out.rumorId).toMatch(/^[0-9a-f]{64}$/);
    expect(t.warn).toHaveBeenCalledOnce();
  });
});

describe('AC-MEDIA-1 loadImage', () => {
  async function sent() {
    const t = setup();
    const g = fakeMediaGroup();
    const out = await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    t.cache.blobs.clear(); // receiver side: nothing cached
    return { t, g, out };
  }

  it('downloads the ciphertext, decrypts through group.decryptMedia and returns the sent bytes', async () => {
    const { t, g, out } = await sent();
    const img = await t.service.loadImage(g.group, { imeta: out.full.imeta });
    expect(img.bytes).toEqual(FULL);
    expect(img.type).toBe('image/webp');
    expect(g.decryptCalls).toHaveLength(1);
    expect(g.decryptCalls[0].imeta).toEqual([out.full.imeta]);
    expect(g.decryptCalls[0].ciphertext).toEqual(fakeEncrypt(FULL));
    expect(g.decryptCalls[0].locator).toBe(out.full.attachment.ciphertextSha256);
  });

  it('caches the plaintext and records the carrying message', async () => {
    const { t, g, out } = await sent();
    await t.service.loadImage(g.group, { imeta: out.full.imeta, messageId: 'm1' });
    expect(t.cache.blobs.size).toBe(1);
    expect([...t.cache.refs.values()][0].has('m1')).toBe(true);
  });

  it('concurrent loads of one attachment share ONE download and ONE decrypt', async () => {
    const { t, g, out } = await sent();
    const ref = { imeta: out.full.imeta };
    const [a, b, c] = await Promise.all([t.service.loadImage(g.group, ref), t.service.loadImage(g.group, ref), t.service.loadImage(g.group, ref)]);
    expect([a.bytes, b.bytes, c.bytes]).toEqual([FULL, FULL, FULL]);
    expect(g.decryptCalls).toHaveLength(1);
    expect(t.download).toHaveBeenCalledTimes(1);
  });

  it('a failed decrypt is not cached and a later load retries', async () => {
    const { t, g, out } = await sent();
    const real = g.group.decryptMedia.bind(g.group);
    let fail = true;
    g.group.decryptMedia = async (m) => { if (fail) { fail = false; throw new Error('undecryptable'); } return real(m); };
    const ref = { imeta: out.full.imeta };
    await expect(t.service.loadImage(g.group, ref)).rejects.toThrow('undecryptable');
    expect(t.cache.blobs.size).toBe(0);
    await expect(t.service.loadImage(g.group, ref)).resolves.toMatchObject({ bytes: FULL });
  });

  it('a failed download is surfaced and decryptMedia is never called', async () => {
    const { t, g, out } = await sent();
    t.download.mockRejectedValueOnce(new Error('404'));
    await expect(t.service.loadImage(g.group, { imeta: out.full.imeta })).rejects.toThrow('404');
    expect(g.decryptCalls).toHaveLength(0);
  });

  it('a cache write failure still returns the decrypted image (reported, not thrown)', async () => {
    const { t, g, out } = await sent();
    t.cache.setBlob = async () => { throw new Error('quota'); };
    await expect(t.service.loadImage(g.group, { imeta: out.full.imeta })).resolves.toMatchObject({ bytes: FULL });
    expect(t.warn).toHaveBeenCalled();
  });

  it('hostile input: a non-image attachment is refused before any request', async () => {
    const { t, g } = await sent();
    const evil = extractGroupAttachmentsByRole([makeTag({ mediaType: 'text/html' }, ['role full'])]).full!;
    await expect(t.service.loadImage(g.group, { imeta: evil.imeta })).rejects.toMatchObject({ code: 'unsupported-media-type' });
    expect(t.download).not.toHaveBeenCalled();
  });

  it('hostile input: an oversized ciphertext is refused before decrypting', async () => {
    const { t, g, out } = await sent();
    t.download.mockResolvedValueOnce(new Uint8Array(6 * 1024 * 1024));
    await expect(t.service.loadImage(g.group, { imeta: out.full.imeta })).rejects.toMatchObject({ code: 'too-large' });
    expect(g.decryptCalls).toHaveLength(0);
  });

  it('hostile input: a forged record (same ciphertext hash, other nonce) does not hit the honest record\'s cache slot', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    const out = await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } }); // sender cached it
    const forged = extractGroupAttachmentsByRole([makeTag({ ciphertextSha256: out.full.attachment.ciphertextSha256, plaintextSha256: out.full.attachment.plaintextSha256, nonce: 'f'.repeat(24), locators: out.full.attachment.locators }, ['role full'])]).full!;
    await t.service.loadImage(g.group, { imeta: forged.imeta });
    expect(g.decryptCalls).toHaveLength(1); // fell through to decrypt (where the AEAD would reject it)
  });
});

describe('AC-MEDIA-2 cache hit', () => {
  it('serves a cached image without downloading and without calling decryptMedia', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    const out = await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    const hit = await t.service.loadImage(g.group, { imeta: out.full.imeta, messageId: 'again' });
    expect(hit.bytes).toEqual(FULL);
    expect(g.decryptCalls).toHaveLength(0);
    expect(t.download).not.toHaveBeenCalled();
    expect([...t.cache.refs.values()].some((s) => s.has('again'))).toBe(true);
  });

  it('is keyed per group: another group with the same attachment decrypts itself', async () => {
    const t = setup();
    const g1 = fakeMediaGroup('1'.repeat(64));
    const g2 = fakeMediaGroup('2'.repeat(64));
    const out = await t.service.sendImage(g1.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    await t.service.loadImage(g2.group, { imeta: out.full.imeta });
    expect(g2.decryptCalls).toHaveLength(1);
  });
});

describe('receive hardening: bounded loads', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  async function sent() {
    const t = setup();
    const g = fakeMediaGroup();
    const out = await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    t.cache.blobs.clear();
    t.download.mockClear();
    return { t, g, out };
  }

  it('hands the download port the full-image ciphertext cap for a full image and a smaller one for a thumb', async () => {
    const { t, g, out } = await sent();
    await t.service.loadImage(g.group, { imeta: out.full.imeta });
    await t.service.loadImage(g.group, { imeta: out.thumb.imeta });
    expect(t.download.mock.calls.map((c) => (c as unknown as [unknown, number])[1])).toEqual([MAX_GROUP_IMAGE_CIPHERTEXT_BYTES, MAX_GROUP_THUMB_CIPHERTEXT_BYTES]);
    expect(MAX_GROUP_THUMB_CIPHERTEXT_BYTES).toBeLessThan(MAX_GROUP_IMAGE_CIPHERTEXT_BYTES);
  });

  it('a thumb ciphertext over the thumb cap is refused even though it is under the full-image cap', async () => {
    const { t, g, out } = await sent();
    t.download.mockResolvedValueOnce(new Uint8Array(MAX_GROUP_THUMB_CIPHERTEXT_BYTES + 1));
    await expect(t.service.loadImage(g.group, { imeta: out.thumb.imeta })).rejects.toMatchObject({ code: 'too-large' });
    expect(g.decryptCalls).toHaveLength(0);
  });

  it('a hung download times out, rejects, and does not wedge the in-flight slot', async () => {
    vi.useFakeTimers();
    const { t, g, out } = await sent();
    t.download.mockImplementationOnce(() => new Promise<never>(() => undefined));
    const first = t.service.loadImage(g.group, { imeta: out.full.imeta }).then(() => 'resolved', (e) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await first).toMatchObject({ code: 'load-timeout' });
    // the slot is free: a later load downloads again and succeeds
    await expect(t.service.loadImage(g.group, { imeta: out.full.imeta })).resolves.toMatchObject({ bytes: FULL });
    expect(t.download).toHaveBeenCalledTimes(2);
  });
});

describe('media type allowlist (raster only)', () => {
  const svgTag = () => makeTag({ mediaType: 'image/svg+xml' }, ['role full']);

  it('receive, cache miss: image/svg+xml is refused before any request', async () => {
    const t = setup();
    await expect(t.service.loadImage(fakeMediaGroup().group, { imeta: svgTag() })).rejects.toMatchObject({ code: 'unsupported-media-type' });
    expect(t.download).not.toHaveBeenCalled();
  });

  it('receive, cache hit: an svg record is refused even when a blob sits in its cache slot', async () => {
    const t = setup();
    const att = extractGroupAttachmentsByRole([svgTag()]).full!.attachment;
    t.cache.blobs.set(`${fakeMediaGroup().group.id}:${groupAttachmentFingerprint(att)}`, { bytes: new Uint8Array([1]), type: 'image/svg+xml' });
    await expect(t.service.loadImage(fakeMediaGroup().group, { imeta: svgTag() })).rejects.toMatchObject({ code: 'unsupported-media-type' });
  });

  it('send: image/svg+xml is refused before anything is encrypted or uploaded', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    await expect(t.service.sendImage(g.group, { caption: '', mediaType: 'image/svg+xml', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toMatchObject({ code: 'unsupported-media-type' });
    expect(g.encryptCalls).toHaveLength(0);
    expect(t.uploads).toHaveLength(0);
  });

  it('send: a library tag whose media type is outside the allowlist is refused before the upload', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    const real = g.group.encryptMedia.bind(g.group);
    g.group.encryptMedia = async (bytes, options) => real(bytes, { ...options, mediaType: 'image/svg+xml' });
    await expect(t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toMatchObject({ code: 'unsupported-media-type' });
    expect(t.uploads).toHaveLength(0);
  });

  it.each(GROUP_IMAGE_MEDIA_TYPES)('%s is accepted on receive', async (mediaType) => {
    const t = setup({ download: async () => fakeEncrypt(FULL) });
    const imeta = makeTag({ mediaType }, ['role full']);
    await expect(t.service.loadImage(fakeMediaGroup().group, { imeta })).resolves.toMatchObject({ bytes: FULL, type: mediaType });
  });

  it('the allowlist is exactly the four raster types', () => {
    expect([...GROUP_IMAGE_MEDIA_TYPES].sort()).toEqual(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  });
});

describe('loadImage derives the attachment from the imeta tag', () => {
  it('rejects (asynchronously, never a synchronous throw) a ref whose imeta is missing or not a valid attachment', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    for (const ref of [{}, { imeta: ['imeta', 'url x'] }, { imeta: makeTag({ ciphertextSha256: 'zz' }) }, null, undefined] as never[]) {
      let promise!: Promise<unknown>;
      expect(() => { promise = t.service.loadImage(g.group, ref); }).not.toThrow();
      await expect(promise).rejects.toMatchObject({ code: 'invalid-attachment' });
    }
    expect(t.download).not.toHaveBeenCalled();
  });

  it('a mis-paired ref (an honest record next to another record\'s tag) cannot cache one record\'s plaintext under another\'s fingerprint', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    const out = await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    t.cache.blobs.clear();
    // imeta of record B (the thumb), with record A (the full image) smuggled in as a separate "attachment"
    const mispaired = { attachment: out.full.attachment, imeta: out.thumb.imeta } as never;
    const img = await t.service.loadImage(g.group, mispaired);
    expect(img.bytes).toEqual(THUMB);
    const keys = [...t.cache.blobs.keys()];
    expect(keys).toEqual([`${g.group.id}:${groupAttachmentFingerprint(out.thumb.attachment)}`]);
    expect(keys[0]).not.toContain(out.full.attachment.nonce);
  });

  it('on an in-flight hit the second caller\'s message is recorded too, once the shared load settles', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    const out = await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    t.cache.blobs.clear();
    t.cache.refs.clear();
    await Promise.all([
      t.service.loadImage(g.group, { imeta: out.full.imeta, messageId: 'm1' }),
      t.service.loadImage(g.group, { imeta: out.full.imeta, messageId: 'm2' }),
    ]);
    expect(g.decryptCalls).toHaveLength(1);
    expect([...[...t.cache.refs.values()][0]].sort()).toEqual(['m1', 'm2']);
  });
});

describe('sendImage validates up front', () => {
  it('refuses a full image over the output cap before encrypting anything', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    await expect(t.service.sendImage(g.group, { caption: '', full: { bytes: new Uint8Array(MAX_GROUP_IMAGE_BYTES + 1) }, thumb: { bytes: THUMB } })).rejects.toMatchObject({ code: 'too-large' });
    expect(g.encryptCalls).toHaveLength(0);
  });

  it('refuses a thumbnail over the thumb cap before encrypting anything', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    await expect(t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: new Uint8Array(MAX_GROUP_THUMB_BYTES + 1) } })).rejects.toMatchObject({ code: 'too-large' });
    expect(g.encryptCalls).toHaveLength(0);
  });

  it('caches under the canonical media type of the library attachment, not the caller-supplied string', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    const real = g.group.encryptMedia.bind(g.group);
    g.group.encryptMedia = async (bytes, options) => real(bytes, { ...options, mediaType: 'image/jpeg' });
    await t.service.sendImage(g.group, { caption: '', mediaType: 'image/png', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    expect([...t.cache.blobs.values()].map((b) => b.type)).toEqual(['image/jpeg', 'image/jpeg']);
  });
});

describe('origin binding of the upload response', () => {
  it('a server that answers with the right hash on ANOTHER origin than the locator is refused (nothing sent)', async () => {
    const t = setup({ upload: async (c) => `https://elsewhere.example/${sha256Hex(c)}` });
    const g = fakeMediaGroup();
    await expect(t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toMatchObject({ code: 'bad-upload' });
    expect(g.sent).toHaveLength(0);
  });
});

describe('epoch race between encryption and send', () => {
  function epochGroup(advanceOn: (encryptCalls: number) => boolean) {
    const g = fakeMediaGroup();
    let epoch = 5n;
    let lastSeenCalls = 0;
    Object.defineProperty(g.group, 'epoch', {
      get() {
        // a commit lands whenever the predicate says so, observed on the first read after an encrypt round
        if (g.encryptCalls.length !== lastSeenCalls && advanceOn(g.encryptCalls.length)) epoch += 1n;
        lastSeenCalls = g.encryptCalls.length;
        return epoch;
      },
    });
    return g;
  }

  it('re-encrypts and re-uploads once when the epoch advanced, then sends the second round\'s tags', async () => {
    const t = setup();
    // read #1 (pre-encrypt, 0 calls) -> no advance; the read after round 1 (2 calls) advances; the read after round 2 (4 calls) does not
    const g = epochGroup((calls) => calls === 2);
    const out = await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    expect(g.encryptCalls).toHaveLength(4);
    expect(t.uploads).toHaveLength(4);
    expect(g.sent).toHaveLength(1);
    expect(out.full.attachment.ciphertextSha256).toBe(sha256Hex(t.uploads[2]));
  });

  it('fails with a retryable epoch-advanced error (nothing sent) when the epoch keeps moving', async () => {
    const t = setup();
    const g = epochGroup(() => true);
    await expect(t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toMatchObject({ code: 'epoch-advanced' });
    expect(g.sent).toHaveLength(0);
    expect(g.encryptCalls).toHaveLength(4);
  });

  it('a stable epoch costs no extra encryption', async () => {
    const t = setup();
    const g = epochGroup(() => false);
    await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    expect(g.encryptCalls).toHaveLength(2);
  });
});

describe('S7 review fixes', () => {
  const roleSwap = (tag: string[], role: string) => tag.map((p) => (p === 'role full' ? `role ${role}` : p));

  it('a thumb-role load cannot impose its cap on a concurrent full-role load of the same ciphertext', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    const out = await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    t.cache.blobs.clear();
    t.download.mockClear();
    const asThumb = roleSwap(out.full.imeta, 'thumb');
    await Promise.all([t.service.loadImage(g.group, { imeta: asThumb }), t.service.loadImage(g.group, { imeta: out.full.imeta })]);
    const caps = t.download.mock.calls.map((c) => (c as unknown[])[1]).sort();
    expect(caps).toEqual([MAX_GROUP_THUMB_CIPHERTEXT_BYTES, MAX_GROUP_IMAGE_CIPHERTEXT_BYTES].sort());
  });

  it('extraction and loading classify a tag with several role fields identically (first wins)', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    const out = await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    t.cache.blobs.clear();
    t.download.mockClear();
    const tag = [...out.full.imeta.filter((p) => p !== 'role full'), 'role full', 'role thumb'];
    expect(extractGroupAttachmentsByRole([tag]).full).not.toBeNull();
    await t.service.loadImage(g.group, { imeta: tag });
    expect((t.download.mock.calls[0] as unknown[])[1]).toBe(MAX_GROUP_IMAGE_CIPHERTEXT_BYTES);
  });

  it.each(['image/jpg', 'IMAGE/JPEG', ' image/jpg '])('sendImage accepts the %s spelling and encrypts it as image/jpeg', async (spelling) => {
    const t = setup();
    const g = fakeMediaGroup();
    const out = await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB }, mediaType: spelling });
    expect(g.encryptCalls[0].options.mediaType).toBe('image/jpeg');
    expect(out.full.attachment.mediaType).toBe('image/jpeg');
  });

  it('progress stays monotonic and reaches 100 once when an epoch retry re-runs both uploads', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    let epoch = 5n;
    Object.defineProperty(g.group, 'epoch', {
      get() {
        // a commit lands once, observed on the first read after round one (2 encrypts)
        if (g.encryptCalls.length === 2) epoch = 6n;
        return epoch;
      },
    });
    const seen: number[] = [];
    await t.service.sendImage(g.group, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB }, onProgress: (p) => seen.push(p) });
    expect(g.encryptCalls).toHaveLength(4);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.filter((p) => p === 100)).toHaveLength(1);
    expect(seen.filter((p) => p === 0)).toHaveLength(1);
  });

  it('epoch is a required member of the media group: a group without it is refused before any encryption', async () => {
    const t = setup();
    const g = fakeMediaGroup();
    const { epoch: _omit, ...withoutEpoch } = g.group;
    // @ts-expect-error GroupMediaGroup.epoch is required
    const bad: GroupMediaGroup = withoutEpoch;
    await expect(t.service.sendImage(bad, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } })).rejects.toBeInstanceOf(TypeError);
    expect(g.encryptCalls).toHaveLength(0);
  });
});
