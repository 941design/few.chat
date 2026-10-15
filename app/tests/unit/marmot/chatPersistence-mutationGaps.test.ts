/**
 * chatPersistence.ts — behaviour gaps surfaced by the 2026-10-14 mutation audit.
 *
 * Each block pins a user-facing (or persisted-format) contract the existing
 * suites exercised but never asserted:
 *   - Per-thread write queue: a settled write must release ONLY its own queue
 *     handle; releasing a newer in-flight handle lets the next write race it
 *     and silently lose a row (every write path: append / update / tombstone /
 *     remove / self-heal rewrite).
 *   - AC-STORE-3 clobber-guard (guard 1) on its own, independent of the rev
 *     floor (guard 2), and the rev-sanitization rules (negative / non-finite
 *     rev is never persisted).
 *   - tombstoneMessage edges: rev 1 is a real signal, missing row / older rev
 *     return false without writing, the S8 announcement gate inspects the
 *     TARGET row, malformed admin entries are tolerated.
 *   - Self-heal: whitespace-tolerant envelope detection, existing attachments
 *     are never replaced, refetchIds empty for group / already-healed threads,
 *     healed-marker persisted format.
 *   - purgeStrangerDmThreads: deleted count (AC-OBS-5), in-flight append
 *     drained before delete, non-string IDB keys tolerated, AC-PERF-1
 *     thresholds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';
import type { Group } from '@/src/types';

// ── idb-keyval mock with optional per-call write gates ──────────────────────

const idbStore = new Map<unknown, unknown>();

interface Gate {
  reached: Promise<void>;
  release: () => void;
}
const armedGates: Array<{ onReach: () => void; wait: Promise<void> }> = [];

/** Arms a gate that blocks the NEXT idb `set` call until released. */
function armGate(): Gate {
  let onReach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => { onReach = r; });
  const wait = new Promise<void>((r) => { release = r; });
  armedGates.push({ onReach, wait });
  return { reached, release };
}

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: unknown) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: unknown, value: unknown) => {
    const gate = armedGates.shift();
    if (gate) {
      gate.onReach();
      await gate.wait;
    }
    idbStore.set(key, value);
  }),
  del: vi.fn(async (key: unknown) => { idbStore.delete(key); }),
  delMany: vi.fn(async (ks: unknown[]) => { ks.forEach((k) => idbStore.delete(k)); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
}));

// ── localStorage mock ───────────────────────────────────────────────────────

const lsStore = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: vi.fn((k: string) => lsStore.get(k) ?? null),
  setItem: vi.fn((k: string, v: string) => { lsStore.set(k, v); }),
  removeItem: vi.fn((k: string) => { lsStore.delete(k); }),
  clear: vi.fn(() => { lsStore.clear(); }),
  get length() { return lsStore.size; },
  key: vi.fn((i: number) => [...lsStore.keys()][i] ?? null),
});

const {
  appendMessage,
  loadMessages,
  updateMessageInPlace,
  tombstoneMessage,
  removeMessages,
  selfHealMessages,
  clearAllMessages,
  purgeStrangerDmThreads,
} = await import('@/src/lib/marmot/chatPersistence');

// ── Helpers ─────────────────────────────────────────────────────────────────

const HEALED_MARKER_KEY = 'lp_dmHealed_v1';
const ANNOUNCEMENT = JSON.stringify({ type: 'member_admitted', pubkey: 'b'.repeat(64) });
const ADMIN = 'ad'.repeat(32);
const NON_ADMIN = 'ee'.repeat(32);

function makeMsg(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    content: `content-of-${id}`,
    senderPubkey: 'aa'.repeat(32),
    groupId: 'g',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function seed(groupId: string, rows: ChatMessage[]): void {
  idbStore.set(`few:messages:${groupId}`, rows);
}

function stored(groupId: string): ChatMessage[] | undefined {
  return idbStore.get(`few:messages:${groupId}`) as ChatMessage[] | undefined;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  idbStore.clear();
  lsStore.clear();
  armedGates.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Per-thread write queue: a settled write releases only its own handle ────

describe('write queue — a write that settles while a newer write is in flight must not release that newer write\'s slot', () => {
  const ENVELOPE = JSON.stringify({ type: 'text', text: 'decoded' });

  const writers: Array<[string, string, ChatMessage[], () => Promise<unknown>]> = [
    ['appendMessage', 'q-append', [makeMsg('a')], () => appendMessage('q-append', makeMsg('x'))],
    ['updateMessageInPlace', 'q-update', [makeMsg('a')], () => updateMessageInPlace('q-update', 'a', { content: 'patched' })],
    ['tombstoneMessage', 'q-tomb', [makeMsg('a')], () => tombstoneMessage('q-tomb', 'a', 5)],
    ['removeMessages', 'q-remove', [makeMsg('a'), makeMsg('gone')], () => removeMessages('q-remove', ['gone'])],
    ['self-heal rewrite (loadMessages on a DM thread)', 'dm:q-heal', [makeMsg('a', { content: ENVELOPE })], () => loadMessages('dm:q-heal')],
  ];

  it.each(writers)('%s: later appends B then C both land (no lost write)', async (_name, thread, rows, write) => {
    seed(thread, rows);

    // X is blocked mid-write.
    const gateX = armGate();
    const pX = write();
    await gateX.reached;

    // B is enqueued behind X and will block at its own write.
    const gateB = armGate();
    const pB = appendMessage(thread, makeMsg('b'));

    // X completes; its queue-slot cleanup runs while B is in flight.
    gateX.release();
    await pX;
    await gateB.reached;
    await tick();

    // C must still be serialised behind B.
    const pC = appendMessage(thread, makeMsg('c'));
    await tick();
    gateB.release();
    await Promise.all([pB, pC]);

    const ids = (stored(thread) ?? []).map((m) => m.id);
    expect(ids).toContain('b');
    expect(ids).toContain('c');
    expect(ids.slice(-2)).toEqual(['b', 'c']);
  });
});

// ── AC-STORE-3 clobber-guard (guard 1) independent of the rev floor ─────────

describe('updateMessageInPlace — clobber-guard: a non-signal write never touches an edited/tombstoned row, even with no stored rev', () => {
  it.each([
    ['edited', { edited: true }],
    ['tombstoned', { tombstoned: true }],
  ] as const)('%s row without rev: rev-less and rev=0 patches are rejected', async (_l, flags) => {
    seed('g1', [makeMsg('a', { content: 'kept', ...flags })]);
    await updateMessageInPlace('g1', 'a', { content: 'clobber' });
    await updateMessageInPlace('g1', 'a', { content: 'clobber', rev: 0 });
    expect(stored('g1')).toEqual([makeMsg('a', { content: 'kept', ...flags })]);
  });

  it('rev=1 is already a real signal: applied to an edited row', async () => {
    seed('g2', [makeMsg('a', { content: 'v1', edited: true })]);
    await updateMessageInPlace('g2', 'a', { content: 'v2', rev: 1 });
    expect(stored('g2')![0]).toMatchObject({ content: 'v2', rev: 1, edited: true });
  });

  it('a rev-less patch on an unflagged row is applied (guard only protects flagged rows)', async () => {
    seed('g3', [makeMsg('a', { content: 'v1' })]);
    await updateMessageInPlace('g3', 'a', { content: 'v2' });
    expect(stored('g3')![0].content).toBe('v2');
  });
});

describe('updateMessageInPlace — malformed rev is treated as "no signal" and never persisted', () => {
  it.each([
    ['negative', -3],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('%s rev on a plain row: content applied, stored rev untouched', async (_l, rev) => {
    seed('r1', [makeMsg('a', { content: 'v1' })]);
    await updateMessageInPlace('r1', 'a', { content: 'v2', rev });
    const row = stored('r1')![0];
    expect(row.content).toBe('v2');
    expect(row.rev).toBeUndefined();
  });

  it.each([
    ['negative', -3],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('%s rev against an edited row is rejected (not a real signal)', async (_l, rev) => {
    seed('r2', [makeMsg('a', { content: 'kept', edited: true, rev: 4 })]);
    await updateMessageInPlace('r2', 'a', { content: 'clobber', rev });
    expect(stored('r2')![0]).toMatchObject({ content: 'kept', rev: 4 });
  });
});

// ── tombstoneMessage edges ──────────────────────────────────────────────────

describe('tombstoneMessage — return value and write contract', () => {
  it('rev=1 is the smallest real signal: tombstone applied, returns true', async () => {
    seed('t1', [makeMsg('a')]);
    await expect(tombstoneMessage('t1', 'a', 1)).resolves.toBe(true);
    expect(stored('t1')![0]).toMatchObject({ tombstoned: true, rev: 1 });
  });

  it('missing row: returns false and the stored log is left untouched', async () => {
    const rows = [makeMsg('a')];
    seed('t2', rows);
    await expect(tombstoneMessage('t2', 'nope', 9)).resolves.toBe(false);
    expect(stored('t2')).toEqual(rows);
  });

  it('missing thread: returns false and creates nothing', async () => {
    await expect(tombstoneMessage('t-none', 'nope', 9)).resolves.toBe(false);
    expect(stored('t-none')).toBeUndefined();
  });

  it('a rev older than the stored rev: returns false, row not tombstoned', async () => {
    seed('t3', [makeMsg('a', { content: 'edited', edited: true, rev: 5 })]);
    await expect(tombstoneMessage('t3', 'a', 3)).resolves.toBe(false);
    expect(stored('t3')![0].tombstoned).toBeUndefined();
  });

  it('the announcement gate inspects the TARGET row, not some other row in the thread', async () => {
    seed('t4', [makeMsg('ann', { content: ANNOUNCEMENT }), makeMsg('ord', { content: 'ordinary' })]);
    const ok = await tombstoneMessage('t4', 'ord', 3, { senderPubkeyHex: NON_ADMIN, adminPubkeysHex: [ADMIN] });
    expect(ok).toBe(true);
    expect(stored('t4')!.map((m) => !!m.tombstoned)).toEqual([false, true]);
  });

  it('malformed (non-string) admin entries are skipped, not fatal', async () => {
    seed('t5', [makeMsg('ann', { content: ANNOUNCEMENT })]);
    const ok = await tombstoneMessage('t5', 'ann', 3, {
      senderPubkeyHex: ADMIN,
      adminPubkeysHex: [null as unknown as string, 42 as unknown as string, ADMIN],
    });
    expect(ok).toBe(true);
    expect(stored('t5')![0].tombstoned).toBe(true);
  });
});

// ── Self-heal / loadMessages ────────────────────────────────────────────────

describe('selfHealMessages — envelope detection and attachment preservation', () => {
  const OWN = 'cc'.repeat(32);

  it('an envelope with insignificant whitespace is still decoded', () => {
    const msg = makeMsg('f'.repeat(64), { content: '{ "type" : "text", "text": "hi there" }' });
    const { messages, needsRewrite } = selfHealMessages('dm:x', [msg], OWN);
    expect(needsRewrite).toBe(true);
    expect(messages[0].content).toBe('hi there');
  });

  it('an image envelope never replaces attachments the row already has', () => {
    const existing = { full: { url: 'https://orig/full', sha256: '1'.repeat(64) } } as any;
    const envelope = JSON.stringify({
      type: 'image',
      version: 1,
      caption: 'cap',
      attachments: { full: { url: 'https://other/full', sha256: '2'.repeat(64) } },
    });
    const msg = makeMsg('f'.repeat(64), { content: envelope, attachments: existing });
    const { messages } = selfHealMessages('dm:x', [msg], OWN);
    expect(messages[0].attachments).toBe(existing);
  });
});

describe('loadMessages — refetchIds and healed-marker format', () => {
  it('group threads never report refetchIds, even for non-canonical ids', async () => {
    seed('grp', [makeMsg('short-id')]);
    await expect(loadMessages('grp')).resolves.toEqual({ messages: [makeMsg('short-id')], refetchIds: [] });
  });

  it('an already-healed DM thread reports no refetchIds', async () => {
    lsStore.set(HEALED_MARKER_KEY, JSON.stringify(['dm:healed']));
    seed('dm:healed', [makeMsg('short-id')]);
    await expect(loadMessages('dm:healed')).resolves.toEqual({ messages: [makeMsg('short-id')], refetchIds: [] });
  });

  it.each([
    ['absent', undefined],
    ['corrupt JSON', '{'],
    ['non-array JSON', '{"a":1}'],
  ])('marker %s: first load persists exactly [threadId]', async (_l, raw) => {
    if (raw !== undefined) lsStore.set(HEALED_MARKER_KEY, raw);
    await loadMessages('dm:fresh');
    expect(JSON.parse(lsStore.get(HEALED_MARKER_KEY)!)).toEqual(['dm:fresh']);
  });

  it('marker accumulates healed threads', async () => {
    await loadMessages('dm:one');
    await loadMessages('dm:two');
    expect(JSON.parse(lsStore.get(HEALED_MARKER_KEY)!)).toEqual(['dm:one', 'dm:two']);
  });
});

// ── Non-string IDB keys ─────────────────────────────────────────────────────

describe('bulk sweeps tolerate non-string IDB keys (IDB keys may be numbers/arrays)', () => {
  const whitelist = () => ({ groups: [] as Group[], knownPeers: new Set<string>(), ownPubkeyHex: 'cc'.repeat(32) });

  it('clearAllMessages removes message keys and keeps non-string keys', async () => {
    idbStore.set(42, 'n');
    idbStore.set('few:messages:g', [makeMsg('a')]);
    await clearAllMessages();
    expect([...idbStore.keys()]).toEqual([42]);
  });

  it('purgeStrangerDmThreads ignores non-string keys', async () => {
    idbStore.set(42, 'n');
    await expect(purgeStrangerDmThreads(whitelist)).resolves.toEqual({ deleted: 0 });
    expect(idbStore.has(42)).toBe(true);
  });
});

// ── purgeStrangerDmThreads ──────────────────────────────────────────────────

describe('purgeStrangerDmThreads — deleted count, in-flight drain, AC-PERF-1', () => {
  const MEMBER = 'aa'.repeat(32);
  const STRANGER1 = 'b1'.repeat(32);
  const STRANGER2 = 'b2'.repeat(32);
  const OWN = 'cc'.repeat(32);
  const group: Group = { id: 'grp', name: 'G', createdAt: 1, memberPubkeys: [MEMBER, OWN], relays: [] };
  const whitelist = () => ({ groups: [group], knownPeers: new Set<string>(), ownPubkeyHex: OWN });

  it('returns the exact number of stranger threads deleted (AC-OBS-5)', async () => {
    seed(`dm:${STRANGER1}`, [makeMsg('s1')]);
    seed(`dm:${STRANGER2}`, [makeMsg('s2')]);
    seed(`dm:${MEMBER}`, [makeMsg('m')]);
    await expect(purgeStrangerDmThreads(whitelist)).resolves.toEqual({ deleted: 2 });
    expect([...idbStore.keys()]).toEqual([`few:messages:dm:${MEMBER}`]);
  });

  it('returns {deleted: 0} when there are no strangers', async () => {
    seed(`dm:${MEMBER}`, [makeMsg('m')]);
    await expect(purgeStrangerDmThreads(whitelist)).resolves.toEqual({ deleted: 0 });
  });

  it('an in-flight append to a stranger thread cannot re-create the key after the purge', async () => {
    const thread = `dm:${STRANGER1}`;
    seed(thread, [makeMsg('old')]);
    const gate = armGate();
    const pAppend = appendMessage(thread, makeMsg('late'));
    await gate.reached;

    const pPurge = purgeStrangerDmThreads(whitelist);
    await tick();
    gate.release();
    await Promise.all([pAppend, pPurge]);

    expect(stored(thread)).toBeUndefined();
  });

  function fakeElapsed(ms: number) {
    let calls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (calls++ === 0 ? 0 : ms));
  }

  it.each([
    [100, false],
    [500, false],
    [501, true],
    [2000, true],
  ])('sweep taking %ims resolves; slow-sweep warning emitted: %s', async (ms, warns) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeElapsed(ms);
    await expect(purgeStrangerDmThreads(whitelist)).resolves.toEqual({ deleted: 0 });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('purgeStrangerDmThreads'))).toBe(warns);
  });

  it('a sweep exceeding 2000ms rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeElapsed(2001);
    await expect(purgeStrangerDmThreads(whitelist)).rejects.toThrow(/2 000 ms/);
  });
});
