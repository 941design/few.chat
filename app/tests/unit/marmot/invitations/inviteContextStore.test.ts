/**
 * AC-CTX-3 (unit, fake time): the holding store. Exact retained sets after inserting 9 / 65 entries and after
 * 7 days + 1 ms; sponsor validation on invitation arrival; deletion on accept, decline and expiry; persistence
 * that does not depend on the storage's key order.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_TTL_MS,
  HELD_PER_SENDER_CAP,
  HELD_TOTAL_CAP,
  TOMBSTONE_CAP,
  bindInviteContextToPendingView,
  buildInvitationCardViewModels,
  createInviteContextStore,
  withInviteContextCleanup,
  type InvitationRef,
  type InviteContextRecord,
} from '@/src/lib/marmot/invitations';
import { hex, inv, memoryPort } from './inviteContext.fixtures';

function setup(opts: { pending?: () => readonly InvitationRef[]; initial?: InviteContextRecord[]; isTrustedSponsor?: (sender: string) => boolean } = {}) {
  const clock = { t: 1_000_000 };
  const mem = memoryPort(opts.initial);
  const errors: unknown[] = [];
  const store = createInviteContextStore({ port: mem.port, now: () => clock.t, getPending: opts.pending ?? (() => []), isTrustedSponsor: opts.isTrustedSponsor, onError: (e) => void errors.push(e) });
  const ids = () => store.snapshot().map((r) => r.rumorId);
  return { store, clock, mem, errors, ids };
}
let n = 0;
const add = (s: ReturnType<typeof setup>, sender: number, groupId: string, name = 'N') =>
  s.store.add({ rumorId: `rumor-${n++}`, sender: hex(sender), groupId, name });

describe('constants', () => {
  it('8 per sender, 64 total, 7 days', () => {
    expect(HELD_PER_SENDER_CAP).toBe(8);
    expect(HELD_TOTAL_CAP).toBe(64);
    expect(CONTEXT_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('held caps (no matching invitation): oldest evicted first', () => {
  it('9 contexts from one sender retain exactly the newest 8 even if the evicted ID is redelivered after reload', async () => {
    const s = setup();
    for (let i = 0; i < 9; i++) await s.store.add({ rumorId: `r${i}`, sender: hex(1), groupId: `0${i}`, name: `g${i}` });
    expect(s.ids()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
    const evicted = { rumorId: 'r0', sender: hex(1), groupId: '00', name: 'g0' };
    expect(await s.store.add(evicted)).toBe('duplicate');
    const reopened = createInviteContextStore({ port: s.mem.port, now: () => s.clock.t, getPending: () => [] });
    expect(await reopened.add(evicted)).toBe('duplicate');
    expect(reopened.snapshot()).toEqual(s.store.snapshot());
    expect(s.mem.saves).toHaveLength(9);
  });

  it('65 contexts over 9 senders (8 + 8 + ... + 1) retain exactly 64: the single oldest overall is evicted', async () => {
    const s = setup();
    const order: string[] = [];
    // interleave senders so "oldest overall" is not "first sender's last"
    for (let round = 0; round < 8; round++) {
      for (let sender = 1; sender <= 8; sender++) {
        const id = `s${sender}-${round}`;
        order.push(id);
        await s.store.add({ rumorId: id, sender: hex(sender), groupId: `${sender}${round}`, name: id });
      }
    }
    expect(s.ids()).toHaveLength(64);
    await s.store.add({ rumorId: 'ninth', sender: hex(9), groupId: 'ff', name: 'ninth' });
    expect(s.ids()).toEqual([...order.slice(1), 'ninth']);
  });

  it('the per-sender cap evicts that sender\'s oldest, not another sender\'s', async () => {
    const s = setup();
    await s.store.add({ rumorId: 'other', sender: hex(2), groupId: 'aa', name: 'o' });
    for (let i = 0; i < 9; i++) await s.store.add({ rumorId: `m${i}`, sender: hex(1), groupId: `1${i}`, name: 'm' });
    expect(s.ids()).toEqual(['other', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
  });

  it('a matched context does not count against the held caps (a flood cannot evict the real one)', async () => {
    const real = inv('1', 1, 'a0');
    const s = setup({ pending: () => [real] });
    expect(await add(s, 1, 'a0', 'Real')).toBe('stored');
    for (let i = 0; i < 70; i++) await s.store.add({ rumorId: `f${i}`, sender: hex(2 + (i % 20)), groupId: `b${i}`, name: 'flood' });
    expect(s.store.snapshot().filter((r) => r.matched).map((r) => r.name)).toEqual(['Real']);
    expect(s.store.snapshot().filter((r) => !r.matched)).toHaveLength(64);
  });
});

describe('expiry: 7 days (fake time)', () => {
  it('updates an idle card and purges its stored name at the deadline, then cancels the next timer on disposal', async () => {
    const clock = { t: 1_000 };
    const mem = memoryPort();
    const pending = [inv('1', 1, 'aa')];
    let timer: { deadline: number; expire: () => Promise<void> } | undefined;
    const store = createInviteContextStore({
      port: mem.port,
      now: () => clock.t,
      getPending: () => pending,
      scheduleExpiry: (delay, expire) => {
        const scheduled = { deadline: clock.t + delay, expire };
        timer = scheduled;
        return () => { if (timer === scheduled) timer = undefined; };
      },
    });
    const displayed: string[] = [];
    store.subscribe(() => displayed.push(buildInvitationCardViewModels(pending, store.snapshot(), 'Invitation', clock.t)[0].displayName));
    await store.add({ rumorId: 'old', sender: hex(1), groupId: 'aa', name: 'Club' });
    clock.t += 10;
    await store.add({ rumorId: 'new', sender: hex(2), groupId: 'bb', name: 'New' });
    expect(displayed).toEqual(['Club', 'Club']);
    clock.t = 1_000 + CONTEXT_TTL_MS;
    expect(timer?.deadline).toBe(clock.t + 1);
    expect(mem.stored?.map((r) => r.rumorId)).toEqual(['old', 'new']);
    clock.t += 1;
    await timer!.expire();
    expect(displayed).toEqual(['Club', 'Club', 'Invitation']);
    expect(mem.stored?.map((r) => r.rumorId)).toEqual(['new']);
    const cancelled = timer!;
    expect(cancelled.deadline).toBe(clock.t + 10);
    store.stopExpiry();
    expect(timer).toBeUndefined();
    clock.t = cancelled.deadline;
    await cancelled.expire();
    expect(displayed).toEqual(['Club', 'Club', 'Invitation']);
    expect(mem.stored?.map((r) => r.rumorId)).toEqual(['new']);
  });

  it('kept at exactly 7 days, gone at 7 days + 1 ms (snapshot and persisted set after reconcile)', async () => {
    const s = setup();
    await s.store.add({ rumorId: 'old', sender: hex(1), groupId: 'aa', name: 'old' });
    s.clock.t += CONTEXT_TTL_MS;
    expect(s.ids()).toEqual(['old']);
    s.clock.t += 1;
    expect(s.ids()).toEqual([]); // lazily hidden
    await s.store.reconcile([]);
    expect(s.mem.stored).toEqual([]); // and purged from storage
  });

  it('retires an expired ID before deduping the arrival that first observes its expiry', async () => {
    const s = setup();
    const context = { rumorId: 'old', sender: hex(1), groupId: 'aa', name: 'Club' };
    await s.store.add(context);
    s.clock.t += CONTEXT_TTL_MS + 1;
    expect(await s.store.add(context)).toBe('duplicate');
    expect(s.ids()).toEqual([]);
    expect(await s.mem.port.load()).toEqual({
      records: [],
      tombstones: [{ rumorId: context.rumorId, removedAt: s.clock.t }],
    });
  });

  it.each(['recovers', 'disposes'])('backs off after an idle expiry save fails and %s', async (outcome) => {
    vi.useFakeTimers();
    try {
      const mem = memoryPort();
      let unavailable = false;
      const save = vi.fn<typeof mem.port.save>(async (records, tombstones) => {
        if (unavailable) throw new Error('IDB unavailable');
        await mem.port.save(records, tombstones);
      });
      const store = createInviteContextStore({
        port: { ...mem.port, save },
        now: Date.now,
        getPending: () => [],
        onError: vi.fn(),
        scheduleExpiry: (delay, expire) => {
          const timer = setTimeout(expire, delay);
          return () => clearTimeout(timer);
        },
      });
      const changed = vi.fn();
      store.subscribe(changed);
      const context = { rumorId: 'old', sender: hex(1), groupId: 'aa', name: 'Club' };
      await store.add(context);
      await vi.advanceTimersByTimeAsync(10);
      await store.add({ ...context, rumorId: 'other', groupId: 'bb' });
      unavailable = true;
      await vi.advanceTimersByTimeAsync(CONTEXT_TTL_MS - 9);
      const removedAt = Date.now();
      expect(store.snapshot().map((r) => r.rumorId)).toEqual(['other']);
      await vi.advanceTimersByTimeAsync(10);
      expect(store.snapshot()).toEqual([]);
      expect(changed).toHaveBeenCalledTimes(4);
      expect(mem.stored?.map((r) => r.rumorId)).toEqual(['old', 'other']);
      expect(await store.add(context)).toBe('duplicate');
      expect(save).toHaveBeenCalledTimes(3);

      const backoff = [990, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
      for (const [index, delay] of backoff.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(save).toHaveBeenCalledTimes(index + 3);
        await vi.advanceTimersByTimeAsync(1);
        expect(save).toHaveBeenCalledTimes(index + 4);
      }

      unavailable = false;
      if (outcome === 'disposes') store.stopExpiry();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(save).toHaveBeenCalledTimes(backoff.length + 3);
      await vi.advanceTimersByTimeAsync(1);
      if (outcome === 'recovers') {
        expect(save).toHaveBeenCalledTimes(backoff.length + 4);
        expect(await mem.port.load()).toEqual({
          records: [],
          tombstones: [{ rumorId: 'old', removedAt }, { rumorId: 'other', removedAt: removedAt + 10 }],
        });
      } else {
        expect(save).toHaveBeenCalledTimes(backoff.length + 3);
        expect(vi.getTimerCount()).toBe(0);
      }
      expect(changed).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only the expired entry goes; a newer one survives', async () => {
    const s = setup();
    await s.store.add({ rumorId: 'old', sender: hex(1), groupId: 'aa', name: 'o' });
    s.clock.t += 3 * 86_400_000;
    await s.store.add({ rumorId: 'new', sender: hex(1), groupId: 'bb', name: 'n' });
    s.clock.t += 4 * 86_400_000 + 1;
    await s.store.reconcile([]);
    expect(s.ids()).toEqual(['new']);
  });

  it('expiry is measured from arrival by the local clock, not from the sender-claimed created_at', async () => {
    const s = setup();
    await s.store.add({ rumorId: 'x', sender: hex(1), groupId: 'aa', name: 'x' });
    expect(s.store.snapshot()[0].receivedAt).toBe(s.clock.t);
  });
});

describe('sponsor validation when the invitation arrives', () => {
  it('a held context from the sponsor is kept and marked matched; one from anyone else is dropped', async () => {
    const s = setup();
    await add(s, 1, 'a0', 'sponsor name');
    await add(s, 2, 'a0', 'impostor name');
    await add(s, 3, 'a1', 'other group');
    await s.store.reconcile([inv('1', 1, 'a0')]);
    expect(s.store.snapshot().map((r) => [r.name, r.matched])).toEqual([['sponsor name', true], ['other group', false]]);
  });

  it('a context arriving AFTER its invitation from a non-sponsor is dropped at once; from the sponsor it is matched', async () => {
    const s = setup({ pending: () => [inv('1', 1, 'a0')] });
    expect(await add(s, 2, 'a0', 'impostor')).toBe('dropped');
    expect(await add(s, 1, 'a0', 'sponsor')).toBe('stored');
    expect(s.store.snapshot().map((r) => [r.name, r.matched])).toEqual([['sponsor', true]]);
  });

  it.each([true, false])('retires sponsor-mismatch IDs even after the pending invitation leaves (pending on arrival %s)', async (pendingOnArrival) => {
    const invitation = inv('1', 1, 'aa');
    let pending = pendingOnArrival ? [invitation] : [];
    const s = setup({ pending: () => pending });
    const mismatch = { rumorId: 'mismatch', sender: hex(2), groupId: 'aa', name: 'Discard this name' };
    expect(await s.store.add(mismatch)).toBe(pendingOnArrival ? 'dropped' : 'stored');
    await s.store.reconcile([invitation]);
    pending = [];
    expect(await s.mem.port.load()).toEqual({
      records: [],
      tombstones: [{ rumorId: mismatch.rumorId, removedAt: s.clock.t }],
    });
    expect(await s.store.add(mismatch)).toBe('duplicate');
    expect(s.ids()).toEqual([]);
  });

  it('a sender listed only in sponsors[] (not sponsorAccount) is accepted', async () => {
    const i = { ...inv('1', 1, 'a0'), sponsors: [hex(1), hex(5)] };
    const s = setup({ pending: () => [i] });
    expect(await add(s, 5, 'a0', 'via sponsors')).toBe('stored');
  });
});

describe('deletion: accept, decline, invitation leaving pending()', () => {
  it('a matched context is deleted when its invitation leaves the pending list', async () => {
    const s = setup();
    await add(s, 1, 'a0');
    await s.store.reconcile([inv('1', 1, 'a0')]);
    expect(s.ids()).toHaveLength(1);
    await s.store.reconcile([]); // accepted, declined, capped out or blocked
    expect(s.ids()).toEqual([]);
    expect(s.mem.stored).toEqual([]);
  });

  it('an unmatched held context is NOT deleted by a reconcile that merely does not list its group', async () => {
    const s = setup();
    await add(s, 1, 'a0');
    await s.store.reconcile([inv('9', 9, 'zz')]);
    expect(s.ids()).toHaveLength(1);
  });

  it('accept and decline through the cleanup decorator discard that group\'s contexts; a failed action keeps them', async () => {
    const s = setup();
    await add(s, 1, 'a0', 'A');
    await add(s, 1, 'b0', 'B');
    await add(s, 1, 'c0', 'C');
    const pending = [inv('1', 1, 'a0'), inv('2', 1, 'b0'), inv('3', 1, 'c0')];
    let failNext = false;
    const actions = withInviteContextCleanup({
      actions: {
        accept: async (_id: string) => ({}),
        decline: async (_id: string) => { if (failNext) throw new Error('nope'); },
      },
      view: { pending: () => pending },
      store: s.store,
    });
    await actions.accept('1');
    expect(s.store.snapshot().map((r) => r.name)).toEqual(['B', 'C']);
    failNext = true;
    await expect(actions.decline('2')).rejects.toThrow('nope');
    expect(s.store.snapshot().map((r) => r.name)).toEqual(['B', 'C']);
    failNext = false;
    await actions.decline('2');
    expect(s.store.snapshot().map((r) => r.name)).toEqual(['C']);
  });

  it('binding reconciles on every pending-list change and on reconcileNow()', async () => {
    const s = setup();
    await add(s, 1, 'a0');
    let list: ReturnType<typeof inv>[] = [inv('1', 1, 'a0')];
    const cbs = new Set<() => void>();
    const binding = bindInviteContextToPendingView({ view: { pending: () => list, onChange: (cb) => (cbs.add(cb), () => void cbs.delete(cb)) }, store: s.store });
    await binding.reconcileNow();
    expect(s.store.snapshot()[0].matched).toBe(true);
    list = [];
    cbs.forEach((cb) => cb());
    await s.store.load();
    await expect.poll(() => s.ids()).toEqual([]);
    binding.dispose();
    expect(cbs.size).toBe(0);
  });
});

describe('dedupe and replacement', () => {
  it('the same rumor id twice stores one entry; the same groupId+sender with a new rumor replaces the name', async () => {
    const s = setup();
    expect(await s.store.add({ rumorId: 'dup', sender: hex(1), groupId: 'aa', name: 'first' })).toBe('stored');
    expect(await s.store.add({ rumorId: 'dup', sender: hex(1), groupId: 'aa', name: 'first' })).toBe('duplicate');
    expect(s.ids()).toEqual(['dup']);
    expect(await s.store.add({ rumorId: 'dup2', sender: hex(1), groupId: 'aa', name: 'second' })).toBe('replaced');
    expect(await s.store.add({ rumorId: 'dup', sender: hex(1), groupId: 'aa', name: 'first' })).toBe('duplicate');
    expect(s.store.snapshot().map((r) => r.name)).toEqual(['second']);
  });

  it('keyed by groupId+sender: the same group from two senders keeps both entries (until validated)', async () => {
    const s = setup();
    await add(s, 1, 'aa', 'one');
    await add(s, 2, 'aa', 'two');
    expect(s.store.snapshot().map((r) => r.name)).toEqual(['one', 'two']);
  });

  it('a blank / hostile name is not stored', async () => {
    const s = setup();
    expect(await add(s, 1, 'aa', ' ‮ ')).toBe('dropped');
    expect(s.ids()).toEqual([]);
  });
});

describe('persistence', () => {
  it('writes the whole snapshot after every change and a fresh store restores the same set', async () => {
    const a = setup();
    await add(a, 1, 'aa', 'one');
    await add(a, 2, 'bb', 'two');
    const b = setup({ initial: a.mem.stored as InviteContextRecord[] });
    await b.store.load();
    expect(b.store.snapshot()).toEqual(a.store.snapshot());
  });

  it('restores insertion order from seq even when the storage hands records back out of order, and evicts the true oldest', async () => {
    const rec = (seq: number, sender: number): InviteContextRecord => ({ rumorId: `r${seq}`, groupId: `0${seq}`, sender: hex(sender), name: `n${seq}`, receivedAt: 1_000_000, seq, matched: false });
    // 8 entries of sender 1 persisted with seq 1..8, in scrambled order
    const scrambled = [5, 1, 8, 3, 7, 2, 6, 4].map((seq) => rec(seq, 1));
    const s = setup({ initial: scrambled });
    await s.store.load();
    expect(s.ids()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
    await s.store.add({ rumorId: 'r9', sender: hex(1), groupId: '99', name: 'n9' });
    expect(s.ids()).toEqual(['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']); // seq 1 (the true oldest) evicted
  });

  it('load drops corrupt persisted records and durably retires expired IDs', async () => {
    const good: InviteContextRecord = { rumorId: 'ok', groupId: 'aa', sender: hex(1), name: 'ok', receivedAt: 1_000_000, seq: 2, matched: false };
    const expired = { ...good, rumorId: 'old', seq: 1, receivedAt: 1_000_000 - CONTEXT_TTL_MS - 1 };
    const s = setup({ initial: [expired, good, { nonsense: true } as never] });
    await s.store.load();
    expect(s.ids()).toEqual(['ok']);
    expect(await s.mem.port.load()).toEqual({
      records: [good],
      tombstones: [{ rumorId: expired.rumorId, removedAt: s.clock.t }],
    });
    const reopened = createInviteContextStore({ port: s.mem.port, now: () => s.clock.t, getPending: () => [] });
    expect(await reopened.add(expired)).toBe('duplicate');
    expect(reopened.snapshot()).toEqual([good]);
  });

  it('a failing save is reported and the in-memory state still serves the card', async () => {
    const errors: unknown[] = [];
    const store = createInviteContextStore({ port: { load: async () => undefined, save: async () => { throw new Error('quota'); } }, now: () => 5, getPending: () => [], onError: (e) => void errors.push(e) });
    await store.add({ rumorId: 'x', sender: hex(1), groupId: 'aa', name: 'x' });
    expect(errors).toHaveLength(1);
    expect(store.snapshot()).toHaveLength(1);
  });

  it('subscribers fire after a change and not for a duplicate', async () => {
    const s = setup();
    let fired = 0;
    const off = s.store.subscribe(() => void fired++);
    await add(s, 1, 'aa');
    expect(fired).toBe(1);
    await s.store.add({ rumorId: `rumor-${n - 1}`, sender: hex(1), groupId: 'aa', name: 'N' });
    expect(fired).toBe(1);
    off();
    await add(s, 1, 'bb');
    expect(fired).toBe(1);
  });
});

describe('ports are validated at construction', () => {
  const ok = { port: memoryPort().port, now: () => 1, getPending: () => [] };
  it.each(['port', 'now', 'getPending'] as const)('missing %s throws', (k) => {
    expect(() => createInviteContextStore({ ...ok, [k]: undefined } as never)).toThrow(TypeError);
  });
  it('missing port.load / port.save throw', () => {
    expect(() => createInviteContextStore({ ...ok, port: { save: async () => undefined } } as never)).toThrow(/port\.load/);
    expect(() => createInviteContextStore({ ...ok, port: { load: async () => undefined } } as never)).toThrow(/port\.save/);
    expect(() => createInviteContextStore(undefined as never)).toThrow(TypeError);
  });
  it('the decorators and the binding validate their ports', () => {
    expect(() => bindInviteContextToPendingView({} as never)).toThrow(TypeError);
    expect(() => withInviteContextCleanup({} as never)).toThrow(TypeError);
  });
});

describe('trust-ranked eviction of held contexts', () => {
  const trusted = hex(100);
  const isTrustedSponsor = (sender: string) => sender === trusted;
  const fill = async (s: ReturnType<typeof setup>, count: number, prefix: string) => {
    // 8 per sender stays within the per-sender cap, so only the total cap evicts
    for (let i = 0; i < count; i++) await s.store.add({ rumorId: `${prefix}${i}`, sender: hex(1 + Math.floor(i / 8)), groupId: `${prefix}${i}`.padEnd(4, '0'), name: `${prefix}${i}` });
  };

  it('64 stranger contexts then one trusted: a stranger (the oldest) is evicted, the trusted one is held', async () => {
    const s = setup({ isTrustedSponsor });
    await fill(s, HELD_TOTAL_CAP, 's');
    expect(s.ids()).toHaveLength(HELD_TOTAL_CAP);
    expect(await s.store.add({ rumorId: 'trusted', sender: trusted, groupId: 'aaaa', name: 'T' })).toBe('stored');
    expect(s.ids()).toHaveLength(HELD_TOTAL_CAP);
    expect(s.ids()).toContain('trusted');
    expect(s.ids()).not.toContain('s0');
  });

  it('an OLDEST trusted context outlives a stranger flood (oldest-first alone would evict it)', async () => {
    const s = setup({ isTrustedSponsor });
    await s.store.add({ rumorId: 'trusted', sender: trusted, groupId: 'aaaa', name: 'T' });
    await fill(s, HELD_TOTAL_CAP, 's'); // 65 in total: one must go
    expect(s.ids()).toHaveLength(HELD_TOTAL_CAP);
    expect(s.ids()).toContain('trusted');
    expect(s.ids()).not.toContain('s0'); // the oldest STRANGER went
    expect(s.ids()).toContain('s1');
  });

  it('within the trusted class the oldest goes first once only trusted contexts remain over the cap', async () => {
    const s = setup({ isTrustedSponsor: () => true });
    await fill(s, HELD_TOTAL_CAP + 1, 't');
    expect(s.ids()).not.toContain('t0');
    expect(s.ids()).toHaveLength(HELD_TOTAL_CAP);
  });

  it('a throwing trust predicate counts as a stranger (fail closed)', async () => {
    const s = setup({ isTrustedSponsor: () => { throw new Error('boom'); } });
    await fill(s, HELD_TOTAL_CAP + 1, 'x');
    expect(s.ids()).toHaveLength(HELD_TOTAL_CAP);
    expect(s.ids()).not.toContain('x0');
  });
});

describe('tombstones: a discarded context does not come back on redelivery', () => {
  it('after discard (accept / decline) the same rumor id is a duplicate and stores nothing', async () => {
    const s = setup();
    await s.store.add({ rumorId: 'r1', sender: hex(1), groupId: 'a0', name: 'A' });
    await s.store.discard({ groupId: 'a0' });
    expect(s.ids()).toEqual([]);
    expect(await s.store.add({ rumorId: 'r1', sender: hex(1), groupId: 'a0', name: 'A' })).toBe('duplicate');
    expect(s.ids()).toEqual([]);
    expect(await s.store.add({ rumorId: 'r2', sender: hex(1), groupId: 'a0', name: 'A' })).toBe('stored'); // a NEW rumor is not blocked
  });

  it('a matched context that left with its invitation (reconcile) is tombstoned too', async () => {
    const s = setup();
    await add(s, 1, 'a0');
    const id = s.ids()[0];
    await s.store.reconcile([inv('1', 1, 'a0')]);
    await s.store.reconcile([]);
    expect(s.ids()).toEqual([]);
    expect(await s.store.add({ rumorId: id, sender: hex(1), groupId: 'a0', name: 'N' })).toBe('duplicate');
  });

  it('tombstones expire after 7 days and are bounded to 256 (oldest forgotten first)', async () => {
    const s = setup();
    await s.store.add({ rumorId: 'old', sender: hex(1), groupId: 'a0', name: 'A' });
    await s.store.discard({ groupId: 'a0' });
    s.clock.t += CONTEXT_TTL_MS;
    expect(await s.store.add({ rumorId: 'old', sender: hex(1), groupId: 'a0', name: 'A' })).toBe('duplicate'); // still within 7 days
    await s.store.discard({ groupId: 'a0' });
    s.clock.t += CONTEXT_TTL_MS + 1;
    expect(await s.store.add({ rumorId: 'old', sender: hex(1), groupId: 'a0', name: 'A' })).toBe('stored');

    expect(TOMBSTONE_CAP).toBe(256);
    const b = setup();
    for (let i = 0; i < TOMBSTONE_CAP + 1; i++) {
      await b.store.add({ rumorId: `d${i}`, sender: hex(1), groupId: 'a0', name: 'A' });
      await b.store.discard({ groupId: 'a0' });
    }
    const reopened = createInviteContextStore({ port: b.mem.port, now: () => b.clock.t, getPending: () => [] });
    expect(await reopened.add({ rumorId: 'd0', sender: hex(1), groupId: 'a0', name: 'A' })).toBe('stored'); // forgotten (oldest)
    await reopened.discard({ groupId: 'a0' });
    expect(await reopened.add({ rumorId: `d${TOMBSTONE_CAP}`, sender: hex(1), groupId: 'a0', name: 'A' })).toBe('duplicate'); // newest kept
  });
});

describe('a failed load is retried and never overwrites persisted data', () => {
  it('port.load rejecting once: nothing is saved meanwhile, the next call retries and merges with the stored snapshot', async () => {
    const stored: InviteContextRecord = { rumorId: 'persisted', groupId: 'aa', sender: hex(1), name: 'persisted', receivedAt: 1_000_000, seq: 7, matched: false };
    let loads = 0;
    const saves: InviteContextRecord[][] = [];
    const errors: unknown[] = [];
    const store = createInviteContextStore({
      port: {
        load: async () => {
          if (++loads === 1) throw new Error('idb unavailable');
          return [stored];
        },
        save: async (records) => void saves.push(records.map((r) => ({ ...r }))),
      },
      now: () => 1_000_000,
      getPending: () => [],
      onError: (e) => void errors.push(e),
    });
    expect(await store.add({ rumorId: 'first', sender: hex(2), groupId: 'bb', name: 'first' })).toBe('stored');
    expect(errors).toHaveLength(1);
    expect(saves).toEqual([]); // the persisted snapshot is NOT replaced by a blank one
    expect(store.snapshot().map((r) => r.rumorId)).toEqual(['first']); // the card still sees it

    expect(await store.add({ rumorId: 'second', sender: hex(2), groupId: 'cc', name: 'second' })).toBe('stored');
    expect(loads).toBe(2); // retried
    const last = saves[saves.length - 1];
    expect(last.map((r) => r.rumorId).sort()).toEqual(['first', 'persisted', 'second']);
    expect(saves.every((snap) => snap.some((r) => r.rumorId === 'persisted'))).toBe(true);
    const seqs = last.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no seq collisions after the merge
    await store.load();
    expect(loads).toBe(2); // a successful load is not repeated
  });

  it('a load that keeps failing keeps retrying on every call and never saves', async () => {
    let loads = 0;
    let saved = 0;
    const store = createInviteContextStore({ port: { load: async () => { loads++; throw new Error('x'); }, save: async () => void saved++ }, now: () => 1, getPending: () => [], onError: () => undefined });
    await store.add({ rumorId: 'a', sender: hex(1), groupId: 'aa', name: 'a' });
    await store.add({ rumorId: 'b', sender: hex(1), groupId: 'bb', name: 'b' });
    await store.load();
    expect(loads).toBe(3);
    expect(saved).toBe(0);
  });
});
