// @vitest-environment node
/**
 * Library harness for group media (S7): REAL @941design/marmot clients over createMemoryStorage() and a FakeRelay,
 * the app's real HistoryBackend (fixture handlers capture the kind-9 rumor), the app's real S6 sender, the real
 * Blossom client (`put` / `getAttachmentCiphertext`) against a fake Blossom reached through a stubbed `fetch`, and
 * the real decrypted cache (mediaPersistence over fake-indexeddb).
 *
 *  AC-MEDIA-1  Alice's image goes through group.encryptMedia; the Blossom server only ever holds ciphertext (!=
 *              plaintext, SHA-256 = the imeta locator); the published imeta carries the library metadata and not the
 *              plaintext; Bob's group.decryptMedia renders bytes equal to the sent bytes.
 *  AC-MEDIA-2  after Bob "reloads" (fresh service + fresh group handle over the same IndexedDB) the image is served
 *              from the decrypted cache with no decryptMedia and no download.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import type { MarmotGroup } from '@941design/marmot';
import { getPublicKey } from 'nostr-tools/pure';
import { createHash } from 'node:crypto';
import { bootstrapAccountClient, createClientTransport, type AccountClient } from '@/src/lib/marmot/client';
import { openAccountStores } from '@/src/lib/marmot/client/storage';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { createHistoryBackend, createIdbHistoryStore, type GroupHistoryHandlers } from '@/src/lib/marmot/history';
import { createGroupRumorSender, createOwnRowTracker, type GroupRumorSender } from '@/src/lib/marmot/send';
import { blossomMediaPorts } from '@/src/lib/media/blossomClient';
import { createGroupImageService, extractGroupAttachmentsByRole, groupAttachmentFingerprint, type GroupMediaGroup } from '@/src/lib/media/imageMessage';
import { clearAllMedia, getBlob, groupMediaCachePort } from '@/src/lib/marmot/mediaPersistence';
import { encodeMediaImetaTag } from '@941design/marmot-engine/core';

type NostrEvent = import('@941design/nostr-events/event').NostrEvent;
type Rumor = import('@941design/nostr-events/event').Rumor;

const SECRET_A = 'a1'.repeat(32);
const SECRET_B = 'b2'.repeat(32);
const pub = (hex: string) => getPublicKey(Uint8Array.from(Buffer.from(hex, 'hex')));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let relay: FakeRelay;
let relayUrl: string;
let dbCounter = 0;
const peers: Peer[] = [];

interface Peer {
  account: AccountClient;
  pubkey: string;
  secret: string;
  sender: GroupRumorSender;
  received: Map<string, Rumor>;
  group: (id: string) => Promise<MarmotGroup>;
  track: (g: MarmotGroup) => void;
}

async function startPeer(secret: string, label: string): Promise<Peer> {
  const backend = createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
  const pubkey = pub(secret);
  const received = new Map<string, Rumor>();
  const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
  const sender = createGroupRumorSender({ ownPubkey: pubkey, tracker });
  const handlers: GroupHistoryHandlers = {
    async dispatch({ groupId, rumor, sender: from, eventId }) {
      if (rumor.kind !== 9) return;
      received.set(rumor.id, rumor);
      if (from === pubkey) tracker.onOwnEcho(groupId, rumor.id, eventId);
    },
    async retract() {},
  };
  const history = createHistoryBackend({ handlers, store: createIdbHistoryStore(`media-harness-${label}-${++dbCounter}`) });
  const result = await bootstrapAccountClient({
    eventSigner: createPrivateKeySigner(secret),
    signerKind: 'local',
    relays: [relayUrl],
    history,
    clientEvents: {
      groupRemoved: () => undefined,
      inboxDisposition: () => undefined,
      welcomeDeclined: () => undefined,
      intentFailed: () => undefined,
      storeIncompatible: () => undefined,
      groupBranchSwitched: () => undefined,
    },
    inboxHandlers: { joinRequest: () => undefined, inviteContext: () => undefined },
    onGroupNotification: () => undefined,
    inboxRelayList: { ensure: async () => undefined },
    clientOptions: { historyTimeoutMs: 2000 },
    seams: {
      isSecureContext: () => true,
      openStores: (pk) => openAccountStores(pk, backend, { leaseTimeoutMs: 200 }),
      createTransport: (relays) => createClientTransport({ relays }),
    },
  });
  if (result.status !== 'ready') throw new Error(`bootstrap ${JSON.stringify(result)}`);
  const account = result.account;
  const groups = new Map<string, MarmotGroup>();
  const self: Peer = {
    account,
    pubkey,
    secret,
    sender,
    received,
    async group(id) {
      const cached = groups.get(id);
      if (cached) return cached;
      const found = await account.handle.client.groups.get(id);
      if (!found) throw new Error(`unknown group ${id}`);
      groups.set(id, found);
      return found;
    },
    track(g) {
      groups.set(g.id, g);
      account.attachGroup(g);
    },
  };
  peers.push(self);
  return self;
}

async function pairedGroup(a: Peer, b: Peer): Promise<string> {
  const g = await a.account.handle.client.groups.create('Media');
  a.track(g);
  const kp = await new Promise<NostrEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no key package observed')), 20_000);
    const stop = a.account.handle.client.keyPackages.observe(b.pubkey, (event) => {
      clearTimeout(timer);
      queueMicrotask(stop);
      resolve(event);
    });
  });
  await g.synced();
  const outcomes = await g.invite([kp]);
  expect(outcomes[0].status).toBe('delivered');
  await expect.poll(async () => (await b.account.handle.client.invitations.pending()).length, { timeout: 15_000 }).toBe(1);
  const pending = await b.account.handle.client.invitations.pending();
  const joined = await b.account.handle.client.invitations.accept(pending[0].id);
  b.track(joined);
  await g.synced();
  await joined.synced();
  return g.id;
}

/** A fake Blossom behind the stubbed global fetch: PUT /upload stores the body under its SHA-256, GET /<sha> serves it. */
function fakeBlossom() {
  const blobs = new Map<string, Uint8Array>();
  const puts: Uint8Array[] = [];
  const gets: string[] = [];
  let tamper = false;
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const origin = new URL(url).origin;
    if (init?.method === 'PUT') {
      const body = new Uint8Array(init.body as ArrayBuffer);
      puts.push(body);
      const h = sha256(body);
      blobs.set(h, body);
      return new Response(JSON.stringify({ url: `${origin}/${h}`, sha256: h }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    gets.push(url);
    const blob = blobs.get(new URL(url).pathname.slice(1));
    if (!blob) return new Response('nope', { status: 404 });
    const out = tamper ? Uint8Array.from(blob, (v, i) => (i === 40 ? v ^ 1 : v)) : blob;
    return new Response(out as unknown as BodyInit, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchStub);
  return { blobs, puts, gets, setTamper: (on: boolean) => void (tamper = on) };
}

function imageService(peer: Peer) {
  const ports = blossomMediaPorts(createPrivateKeySigner(peer.secret) as never);
  return createGroupImageService({ sender: peer.sender, ...ports, cache: groupMediaCachePort });
}

const FULL = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 256);
const THUMB = Uint8Array.from({ length: 512 }, (_, i) => (i * 17 + 3) % 256);

beforeEach(async () => {
  relay = new FakeRelay();
  relayUrl = await relay.start();
  await clearAllMedia();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const p of peers.splice(0)) await p.account.teardown().catch(() => undefined);
  await relay.stop();
});

describe('AC-MEDIA-1: image round trip over the library with a fake Blossom', () => {
  it('Blossom only holds ciphertext; the imeta carries the library metadata, not the plaintext; Bob decrypts the sent bytes', async () => {
    const blossom = fakeBlossom();
    const a = await startPeer(SECRET_A, 'a');
    const b = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(a, b);
    const ga = await a.group(groupId);

    const encrypt = vi.spyOn(ga, 'encryptMedia');
    const sent = await imageService(a).sendImage(ga as unknown as GroupMediaGroup, {
      caption: 'a cat',
      full: { bytes: FULL, dim: '64x64', thumbhash: 'abc' },
      thumb: { bytes: THUMB, dim: '8x8' },
      baseName: 'cat',
    });
    expect(encrypt).toHaveBeenCalledTimes(2);

    // Blossom saw exactly two uploads, both ciphertext
    expect(blossom.puts).toHaveLength(2);
    for (const [body, plain] of [[blossom.puts[0], FULL], [blossom.puts[1], THUMB]] as const) {
      expect(Buffer.from(body).equals(Buffer.from(plain))).toBe(false);
      expect(Buffer.from(body).includes(Buffer.from(plain.slice(0, 64)))).toBe(false);
      expect(body.length).toBeGreaterThan(plain.length); // AEAD tag
    }
    expect(sha256(blossom.puts[0])).toBe(sent.full.attachment.ciphertextSha256);
    expect(sha256(blossom.puts[1])).toBe(sent.thumb.attachment.ciphertextSha256);

    // Bob received the kind-9 rumor with the library's imeta tags
    await expect.poll(() => b.received.has(sent.rumorId), { timeout: 20_000 }).toBe(true);
    const rumor = b.received.get(sent.rumorId)!;
    expect(rumor.kind).toBe(9);
    const imetaTags = rumor.tags.filter((t) => t[0] === 'imeta');
    expect(imetaTags).toHaveLength(2);
    const roled = extractGroupAttachmentsByRole(rumor.tags);
    expect(roled.full!.attachment).toMatchObject({ version: 'encrypted-media-v1', mediaType: 'image/webp', filename: 'cat.webp', dim: '64x64', thumbhash: 'abc', plaintextSha256: sha256(FULL), ciphertextSha256: sha256(blossom.puts[0]) });
    expect(roled.thumb!.attachment).toMatchObject({ filename: 'cat.thumb.webp', plaintextSha256: sha256(THUMB) });
    expect(roled.full!.attachment.locators[0].kind).toBe('blossom-v1');
    const wire = JSON.stringify(rumor);
    for (const plain of [FULL, THUMB]) {
      expect(wire).not.toContain(Buffer.from(plain).toString('base64'));
      expect(wire).not.toContain(Buffer.from(plain).toString('hex'));
    }

    // Bob decrypts through the library: bytes in = bytes out. Both peers share this process's IndexedDB, so drop
    // Alice's sender-side cache first or Bob would be served from it.
    await clearAllMedia();
    const gb = await b.group(groupId);
    const decrypt = vi.spyOn(gb, 'decryptMedia');
    const full = await imageService(b).loadImage(gb, { imeta: roled.full!.imeta, messageId: rumor.id });
    expect(Buffer.from(full.bytes).equals(Buffer.from(FULL))).toBe(true);
    expect(full.type).toBe('image/webp');
    const thumb = await imageService(b).loadImage(gb, { imeta: roled.thumb!.imeta });
    expect(Buffer.from(thumb.bytes).equals(Buffer.from(THUMB))).toBe(true);
    expect(decrypt).toHaveBeenCalledTimes(2);
  }, 90_000);

  it('Blossom serving tampered bytes is rejected: no image, nothing cached', async () => {
    const blossom = fakeBlossom();
    const a = await startPeer(SECRET_A, 'a');
    const b = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(a, b);
    const sent = await imageService(a).sendImage((await a.group(groupId)) as unknown as GroupMediaGroup, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    await clearAllMedia(); // drop the sender-side cache: Bob must fetch
    blossom.setTamper(true);
    const gb = await b.group(groupId);
    const decrypt = vi.spyOn(gb, 'decryptMedia');
    await expect(imageService(b).loadImage(gb, { imeta: sent.full.imeta })).rejects.toThrow();
    expect(decrypt).not.toHaveBeenCalled();
    blossom.setTamper(false);
    await expect(imageService(b).loadImage(gb, { imeta: sent.full.imeta })).resolves.toMatchObject({ type: 'image/webp' });
  }, 90_000);
});

describe('AC-MEDIA-1 hostile records against the real library', () => {
  it('a record re-encoded with a changed nonce is rejected by decryptMedia and nothing is cached for it', async () => {
    fakeBlossom();
    const a = await startPeer(SECRET_A, 'a');
    const b = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(a, b);
    const sent = await imageService(a).sendImage((await a.group(groupId)) as unknown as GroupMediaGroup, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    await clearAllMedia(); // Bob must fetch and decrypt

    const forgedAttachment = { ...sent.full.attachment, nonce: '9'.repeat(24) };
    expect(forgedAttachment.nonce).not.toBe(sent.full.attachment.nonce);
    const forgedImeta = [...encodeMediaImetaTag(forgedAttachment), 'role full'];
    const forgedKey = groupAttachmentFingerprint(forgedAttachment);

    const gb = await b.group(groupId);
    await expect(imageService(b).loadImage(gb, { imeta: forgedImeta, messageId: 'forged' })).rejects.toThrow();
    expect(await getBlob(groupId, forgedKey)).toBeNull();
    expect(await getBlob(groupId, groupAttachmentFingerprint(sent.full.attachment))).toBeNull();

    // the honest record still decrypts: the failure was the forgery's, not the setup's
    const honest = await imageService(b).loadImage(gb, { imeta: sent.full.imeta });
    expect(Buffer.from(honest.bytes).equals(Buffer.from(FULL))).toBe(true);
  }, 90_000);
});

describe('AC-MEDIA-1 epoch race against the real library', () => {
  it('a commit between the full upload and the send makes the service re-encrypt under the new epoch; Bob decrypts the published image', async () => {
    const blossom = fakeBlossom();
    const a = await startPeer(SECRET_A, 'a');
    const b = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(a, b);
    const ga = await a.group(groupId);
    const epochBefore = ga.epoch;

    const ports = blossomMediaPorts(createPrivateKeySigner(SECRET_A) as never);
    let uploads = 0;
    const service = createGroupImageService({
      sender: a.sender,
      ...ports,
      upload: async (ciphertext) => {
        const url = await ports.upload(ciphertext);
        if (++uploads === 1) {
          await ga.rename('Renamed mid-send'); // a commit lands between the upload and the send
          await ga.synced();
        }
        return url;
      },
      cache: groupMediaCachePort,
    });
    const sent = await service.sendImage(ga as unknown as GroupMediaGroup, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });

    expect(ga.epoch).toBeGreaterThan(epochBefore);
    expect(blossom.puts).toHaveLength(4); // round 1 (superseded) + round 2
    expect(sent.full.attachment.ciphertextSha256).toBe(sha256(blossom.puts[2]));

    await expect.poll(() => b.received.has(sent.rumorId), { timeout: 20_000 }).toBe(true);
    await clearAllMedia();
    const gb = await b.group(groupId);
    const roled = extractGroupAttachmentsByRole(b.received.get(sent.rumorId)!.tags);
    const img = await imageService(b).loadImage(gb, { imeta: roled.full!.imeta });
    expect(Buffer.from(img.bytes).equals(Buffer.from(FULL))).toBe(true);
  }, 90_000);
});

describe('AC-MEDIA-2: the decrypted cache survives a reload', () => {
  it('after Bob reloads, the already-decrypted image is served with no decryptMedia and no Blossom request', async () => {
    const blossom = fakeBlossom();
    const a = await startPeer(SECRET_A, 'a');
    const b = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(a, b);
    const sent = await imageService(a).sendImage((await a.group(groupId)) as unknown as GroupMediaGroup, { caption: '', full: { bytes: FULL }, thumb: { bytes: THUMB } });
    await expect.poll(() => b.received.has(sent.rumorId), { timeout: 20_000 }).toBe(true);
    const roled = extractGroupAttachmentsByRole(b.received.get(sent.rumorId)!.tags);
    await clearAllMedia(); // Alice's sender-side cache is irrelevant here: Bob decrypts for real first

    const gb = await b.group(groupId);
    await imageService(b).loadImage(gb, { imeta: roled.full!.imeta, messageId: sent.rumorId });
    const getsBefore = blossom.gets.length;

    const reloadedGroup = await b.account.handle.client.groups.get(groupId); // a fresh handle lookup
    const decrypt = vi.spyOn(reloadedGroup!, 'decryptMedia');
    const again = await imageService(b).loadImage(reloadedGroup!, { imeta: roled.full!.imeta, messageId: sent.rumorId });
    expect(Buffer.from(again.bytes).equals(Buffer.from(FULL))).toBe(true);
    expect(decrypt).not.toHaveBeenCalled();
    expect(blossom.gets.length).toBe(getsBefore);
  }, 90_000);
});
