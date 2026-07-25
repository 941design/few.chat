/**
 * Integration-style test for `readPreJoinGroupData` (welcomeSubscription.ts,
 * inline-invitation-cards epic, Story S1 / AC-DATA-1) against a REAL,
 * un-mocked `@internet-privacy/marmot-ts` group + Welcome — no mocking of
 * `getWelcome` / `getWelcomeKeyPackageRefs` / `readWelcomeMarmotGroupData`.
 *
 * Mirrors `readPreJoinGroupName.realMarmot.test.ts`'s fixture setup (see that
 * file's header for the full rationale on why an unmocked test exists here):
 * drives two REAL MarmotClient instances (admin + invitee) through a genuine
 * MLS group creation and invite, extracts the REAL Welcome gift wrap, unwraps
 * it with the app's own real `unwrapGiftWrap`, and asserts the real
 * `readPreJoinGroupData` recovers `{ name, description, adminPubkeys }` from
 * it — WITHOUT joining.
 *
 * No IndexedDB, no network, no WASM: MarmotClient's storage is a generic
 * key-value interface (implemented here as a plain in-memory Map), and
 * ts-mls's default crypto provider is pure JS + WebCrypto (`crypto.subtle`,
 * global in Node >= 20) — see the polyfill below, mirrored from
 * `tests/unit/directMessages/sealAndWrap.test.ts`.
 */
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { MarmotClient, generateKeyPackageSlot } from '@internet-privacy/marmot-ts';
import type { GenericKeyValueStore, NostrNetworkInterface, PublishResponse } from '@internet-privacy/marmot-ts';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { unwrapGiftWrap, readPreJoinGroupData } from '@/src/lib/marmot/welcomeSubscription';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';

const TEST_RELAY = 'wss://relay.test.invalid';
const GIFT_WRAP_KIND = 1059;
const KEY_PACKAGE_KIND = 443;
const ADDRESSABLE_KEY_PACKAGE_KIND = 30443;

// ---------------------------------------------------------------------------
// Minimal in-memory GenericKeyValueStore — marmot-ts's own InMemoryKeyValueStore
// isn't reachable via the package's public `exports` map, so we implement the
// trivial 5-method interface directly (nothing here is marmot-ts-specific).
// ---------------------------------------------------------------------------

class InMemoryStore<T> implements GenericKeyValueStore<T> {
  private map = new Map<string, T>();
  async getItem(key: string): Promise<T | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  async setItem(key: string, value: T): Promise<T> {
    this.map.set(key, value);
    return value;
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
  async clear(): Promise<void> {
    this.map.clear();
  }
  async keys(): Promise<string[]> {
    return Array.from(this.map.keys());
  }
}

// ---------------------------------------------------------------------------
// Minimal recording NostrNetworkInterface — publish() always "acks" and
// records every event so the test can pull the real KeyPackage event and the
// real Welcome gift wrap back out. No actual network I/O happens.
// ---------------------------------------------------------------------------

class RecordingNetwork implements NostrNetworkInterface {
  published: NostrEvent[] = [];

  async publish(relays: string[], event: NostrEvent): Promise<Record<string, PublishResponse>> {
    this.published.push(event);
    const result: Record<string, PublishResponse> = {};
    for (const relay of relays) {
      result[relay] = { from: relay, ok: true };
    }
    return result;
  }

  async request(): Promise<NostrEvent[]> {
    return [];
  }

  subscription() {
    return { subscribe: () => ({ unsubscribe: () => {} }) };
  }

  async getUserInboxRelays(): Promise<string[]> {
    return [TEST_RELAY];
  }
}

function makeKeypair() {
  const priv = generateSecretKey();
  return { priv, privHex: bytesToHex(priv), pubHex: getPublicKey(priv) };
}

describe('readPreJoinGroupData — real marmot-ts (unmocked)', () => {
  it('extracts the real name, description, and admin pubkeys from a genuine MLS Welcome produced by MarmotClient.groups.create + inviteByKeyPackageEvent', async () => {
    const admin = makeKeypair();
    const invitee = makeKeypair();

    const network = new RecordingNetwork();

    const adminClient = new MarmotClient({
      signer: createPrivateKeySigner(admin.privHex),
      groupStateStore: new InMemoryStore(),
      keyPackageStore: new InMemoryStore(),
      network,
      clientId: 'test-admin',
    });

    const inviteeClient = new MarmotClient({
      signer: createPrivateKeySigner(invitee.privHex),
      groupStateStore: new InMemoryStore(),
      keyPackageStore: new InMemoryStore(),
      network,
      // The installed marmot-ts fork validates clientId as a MIP-00 slot
      // identifier (`/^[0-9a-f]{64}$/`) — mint a conformant one instead of
      // an arbitrary string literal.
      clientId: generateKeyPackageSlot(),
    });

    // 1. Invitee publishes a REAL KeyPackage (kind 30443) — captured via the
    // recording network stub.
    await inviteeClient.keyPackages.create({ relays: [TEST_RELAY] });
    const inviteeKeyPackageEvent = network.published.find(
      (e) => e.pubkey === invitee.pubHex && (e.kind === KEY_PACKAGE_KIND || e.kind === ADDRESSABLE_KEY_PACKAGE_KIND),
    );
    expect(inviteeKeyPackageEvent).toBeDefined();

    // 2. Admin creates a REAL MLS group with a name AND a description, per
    // GroupsManager.create's SimpleGroupOptions (`description?: string`).
    const group = await adminClient.groups.create('Real Marmot Group', {
      description: 'A real description for AC-DATA-1',
      relays: [TEST_RELAY],
    });
    expect(group.groupData?.name).toBe('Real Marmot Group');
    expect(group.groupData?.description).toBe('A real description for AC-DATA-1');
    expect(group.groupData?.adminPubkeys).toContain(admin.pubHex);

    // 3. Admin invites the invitee: builds the Add proposal, commits, and
    // gift-wraps + "delivers" a real Welcome — captured via the same
    // recording network stub.
    await group.inviteByKeyPackageEvent(inviteeKeyPackageEvent!);
    const giftWrapEvent = network.published.find((e) => e.kind === GIFT_WRAP_KIND);
    expect(giftWrapEvent).toBeDefined();

    // 4. Unwrap the REAL gift wrap using the invitee's real signer — reusing
    // the app's own (also real, unmocked) unwrapGiftWrap helper.
    const unwrapped = await unwrapGiftWrap(
      { pubkey: giftWrapEvent!.pubkey, content: giftWrapEvent!.content },
      createPrivateKeySigner(invitee.privHex),
    );
    expect(unwrapped.authenticated).toBe(true);
    expect(unwrapped.rumor.kind).toBe(444);

    // 5. The real assertion: readPreJoinGroupData, exercising the REAL
    // getWelcome / getWelcomeKeyPackageRefs / readWelcomeMarmotGroupData call
    // chain (no mocks anywhere in this file), recovers the real
    // { name, description, adminPubkeys, groupId } from the real Welcome —
    // WITHOUT joining the group. The admin's real pubkey hex appears in
    // adminPubkeys because MarmotClient seeds the creator as the sole
    // initial admin. AC-DECLINE-1: groupId is now also surfaced (via a real
    // readWelcomeGroupInfo call, no mocking) and MUST equal the admin's own
    // real MLS group id (group.idStr) — the same identifier the invitee will
    // eventually see post-join (MarmotGroup.idStr), proving the pre-join
    // surfaced groupId is not a placeholder but the genuine MLS group id.
    const data = await readPreJoinGroupData(unwrapped.rumor, inviteeClient);
    expect(data).not.toBeNull();
    expect(data).toEqual({
      name: 'Real Marmot Group',
      description: 'A real description for AC-DATA-1',
      adminPubkeys: expect.arrayContaining([admin.pubHex]),
      groupId: group.idStr,
    });
    expect(data!.adminPubkeys).toContain(admin.pubHex);
    expect(data!.groupId).toMatch(/^[0-9a-f]+$/);
    expect(data!.groupId.length).toBeGreaterThan(0);
  });
});
