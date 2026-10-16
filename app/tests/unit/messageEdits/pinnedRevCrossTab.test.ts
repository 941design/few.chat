/**
 * Pinned revs are kept across tabs (bug: reaction-storage-failures,
 * remediation round 2).
 *
 * The pin store (messageEdits/api.ts PinnedRev) is ONE array under one key
 * shared by every tab. Two tabs pinning at once used to each read the array and
 * write back their own addition, dropping the other's pin, so that rumor's
 * replay recomputed a higher rev. Every pin read-modify-write now runs in one
 * readwrite IndexedDB transaction.
 *
 * Two "tabs" = two independent module instances (vi.resetModules), each with
 * its own idb-keyval connection, over ONE fake-indexeddb origin. Real modules
 * throughout: messageEdits/api.ts, chatPersistence.ts, idb-keyval.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false, configurable: true });
}

const { getPublicKey, generateSecretKey } = await import('nostr-tools/pure');
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const priv = generateSecretKey();
const PRIV = hex(priv);
const AUTHOR = getPublicKey(priv);
const SENDER = { pubkey: AUTHOR, authenticity: 'mls' as const };
const PINS = 'few:messageEditsPinnedRevs:v1';
const HOUR = 3600;

type Tab = {
  edits: typeof import('@/src/lib/messageEdits/api');
  chat: typeof import('@/src/lib/marmot/chatPersistence');
  rumors: typeof import('@/src/lib/messageEdits/rumor');
  idb: typeof import('idb-keyval');
};

async function bootTab(): Promise<Tab> {
  vi.resetModules();
  return {
    edits: await import('@/src/lib/messageEdits/api'),
    chat: await import('@/src/lib/marmot/chatPersistence'),
    rumors: await import('@/src/lib/messageEdits/rumor'),
    idb: await import('idb-keyval'),
  };
}

const nowS = () => Math.floor(Date.now() / 1000);
const group = (i: number) => `group-${i}`;
const orig = (i: number) => `orig-${i}-` + 'ab'.repeat(26);

/** Seeds one message per group so a far-future edit applies to a known row. */
async function seed(tab: Tab, groups: number[]): Promise<void> {
  for (const i of groups) {
    await tab.chat.appendMessage(group(i), {
      id: orig(i),
      content: 'hello',
      senderPubkey: AUTHOR,
      groupId: group(i),
      createdAt: (nowS() - 600) * 1000,
    });
  }
}

/** A far-future edit of group i's message (its rev is capped, hence pinned). */
function farEdit(tab: Tab, i: number, tag: string) {
  return tab.rumors.buildEditReplacementRumor(orig(i), nowS() - 600, `edit ${tag}`, 9, nowS() + 10 * HOUR, PRIV);
}

async function storedPins(tab: Tab): Promise<Array<{ threadKey: string; rumorId: string }>> {
  return ((await tab.idb.get(PINS)) as Array<{ threadKey: string; rumorId: string }> | undefined) ?? [];
}

let tabA: Tab;
let tabB: Tab;

beforeEach(async () => {
  tabA = await bootTab();
  tabB = await bootTab();
  await tabA.idb.clear(); // a clean origin per test (shared default store)
});

describe('pin inserts in two tabs at once', () => {
  it('both tabs\' pins survive (20 concurrent pairs)', async () => {
    const pairs = Array.from({ length: 10 }, (_, n) => [2 * n, 2 * n + 1] as const);
    await seed(tabA, pairs.flat());
    const expected: string[] = [];
    for (const [a, b] of pairs) {
      const ra = farEdit(tabA, a, 'A');
      const rb = farEdit(tabB, b, 'B');
      expected.push(`${group(a)}:${ra.id}`, `${group(b)}:${rb.id}`);
      await Promise.all([
        tabA.edits.applyDeleteEditSignal({ kind: 'group', groupId: group(a) }, ra as never, SENDER),
        tabB.edits.applyDeleteEditSignal({ kind: 'group', groupId: group(b) }, rb as never, SENDER),
      ]);
    }
    const pins = (await storedPins(tabA)).map((p) => `${p.threadKey}:${p.rumorId}`);
    expect(pins.sort()).toEqual(expected.sort());
  });

  it('the same rumor pinned by both tabs at once ends with ONE pin, and both apply the same rev', async () => {
    await seed(tabA, [0]);
    const rumor = farEdit(tabA, 0, 'same');
    await Promise.all([
      tabA.edits.applyDeleteEditSignal({ kind: 'group', groupId: group(0) }, rumor as never, SENDER),
      tabB.edits.applyDeleteEditSignal({ kind: 'group', groupId: group(0) }, rumor as never, SENDER),
    ]);
    const pins = await storedPins(tabA);
    expect(pins).toHaveLength(1);
    const { messages } = await tabA.chat.loadMessages(group(0));
    expect(messages[0].rev).toBe((pins[0] as unknown as { rev: number }).rev);
  });
});

describe('a thread\'s pin cleanup racing another tab\'s pin insert', () => {
  it('drops exactly the cleared threads\' pins and keeps every concurrently inserted one', async () => {
    const cleared = Array.from({ length: 10 }, (_, n) => n);
    const others = Array.from({ length: 10 }, (_, n) => 10 + n);
    await seed(tabA, [...cleared, ...others]);
    // Tab A pins for the threads it will clear.
    for (const i of cleared) {
      await tabA.edits.applyDeleteEditSignal({ kind: 'group', groupId: group(i) }, farEdit(tabA, i, 'old') as never, SENDER);
    }
    expect(await storedPins(tabA)).toHaveLength(10);

    // Tab A clears its threads while tab B pins ten others, all at once and
    // staggered so the two streams interleave throughout.
    const inserted = others.map((i) => farEdit(tabB, i, 'new'));
    const stagger = async (k: number) => {
      for (let t = 0; t < k; t++) await new Promise((r) => setImmediate(r));
    };
    await Promise.all([
      ...cleared.map(async (i, k) => {
        await stagger(k);
        await tabA.edits.clearMessageEditsStateForThread(group(i));
      }),
      ...others.map(async (i, k) => {
        await stagger(k);
        await tabB.edits.applyDeleteEditSignal({ kind: 'group', groupId: group(i) }, inserted[k] as never, SENDER);
      }),
    ]);

    const after = (await storedPins(tabA)).map((p) => `${p.threadKey}:${p.rumorId}`).sort();
    expect(after).toEqual(others.map((i, k) => `${group(i)}:${inserted[k].id}`).sort());
  });
});
