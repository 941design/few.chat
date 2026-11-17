import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { unwrapGiftWrap } from '@/src/lib/marmot/welcomeSubscription';
import {
  loadUnexpiredOutboundJoinRequestsForAdmin,
  clearAllOutboundJoinRequests,
} from '@/src/lib/marmot/outboundJoinRequests';

const { buildJoinRequestRumor, buildGiftWrap, JOIN_REQUEST_RUMOR_KIND, sendJoinRequest } = await import(
  '@/src/lib/marmot/joinRequestSender'
);

function makeKeypair() {
  const priv = generateSecretKey();
  return { privHex: bytesToHex(priv), pubHex: getPublicKey(priv) };
}

describe('joinRequestSender', () => {
  describe('buildJoinRequestRumor', () => {
    it('creates a kind 21059 rumor', () => {
      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: 'aabb',
        adminPubkeyHex: 'ccdd',
        nonce: 'nonce123',
        groupName: 'Test Group',
      });

      expect(rumor.kind).toBe(21059);
      expect(rumor.kind).toBe(JOIN_REQUEST_RUMOR_KIND);
    });

    it('sets the requester pubkey as the event pubkey', () => {
      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: 'requester-pk',
        adminPubkeyHex: 'admin-pk',
        nonce: 'n1',
        groupName: 'G',
      });

      expect(rumor.pubkey).toBe('requester-pk');
    });

    it('includes a p-tag targeting the admin pubkey', () => {
      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: 'req',
        adminPubkeyHex: 'admin-hex',
        nonce: 'n1',
        groupName: 'G',
      });

      expect(rumor.tags).toEqual([['p', 'admin-hex']]);
    });

    it('encodes nonce and name in JSON content', () => {
      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: 'req',
        adminPubkeyHex: 'admin',
        nonce: 'my-nonce-value',
        groupName: 'Biology Study Group',
      });

      const parsed = JSON.parse(rumor.content);
      expect(parsed).toEqual({
        type: 'join_request',
        nonce: 'my-nonce-value',
        name: 'Biology Study Group',
      });
    });

    it('sets created_at to a recent unix timestamp', () => {
      const before = Math.floor(Date.now() / 1000) - 1;
      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: 'req',
        adminPubkeyHex: 'admin',
        nonce: 'n',
        groupName: 'G',
      });
      const after = Math.floor(Date.now() / 1000) + 1;

      expect(rumor.created_at).toBeGreaterThanOrEqual(before);
      expect(rumor.created_at).toBeLessThanOrEqual(after);
    });

    it('always sets type to "join_request" in content', () => {
      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: 'req',
        adminPubkeyHex: 'admin',
        nonce: 'n',
        groupName: 'G',
      });

      const parsed = JSON.parse(rumor.content);
      expect(parsed.type).toBe('join_request');
    });

    // ── S2: requester nickname transport (AC-NAME-1) ──────────────────────

    it('includes the requester nickname under requesterName, distinct from the group-name-carrying "name" field', () => {
      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: 'req',
        adminPubkeyHex: 'admin',
        nonce: 'n',
        groupName: 'Biology Study Group',
        requesterName: 'Alice',
      });

      const parsed = JSON.parse(rumor.content);
      expect(parsed.requesterName).toBe('Alice');
      expect(parsed.name).toBe('Biology Study Group');
      expect(parsed.requesterName).not.toBe(parsed.name);
    });

    it('omits requesterName from the JSON content entirely when not provided (older-client compatibility)', () => {
      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: 'req',
        adminPubkeyHex: 'admin',
        nonce: 'n',
        groupName: 'G',
      });

      const parsed = JSON.parse(rumor.content);
      expect('requesterName' in parsed).toBe(false);
    });

    it('remains kind 21059 (no new event kind) when requesterName is present', () => {
      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: 'req',
        adminPubkeyHex: 'admin',
        nonce: 'n',
        groupName: 'G',
        requesterName: 'Bob',
      });

      expect(rumor.kind).toBe(21059);
    });
  });

  // ── S3: signed kind-13 seal (AC-AUTH-0) ────────────────────────────────

  describe('buildGiftWrap', () => {
    it('produces a kind-13 seal with a genuine, verifiable schnorr signature (not just an id-hash placeholder)', async () => {
      const requester = makeKeypair();
      const admin = makeKeypair();

      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: requester.pubHex,
        adminPubkeyHex: admin.pubHex,
        nonce: 'n1',
        groupName: 'Group',
      });
      const giftWrap = await buildGiftWrap(rumor, requester.privHex, admin.pubHex);

      // Decrypt the outer wrap ourselves (recipient side) to inspect the seal
      // directly, independent of unwrapGiftWrap's own verification logic.
      const adminSigner = createPrivateKeySigner(admin.privHex);
      const sealJson = await adminSigner.nip44!.decrypt(giftWrap.pubkey, giftWrap.content);
      const seal = JSON.parse(sealJson);

      expect(typeof seal.sig).toBe('string');
      expect(seal.sig.length).toBeGreaterThan(0);
      // A real, independently-verifiable schnorr signature — not a stub.
      expect(verifyEvent(seal)).toBe(true);
      expect(seal.pubkey).toBe(requester.pubHex);
    });

    it("derives the seal's (and rumor's) pubkey from the REAL requester private key, not merely the declared requesterPubkeyHex param", async () => {
      const requester = makeKeypair();
      const admin = makeKeypair();
      const unrelatedClaimedPubkey = makeKeypair().pubHex;

      // Deliberately mismatched requesterPubkeyHex — wrapEvent must ignore it
      // and derive identity from the real private key instead.
      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: unrelatedClaimedPubkey,
        adminPubkeyHex: admin.pubHex,
        nonce: 'n1',
        groupName: 'Group',
      });
      const giftWrap = await buildGiftWrap(rumor, requester.privHex, admin.pubHex);

      const result = await unwrapGiftWrap(
        { pubkey: giftWrap.pubkey, content: giftWrap.content },
        createPrivateKeySigner(admin.privHex),
      );

      expect(result.authenticated).toBe(true);
      expect(result.pubkey).toBe(requester.pubHex);
      expect(result.pubkey).not.toBe(unrelatedClaimedPubkey);
    });

    it('interoperates with the existing unwrap path: unwrapGiftWrap authenticates a buildGiftWrap output end to end', async () => {
      const requester = makeKeypair();
      const admin = makeKeypair();

      const rumor = buildJoinRequestRumor({
        requesterPubkeyHex: requester.pubHex,
        adminPubkeyHex: admin.pubHex,
        nonce: 'n-interop',
        groupName: 'Group',
        requesterName: 'Carol',
      });
      const giftWrap = await buildGiftWrap(rumor, requester.privHex, admin.pubHex);

      // giftWrap's shape must match what rawPublish/relay-publish expects.
      expect(typeof giftWrap.id).toBe('string');
      expect(typeof giftWrap.sig).toBe('string');
      expect(giftWrap.kind).toBe(1059);
      expect(giftWrap.tags).toEqual([['p', admin.pubHex]]);

      const result = await unwrapGiftWrap(
        { pubkey: giftWrap.pubkey, content: giftWrap.content },
        createPrivateKeySigner(admin.privHex),
      );

      expect(result.authenticated).toBe(true);
      expect(result.pubkey).toBe(requester.pubHex);
      expect(result.rumor.kind).toBe(21059);
      const content = JSON.parse(result.rumor.content);
      expect(content.requesterName).toBe('Carol');
    });
  });

  describe('query param detection', () => {
    it('detects join request params from URL query', () => {
      const query = { join: 'nonce123', admin: 'npub1abc', name: 'Test Group' };

      expect(query.join).toBeDefined();
      expect(query.admin).toBeDefined();
      expect(query.name).toBeDefined();
    });

    it('returns undefined for missing params', () => {
      const query = { id: 'some-group' } as Record<string, string | undefined>;

      expect(query.join).toBeUndefined();
      expect(query.admin).toBeUndefined();
      expect(query.name).toBeUndefined();
    });
  });

  // ── S4 (AC-AUTO-1): outbound record written ONLY on a successful send ────

  describe('sendJoinRequest — outbound record write (AC-AUTO-1)', () => {
    let mockWebSocketInstances: Array<{
      url: string;
      onopen: (() => void) | null;
      onmessage: ((msg: { data: string }) => void) | null;
      onerror: (() => void) | null;
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }>;
    let origWebSocket: typeof globalThis.WebSocket;

    beforeEach(async () => {
      await clearAllOutboundJoinRequests();
      mockWebSocketInstances = [];
      origWebSocket = globalThis.WebSocket;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).WebSocket = class MockWebSocket {
        url: string;
        onopen: (() => void) | null = null;
        onmessage: ((msg: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        send = vi.fn();
        close = vi.fn();

        constructor(url: string) {
          this.url = url;
          mockWebSocketInstances.push(this);
          setTimeout(() => this.onopen?.(), 0);
        }
      };
    });

    afterEach(() => {
      globalThis.WebSocket = origWebSocket;
    });

    /**
     * Waits until `count` mock sockets exist AND each has already sent its EVENT frame.
     *
     * Constructing a socket is not enough: the mock connects on a `setTimeout(0)` and only then does the sender's
     * `onopen` send. Under CPU load a coarse 5 ms poll timer can fire BEFORE those just-scheduled 0 ms timers (the
     * expiry order follows scheduling time, and a >4 ms stall between the two schedules inverts it), so returning on the
     * instance count alone let the caller read `send.mock.calls[0]` of a socket that had not sent yet
     * (`Cannot read properties of undefined`, seen only in full-suite runs). Polling the observable condition removes the
     * ordering assumption.
     */
    async function waitForSockets(count: number) {
      await vi.waitFor(
        () => {
          expect(mockWebSocketInstances.length).toBeGreaterThanOrEqual(count);
          for (const ws of mockWebSocketInstances) expect(ws.send.mock.calls.length).toBeGreaterThan(0);
        },
        { timeout: 5_000, interval: 5 },
      );
    }

    it('persists an outbound record keyed by nonce when at least one relay accepts the event', async () => {
      const requester = makeKeypair();
      const admin = makeKeypair();

      const sendPromise = sendJoinRequest({
        requesterPubkeyHex: requester.pubHex,
        adminPubkeyHex: admin.pubHex,
        nonce: 'auto-accept-nonce-success',
        groupName: 'Success Group',
        requesterPrivateKeyHex: requester.privHex,
      });

      await waitForSockets(2);
      // Both relays acknowledge OK for whatever event id they received.
      for (const ws of mockWebSocketInstances) {
        const sentPayload = JSON.parse(ws.send.mock.calls[0][0]);
        const eventId = sentPayload[1].id as string;
        ws.onmessage?.({ data: JSON.stringify(['OK', eventId, true, '']) });
      }

      await sendPromise;

      const records = await loadUnexpiredOutboundJoinRequestsForAdmin(admin.pubHex);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        nonce: 'auto-accept-nonce-success',
        adminPubkeyHex: admin.pubHex,
        groupName: 'Success Group',
      });
      expect(typeof records[0].sentAt).toBe('number');
    });

    it('writes NO record when every relay rejects the event (failed send)', async () => {
      const requester = makeKeypair();
      const admin = makeKeypair();

      const sendPromise = sendJoinRequest({
        requesterPubkeyHex: requester.pubHex,
        adminPubkeyHex: admin.pubHex,
        nonce: 'auto-accept-nonce-failure',
        groupName: 'Failure Group',
        requesterPrivateKeyHex: requester.privHex,
      });

      await waitForSockets(2);
      for (const ws of mockWebSocketInstances) {
        const sentPayload = JSON.parse(ws.send.mock.calls[0][0]);
        const eventId = sentPayload[1].id as string;
        ws.onmessage?.({ data: JSON.stringify(['OK', eventId, false, 'blocked']) });
      }

      await expect(sendPromise).rejects.toThrow('All relays rejected the join request');

      const records = await loadUnexpiredOutboundJoinRequestsForAdmin(admin.pubHex);
      expect(records).toHaveLength(0);
    });
  });
});
