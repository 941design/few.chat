// @vitest-environment node
/**
 * AC-MEDIA-2: the decrypted-media cache (few-media-blobs / few-media-meta, the REAL mediaPersistence over
 * fake-indexeddb, not a mock) keeps serving an already-decrypted image after a reload without calling
 * decryptMedia again. A "reload" is a brand-new service instance (empty in-flight map, empty memory) over the
 * same IndexedDB, with a brand-new group handle whose decryptMedia is a spy.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupImageService, extractGroupAttachmentsByRole, groupAttachmentFingerprint } from '@/src/lib/media/imageMessage';
import { clearAllMedia, clearGroupMedia, getBlob, getMessageRefs, groupMediaCachePort } from '@/src/lib/marmot/mediaPersistence';
import { createGroupRumorSender, createOwnRowTracker } from '@/src/lib/marmot/send';
import { fakeMediaGroup, makeTag, sha256Hex, SERVER } from './groupMediaFixtures';

const OWN = 'ab'.repeat(32);
const PLAIN = new Uint8Array([5, 4, 3, 2, 1, 0, 255]);

function service(download: () => Promise<Uint8Array>) {
  const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
  return createGroupImageService({
    sender: createGroupRumorSender({ ownPubkey: OWN, tracker }),
    upload: async (c) => `${SERVER}/${sha256Hex(c)}`,
    download: download as never,
    cache: groupMediaCachePort,
    blossomServers: [SERVER],
  });
}

beforeEach(async () => {
  await clearAllMedia();
});

describe('AC-MEDIA-2 decrypted cache survives a reload', () => {
  it('receiver: first load decrypts once; after a reload the image is served from the cache with zero decrypt and zero download', async () => {
    const sender = fakeMediaGroup('a'.repeat(64));
    const blobs = new Map<string, Uint8Array>();
    const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
    const sending = createGroupImageService({
      sender: createGroupRumorSender({ ownPubkey: OWN, tracker }),
      upload: async (c) => { blobs.set(sha256Hex(c), c); return `${SERVER}/${sha256Hex(c)}`; },
      download: async () => new Uint8Array(),
      cache: { getBlob: async () => null, setBlob: async () => undefined, addMessageRef: async () => undefined },
      blossomServers: [SERVER],
    });
    const out = await sending.sendImage(sender.group, { caption: '', full: { bytes: PLAIN }, thumb: { bytes: new Uint8Array([1]) } });

    const reader = fakeMediaGroup('a'.repeat(64));
    const download = vi.fn(async () => blobs.get(out.full.attachment.ciphertextSha256)!);
    const first = await service(download).loadImage(reader.group, { imeta: out.full.imeta, messageId: 'm1' });
    expect(first.bytes).toEqual(PLAIN);
    expect(reader.decryptCalls).toHaveLength(1);

    // reload: fresh service, fresh group handle, same IndexedDB
    const reloaded = fakeMediaGroup('a'.repeat(64));
    const download2 = vi.fn(async () => { throw new Error('offline'); });
    const again = await service(download2).loadImage(reloaded.group, { imeta: out.full.imeta, messageId: 'm1' });
    expect(again.bytes).toEqual(PLAIN);
    expect(again.type).toBe('image/webp');
    expect(reloaded.decryptCalls).toHaveLength(0);
    expect(download2).not.toHaveBeenCalled();
  });

  it('sender: the plaintext cached at send time serves after a reload without any decrypt', async () => {
    const g = fakeMediaGroup('b'.repeat(64));
    const out = await service(async () => new Uint8Array()).sendImage(g.group, { caption: '', full: { bytes: PLAIN }, thumb: { bytes: new Uint8Array([7]) } });
    const stored = await getBlob('b'.repeat(64), groupAttachmentFingerprint({ ...out.full.attachment }));
    expect(stored?.bytes).toEqual(PLAIN);

    const reloaded = fakeMediaGroup('b'.repeat(64));
    const img = await service(async () => { throw new Error('no network'); }).loadImage(reloaded.group, { imeta: out.full.imeta });
    expect(img.bytes).toEqual(PLAIN);
    expect(reloaded.decryptCalls).toHaveLength(0);
  });

  it('records the message ref in few-media-meta', async () => {
    const g = fakeMediaGroup('c'.repeat(64));
    const out = await service(async () => new Uint8Array()).sendImage(g.group, { caption: '', full: { bytes: PLAIN }, thumb: { bytes: new Uint8Array([7]) } });
    expect(await getMessageRefs('c'.repeat(64), groupAttachmentFingerprint(out.full.attachment))).toEqual([out.rumorId]);
  });

  it('is a real cache, not a no-op: after the group media is cleared the next load must decrypt again', async () => {
    const g = fakeMediaGroup('d'.repeat(64));
    const blobs = new Map<string, Uint8Array>();
    const svc = createGroupImageService({
      sender: createGroupRumorSender({ ownPubkey: OWN, tracker: createOwnRowTracker({ ports: { setStatus: () => undefined } }) }),
      upload: async (c) => { blobs.set(sha256Hex(c), c); return `${SERVER}/${sha256Hex(c)}`; },
      download: (async (a: { ciphertextSha256: string }) => blobs.get(a.ciphertextSha256)!) as never,
      cache: groupMediaCachePort,
      blossomServers: [SERVER],
    });
    const out = await svc.sendImage(g.group, { caption: '', full: { bytes: PLAIN }, thumb: { bytes: new Uint8Array([7]) } });
    await clearGroupMedia('d'.repeat(64));
    const reader = fakeMediaGroup('d'.repeat(64));
    await svc.loadImage(reader.group, { imeta: out.full.imeta });
    expect(reader.decryptCalls).toHaveLength(1);
  });

  it('a forged record with a different nonce does not read the honest cached plaintext after a reload', async () => {
    const g = fakeMediaGroup('e'.repeat(64));
    const out = await service(async () => new Uint8Array()).sendImage(g.group, { caption: '', full: { bytes: PLAIN }, thumb: { bytes: new Uint8Array([7]) } });
    const forged = extractGroupAttachmentsByRole([
      makeTag({ ...out.full.attachment, nonce: '9'.repeat(24) }, ['role full']),
    ]).full!;
    const reloaded = fakeMediaGroup('e'.repeat(64));
    const download = vi.fn(async () => new Uint8Array([1, 2, 3, 4, 5]));
    const result = await service(download).loadImage(reloaded.group, { imeta: forged.imeta }).catch((e) => e);
    expect(result).not.toEqual(expect.objectContaining({ bytes: PLAIN }));
    expect(download).toHaveBeenCalledTimes(1); // went to fetch + decrypt, not the honest cache slot
  });
});
