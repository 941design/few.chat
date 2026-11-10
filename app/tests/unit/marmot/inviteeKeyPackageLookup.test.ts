/**
 * Invitee KeyPackage lookup: relay-list resolution, pool + listed-relay fetch,
 * signature verification, no NDK-pool side effects.
 * Spec: bug-reports/invite-lookup-ignores-invitee-s-keypackage-report.md
 */
import { describe, it, expect, vi } from 'vitest';
import {
  lookupInviteeKeyPackages,
  parseInviteeRelayList,
  LISTED_RELAY_TIMEOUT_MS,
  type LookupEvent,
} from '@/src/lib/marmot/inviteeKeyPackageLookup';

const INVITEE = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
/** Stand-in verifier: sig 'bad' = forged. */
const verify = (e: LookupEvent) => e.sig !== 'bad';

const relayList = (
  urls: unknown[],
  o: { kind?: number; d?: string | null; pubkey?: string; created_at?: number; id?: string; sig?: string } = {},
): LookupEvent => {
  const kind = o.kind ?? 30051;
  const d = o.d === undefined ? 'marmot' : o.d;
  return {
    id: o.id ?? `rl-${Math.random()}`,
    pubkey: o.pubkey ?? INVITEE,
    kind,
    created_at: o.created_at ?? 100,
    sig: o.sig ?? 'ok',
    tags: [...(d === null ? [] : [['d', d]]), ...urls.map((u) => ['relay', u])],
  };
};
const kp = (id: string, o: { pubkey?: string; sig?: string; kind?: number } = {}): LookupEvent => ({
  id,
  pubkey: o.pubkey ?? INVITEE,
  kind: o.kind ?? 30443,
  created_at: 1,
  sig: o.sig ?? 'ok',
  tags: [],
});

function world(opts: {
  poolHas?: LookupEvent[];
  relayHas?: Record<string, LookupEvent[]>;
  failRelays?: string[];
  timeoutRelays?: string[];
  poolTimesOut?: boolean;
  covered?: string[];
  listFetch?: () => Promise<{ events: LookupEvent[]; timedOut: boolean }>;
}) {
  const calls: string[] = [];
  const deps = {
    fetchPool: vi.fn(async (filter: { kinds: number[] }) => {
      const isList = filter.kinds.includes(30051);
      calls.push(isList ? 'pool:list' : 'pool:kp');
      if (isList && opts.listFetch) return opts.listFetch();
      const own = (opts.poolHas ?? []).filter((e) => filter.kinds.includes(e.kind!));
      return { events: own, timedOut: !isList && !!opts.poolTimesOut };
    }),
    fetchListed: vi.fn(async (url: string, filter: { kinds: number[] }, _timeoutMs: number) => {
      calls.push(`listed:${url}`);
      if (opts.failRelays?.includes(url)) throw new Error('relay down');
      // A hostile relay may answer with anything, whatever the filter says.
      return { events: opts.relayHas?.[url] ?? [], timedOut: !!opts.timeoutRelays?.includes(url) };
    }),
    verifyEvent: vi.fn(verify),
    coveredRelayUrls: vi.fn(() => opts.covered ?? ['wss://mine.example']),
  };
  return { deps, calls };
}

describe('lookupInviteeKeyPackages', () => {
  it('finds a KeyPackage on a relay the invitee lists even though the pool holds none (the bug)', async () => {
    const w = world({ poolHas: [relayList(['wss://theirs.example'])], relayHas: { 'wss://theirs.example': [kp('kp1')] } });
    const r = await lookupInviteeKeyPackages(w.deps, INVITEE);
    expect(r).toEqual({ ok: true, events: [expect.objectContaining({ id: 'kp1' })] });
  });

  it('asks a listed relay only for the KeyPackage kinds, bounded to 5 s', async () => {
    const w = world({ poolHas: [relayList(['wss://theirs.example'])] });
    await lookupInviteeKeyPackages(w.deps, INVITEE);
    expect(w.deps.fetchListed).toHaveBeenCalledTimes(1);
    const [url, filter, timeout] = w.deps.fetchListed.mock.calls[0];
    expect(url).toBe('wss://theirs.example');
    expect(filter.kinds).toEqual([443, 30443]);
    expect(timeout).toBe(5_000);
    expect(LISTED_RELAY_TIMEOUT_MS).toBe(5_000);
  });

  it('has no NDK pool side effect: listed relays never go through the pool request', async () => {
    const w = world({ poolHas: [relayList(['wss://theirs.example'])], relayHas: { 'wss://theirs.example': [kp('x')] } });
    await lookupInviteeKeyPackages(w.deps, INVITEE);
    // the pool request takes no relay set and the helper has no way to add or remove pool relays
    expect(w.deps.fetchPool.mock.calls.every((c) => c.length === 1)).toBe(true);
    expect(Object.keys(w.deps).sort()).toEqual(['coveredRelayUrls', 'fetchListed', 'fetchPool', 'verifyEvent']);
  });

  it('merges KeyPackages from several listed relays, deduped by id, when the pool has none', async () => {
    const w = world({
      poolHas: [relayList(['wss://one.example', 'wss://two.example'])],
      relayHas: { 'wss://one.example': [kp('b')], 'wss://two.example': [kp('b'), kp('c')] },
    });
    const r = await lookupInviteeKeyPackages(w.deps, INVITEE);
    expect(r.ok && r.events.map((e) => e.id).sort()).toEqual(['b', 'c']);
  });

  it('queries a listed relay that is not covered even if it is one of the inviter\'s own saved relays', async () => {
    // covered = what the pool request actually asks (connected permanent relays); a saved
    // custom relay outside it must still be asked directly.
    const w = world({
      poolHas: [relayList(['wss://saved-custom.example'])],
      relayHas: { 'wss://saved-custom.example': [kp('found')] },
      covered: ['wss://mine.example'],
    });
    const r = await lookupInviteeKeyPackages(w.deps, INVITEE);
    expect(w.deps.fetchListed).toHaveBeenCalledWith('wss://saved-custom.example', expect.anything(), 5000);
    expect(r.ok).toBe(true);
  });

  it('uses the coverage as it was when the pool request was issued, not a later one (connect race)', async () => {
    const w = world({ poolHas: [relayList(['wss://late.example'])], relayHas: { 'wss://late.example': [kp('found')] } });
    // empty until the pool KeyPackage request has been issued; the listed relay "connects" after that
    w.deps.coveredRelayUrls.mockImplementation(() => (w.calls.includes('pool:kp') ? ['wss://late.example'] : []));
    const r = await lookupInviteeKeyPackages(w.deps, INVITEE);
    expect(w.deps.coveredRelayUrls).toHaveBeenCalledTimes(1);
    expect(w.deps.fetchListed).toHaveBeenCalledWith('wss://late.example', expect.anything(), 5000);
    expect(r.ok).toBe(true);
  });

  it('matches a pooled relay with a query in NDK\'s form (trailing slash after the query) and does not query it twice', async () => {
    const w = world({
      poolHas: [relayList(['wss://relay.x/?t=a', 'wss://plain.example', 'wss://other.example'])],
      covered: ['wss://relay.x/?t=a/', 'wss://plain.example/'],
    });
    await lookupInviteeKeyPackages(w.deps, INVITEE);
    expect(w.deps.fetchListed.mock.calls.map((c) => c[0])).toEqual(['wss://other.example']);
  });

  it('keeps two listed relays that differ only in their query distinct (and covered only on an exact match)', async () => {
    const w = world({
      poolHas: [relayList(['wss://r.example/?token=a', 'wss://r.example/?token=b'])],
      covered: ['wss://r.example/?token=a'],
    });
    await lookupInviteeKeyPackages(w.deps, INVITEE);
    expect(w.deps.fetchListed.mock.calls.map((c) => c[0])).toEqual(['wss://r.example?token=b']);
  });

  it('returns a usable pool KeyPackage without waiting for a silent listed relay, leaving nothing unhandled', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectListed!: (e: Error) => void;
      const w = world({ poolHas: [relayList(['wss://silent.example']), kp('a')] });
      w.deps.fetchListed.mockImplementation(
        () => new Promise((_res, rej) => (rejectListed = rej)),
      );
      const r = await lookupInviteeKeyPackages(w.deps, INVITEE);
      expect(r.ok && r.events.map((e) => e.id)).toEqual(['a']);
      await new Promise((res) => setTimeout(res, 5)); // let the abandoned listed request start
      expect(w.deps.fetchListed).toHaveBeenCalledTimes(1);
      rejectListed(new Error('late failure'));
      await new Promise((res) => setTimeout(res, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('still waits for the listed relays when the pool holds no usable KeyPackage (forged one does not count)', async () => {
    let resolveListed!: (v: { events: LookupEvent[]; timedOut: boolean }) => void;
    const w = world({ poolHas: [relayList(['wss://slow.example']), kp('forged', { sig: 'bad' })] });
    w.deps.fetchListed.mockImplementation(() => new Promise((res) => (resolveListed = res)));
    let done = false;
    const p = lookupInviteeKeyPackages(w.deps, INVITEE).then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    resolveListed({ events: [kp('real')], timedOut: false });
    expect((await p).ok).toBe(true);
  });

  it('succeeds from the pool alone when the invitee lists no relays', async () => {
    const w = world({ poolHas: [kp('a')] });
    expect((await lookupInviteeKeyPackages(w.deps, INVITEE)).ok).toBe(true);
    expect(w.deps.fetchListed).not.toHaveBeenCalled();
  });

  it('skips a listed relay the pool request already covers (compared normalised)', async () => {
    const w = world({ poolHas: [relayList(['wss://theirs.example/']), kp('a')], covered: ['wss://THEIRS.example'] });
    await lookupInviteeKeyPackages(w.deps, INVITEE);
    expect(w.deps.fetchListed).not.toHaveBeenCalled();
  });

  it('starts the pool KeyPackage fetch before the relay-list fetch resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = world({
      poolHas: [kp('a')],
      listFetch: async () => {
        await gate;
        return { events: [], timedOut: false };
      },
    });
    const p = lookupInviteeKeyPackages(w.deps, INVITEE);
    await new Promise((r) => setTimeout(r, 0));
    expect(w.calls.slice().sort()).toEqual(['pool:kp', 'pool:list']); // both started while the list is still pending
    release();
    expect((await p).ok).toBe(true);
  });

  describe('requests are exactly scoped', () => {
    it('asks the pool for exactly the invitee\'s relay-list kinds and KeyPackage kinds, nothing else', async () => {
      const w = world({ poolHas: [relayList(['wss://theirs.example'])] });
      await lookupInviteeKeyPackages(w.deps, INVITEE);
      const filters = w.deps.fetchPool.mock.calls.map((c) => c[0]);
      expect(filters).toContainEqual({ kinds: [30051, 10051], authors: [INVITEE], limit: 10 });
      expect(filters).toContainEqual({ kinds: [443, 30443], authors: [INVITEE], limit: 5 });
      expect(filters).toHaveLength(2);
    });

    it('asks every listed relay for exactly the KeyPackage filter', async () => {
      const w = world({ poolHas: [relayList(['wss://one.example', 'wss://two.example'])] });
      await lookupInviteeKeyPackages(w.deps, INVITEE);
      expect(w.deps.fetchListed.mock.calls).toEqual([
        ['wss://one.example', { kinds: [443, 30443], authors: [INVITEE], limit: 5 }, 5000],
        ['wss://two.example', { kinds: [443, 30443], authors: [INVITEE], limit: 5 }, 5000],
      ]);
    });
  });

  describe('failure handling around the relay list', () => {
    const noList = (w: ReturnType<typeof world>, fail: (f: { kinds: number[] }) => boolean) => {
      const inner = w.deps.fetchPool.getMockImplementation()!;
      w.deps.fetchPool.mockImplementation(async (f: { kinds: number[] }) => {
        if (fail(f)) throw new Error('boom');
        return inner(f);
      });
    };

    it('a throwing relay-list fetch with nothing on the pool is no_key_package (not timeout) and no listed relay is asked', async () => {
      const w = world({ poolHas: [] });
      noList(w, (f) => f.kinds.includes(30051));
      expect(await lookupInviteeKeyPackages(w.deps, INVITEE)).toEqual({ ok: false, error: 'no_key_package' });
      expect(w.deps.fetchListed).not.toHaveBeenCalled();
    });

    it('a verifier that throws on the relay list means no listed relay is asked', async () => {
      const w = world({ poolHas: [relayList(['wss://theirs.example'])] });
      w.deps.verifyEvent.mockImplementation((e: LookupEvent) => {
        if (e.kind === 30051) throw new Error('boom');
        return true;
      });
      expect(await lookupInviteeKeyPackages(w.deps, INVITEE)).toEqual({ ok: false, error: 'no_key_package' });
      expect(w.deps.fetchListed).not.toHaveBeenCalled();
    });

    it('a verifier that throws on a KeyPackage treats it as invalid without throwing', async () => {
      const w = world({ poolHas: [relayList(['wss://theirs.example']), kp('a')], relayHas: { 'wss://theirs.example': [kp('b')] } });
      w.deps.verifyEvent.mockImplementation((e: LookupEvent) => {
        if (e.kind === 30443) throw new Error('boom');
        return true;
      });
      expect(await lookupInviteeKeyPackages(w.deps, INVITEE)).toEqual({ ok: false, error: 'no_key_package' });
    });

    it('a throwing coveredRelayUrls means every listed relay is asked', async () => {
      const w = world({ poolHas: [relayList(['wss://one.example', 'wss://two.example'])] });
      w.deps.coveredRelayUrls.mockImplementation(() => {
        throw new Error('boom');
      });
      await lookupInviteeKeyPackages(w.deps, INVITEE);
      expect(w.deps.fetchListed.mock.calls.map((c) => c[0])).toEqual(['wss://one.example', 'wss://two.example']);
    });

    it('covered URLs that cannot be normalised are harmless; the other listed relays are still asked', async () => {
      const w = world({ poolHas: [relayList(['wss://one.example'])], covered: ['ws://remote.example/', 'garbage', ''] });
      await lookupInviteeKeyPackages(w.deps, INVITEE);
      expect(w.deps.fetchListed.mock.calls.map((c) => c[0])).toEqual(['wss://one.example']);
    });
  });

  describe('events without ids', () => {
    it('keeps two usable events that have no id, and collapses two with the same id', async () => {
      const noId = (n: number): LookupEvent => ({ pubkey: INVITEE, kind: 30443, created_at: n, sig: 'ok', tags: [] });
      const w = world({ poolHas: [noId(1), noId(2)] });
      const r = await lookupInviteeKeyPackages(w.deps, INVITEE);
      expect(r.ok && r.events).toHaveLength(2);
      const w2 = world({ poolHas: [kp('same'), kp('same')] });
      const r2 = await lookupInviteeKeyPackages(w2.deps, INVITEE);
      expect(r2.ok && r2.events).toHaveLength(1);
    });
  });

  describe('signatures and authorship', () => {
    it('ignores a forged relay list from the pool', async () => {
      const w = world({ poolHas: [relayList(['wss://evil.example'], { sig: 'bad' })], relayHas: { 'wss://evil.example': [kp('x')] } });
      expect(await lookupInviteeKeyPackages(w.deps, INVITEE)).toEqual({ ok: false, error: 'no_key_package' });
      expect(w.deps.fetchListed).not.toHaveBeenCalled();
    });

    it('ignores a forged KeyPackage from the pool', async () => {
      const w = world({ poolHas: [kp('forged', { sig: 'bad' })] });
      expect(await lookupInviteeKeyPackages(w.deps, INVITEE)).toEqual({ ok: false, error: 'no_key_package' });
    });

    it('ignores a forged KeyPackage from a listed relay but keeps the genuine one', async () => {
      const w = world({
        poolHas: [relayList(['wss://theirs.example'])],
        relayHas: { 'wss://theirs.example': [kp('forged', { sig: 'bad' }), kp('real')] },
      });
      const r = await lookupInviteeKeyPackages(w.deps, INVITEE);
      expect(r.ok && r.events.map((e) => e.id)).toEqual(['real']);
    });

    it('ignores another author\'s KeyPackage and non-KeyPackage kinds from a listed relay, even if validly signed', async () => {
      const w = world({
        poolHas: [relayList(['wss://theirs.example'])],
        relayHas: { 'wss://theirs.example': [kp('theirs', { pubkey: OTHER }), kp('wrongkind', { kind: 1 })] },
      });
      expect(await lookupInviteeKeyPackages(w.deps, INVITEE)).toEqual({ ok: false, error: 'no_key_package' });
    });

    it('a verifier that throws counts as a failed verification, never as fatal', async () => {
      const w = world({ poolHas: [kp('a')] });
      w.deps.verifyEvent.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(await lookupInviteeKeyPackages(w.deps, INVITEE)).toEqual({ ok: false, error: 'no_key_package' });
    });
  });

  describe('result codes', () => {
    it('no_key_package when pool and listed relays hold none', async () => {
      const w = world({ poolHas: [relayList(['wss://theirs.example'])] });
      expect(await lookupInviteeKeyPackages(w.deps, INVITEE)).toEqual({ ok: false, error: 'no_key_package' });
    });

    it('timeout when nothing was found and the pool fetch timed out', async () => {
      const w = world({ poolTimesOut: true });
      expect(await lookupInviteeKeyPackages(w.deps, INVITEE)).toEqual({ ok: false, error: 'timeout' });
    });

    it('timeout when nothing was found and a listed-relay fetch timed out', async () => {
      const w = world({ poolHas: [relayList(['wss://slow.example'])], timeoutRelays: ['wss://slow.example'] });
      expect(await lookupInviteeKeyPackages(w.deps, INVITEE)).toEqual({ ok: false, error: 'timeout' });
    });

    it('a timeout does not mask a KeyPackage found elsewhere', async () => {
      const w = world({ poolHas: [relayList(['wss://theirs.example']), kp('a')], poolTimesOut: true });
      expect((await lookupInviteeKeyPackages(w.deps, INVITEE)).ok).toBe(true);
    });

    it('a throwing listed relay is not fatal and the pool result stands', async () => {
      const w = world({ poolHas: [relayList(['wss://down.example']), kp('a')], failRelays: ['wss://down.example'] });
      expect((await lookupInviteeKeyPackages(w.deps, INVITEE)).ok).toBe(true);
    });

    it('a throwing listed relay with nothing found is no_key_package, not an error', async () => {
      const w = world({ poolHas: [relayList(['wss://down.example'])], failRelays: ['wss://down.example'] });
      expect(await lookupInviteeKeyPackages(w.deps, INVITEE)).toEqual({ ok: false, error: 'no_key_package' });
    });

    it('a failing relay-list fetch degrades to a pool-only lookup', async () => {
      const w = world({
        poolHas: [kp('a')],
        listFetch: async () => {
          throw new Error('boom');
        },
      });
      expect((await lookupInviteeKeyPackages(w.deps, INVITEE)).ok).toBe(true);
    });

    it('a throwing pool KeyPackage fetch propagates (caller reports generic)', async () => {
      const w = world({ poolHas: [relayList(['wss://theirs.example'])] });
      const inner = w.deps.fetchPool.getMockImplementation()!;
      w.deps.fetchPool.mockImplementation(async (f: { kinds: number[] }) => {
        if (f.kinds.includes(443)) throw new Error('pool down');
        return inner(f);
      });
      await expect(lookupInviteeKeyPackages(w.deps, INVITEE)).rejects.toThrow('pool down');
    });
  });

  it('never touches localStorage (saved relay setting)', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: setItem });
    try {
      const w = world({ poolHas: [relayList(['wss://theirs.example'])] });
      await lookupInviteeKeyPackages(w.deps, INVITEE);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('parseInviteeRelayList', () => {
  const parse = (evs: LookupEvent[]) => parseInviteeRelayList(evs, INVITEE, verify);

  it('prefers kind 30051 d=marmot over kind 10051, whichever is newer', () => {
    expect(
      parse([
        relayList(['wss://inbox.example'], { kind: 10051, d: null, created_at: 500 }),
        relayList(['wss://marmot.example'], { created_at: 1 }),
      ]),
    ).toEqual(['wss://marmot.example']);
  });

  it('falls back to kind 10051 when there is no 30051 d=marmot', () => {
    expect(parse([relayList(['wss://inbox.example'], { kind: 10051, d: null })])).toEqual(['wss://inbox.example']);
  });

  it('ignores a 30051 with another d tag or none', () => {
    expect(parse([relayList(['wss://x.example'], { d: 'other' }), relayList(['wss://y.example'], { d: null })])).toEqual([]);
    expect(
      parse([
        relayList(['wss://x.example'], { d: 'other' }),
        relayList(['wss://inbox.example'], { kind: 10051, d: null }),
      ]),
    ).toEqual(['wss://inbox.example']);
  });

  it('uses only events authored by the invitee', () => {
    expect(parse([relayList(['wss://evil.example'], { pubkey: OTHER, created_at: 999 })])).toEqual([]);
    expect(
      parse([
        relayList(['wss://evil.example'], { pubkey: OTHER, created_at: 999 }),
        relayList(['wss://good.example'], { created_at: 1 }),
      ]),
    ).toEqual(['wss://good.example']);
  });

  it('takes the newest event of the chosen kind', () => {
    expect(
      parse([
        relayList(['wss://old.example'], { created_at: 10 }),
        relayList(['wss://new.example'], { created_at: 20 }),
        relayList(['wss://older.example'], { created_at: 5 }),
      ]),
    ).toEqual(['wss://new.example']);
  });

  it('ignores a relay list that fails signature verification', () => {
    expect(parse([relayList(['wss://evil.example'], { sig: 'bad', created_at: 999 })])).toEqual([]);
    expect(parse([relayList(['wss://evil.example'], { sig: 'bad', created_at: 999 }), relayList(['wss://good.example'], { created_at: 1 })])).toEqual(['wss://good.example']);
  });

  it('is total: malformed tags, null elements and a throwing verifier are skipped, never thrown', () => {
    const weird = [
      { pubkey: INVITEE, kind: 30051, created_at: 1, sig: 'ok', tags: 'nope' },
      { pubkey: INVITEE, kind: 30051, created_at: 2, sig: 'ok', tags: [null, undefined, 'x', ['d', 'marmot'], null, ['relay', 'wss://ok.example']] },
      null,
      undefined,
    ] as unknown as LookupEvent[];
    expect(parse(weird)).toEqual(['wss://ok.example']);
    expect(parseInviteeRelayList([relayList(['wss://a.example'])], INVITEE, () => { throw new Error('x'); })).toEqual([]);
  });

  it('does not take a 30051 as Few\'s list when "marmot" sits in a non-d tag', () => {
    const ev = { pubkey: INVITEE, kind: 30051, created_at: 1, sig: 'ok', tags: [['x', 'marmot'], ['relay', 'wss://x.example']] } as LookupEvent;
    expect(parse([ev])).toEqual([]);
  });

  it('takes URLs only from relay tags', () => {
    const ev = {
      pubkey: INVITEE, kind: 30051, created_at: 1, sig: 'ok',
      tags: [['d', 'marmot'], ['r', 'wss://r.example'], ['p', 'wss://p.example'], ['relay', 'wss://ok.example']],
    } as LookupEvent;
    expect(parse([ev])).toEqual(['wss://ok.example']);
  });

  it('returns [] when there are no events', () => {
    expect(parse([])).toEqual([]);
  });

  describe('URL filtering', () => {
    const urls = (raw: unknown[]) =>
      parse([{ pubkey: INVITEE, kind: 30051, created_at: 1, sig: 'ok', tags: [['d', 'marmot'], ...raw.map((u) => ['relay', u as string])] }]);

    it('drops invalid URLs and non-relay schemes', () => {
      expect(urls(['not a url', 'https://r.example', 'http://r.example', '', 'wss://', 'javascript:alert(1)', 'wss://ok.example'])).toEqual(['wss://ok.example']);
    });

    it('drops a relay tag without a url', () => {
      expect(parse([{ pubkey: INVITEE, kind: 30051, created_at: 1, sig: 'ok', tags: [['d', 'marmot'], ['relay'], ['relay', 'wss://ok.example']] }])).toEqual(['wss://ok.example']);
    });

    it('accepts ws:// only for localhost', () => {
      expect(urls(['ws://remote.example', 'ws://192.168.1.5', 'ws://localhost:7777', 'ws://127.0.0.1:7777', 'ws://[::1]:7777'])).toEqual([
        'ws://localhost:7777',
        'ws://127.0.0.1:7777',
        'ws://[::1]:7777',
      ]);
    });

    it('rejects a lookalike host and an uppercase non-local ws scheme; accepts uppercase localhost', () => {
      expect(urls(['ws://localhost.evil.com', 'WS://remote.example', 'WS://LOCALHOST:1'])).toEqual(['ws://localhost:1']);
    });

    it('skips non-string relay values instead of throwing', () => {
      expect(urls([null, 42, { a: 1 }, ['x'], 'wss://ok.example'])).toEqual(['wss://ok.example']);
    });

    it('keeps the query (distinct endpoints stay distinct) but drops the fragment', () => {
      expect(urls(['wss://r.example/?token=abc#frag', 'wss://r.example/?token=def', 'wss://r.example/p/?x=1'])).toEqual([
        'wss://r.example?token=abc',
        'wss://r.example?token=def',
        'wss://r.example/p?x=1',
      ]);
    });

    it('drops a URL with only a username, and one with only a password', () => {
      expect(urls(['wss://user@r.example', 'wss://:pw@r.example', 'wss://ok.example'])).toEqual(['wss://ok.example']);
    });

    it('drops every trailing slash', () => {
      expect(urls(['wss://relay.example///'])).toEqual(['wss://relay.example']);
    });

    it('drops URLs with credentials', () => {
      expect(urls(['wss://user:pw@r.example', 'wss://ok.example'])).toEqual(['wss://ok.example']);
    });

    it('normalises: trim, lowercase scheme and host, drop trailing slash and hash', () => {
      expect(urls(['  WSS://Relay.Example/  ', 'wss://a.example/path/#h'])).toEqual(['wss://relay.example', 'wss://a.example/path']);
    });

    it('dedupes after normalisation', () => {
      expect(urls(['wss://r.example', 'wss://r.example/', 'WSS://R.EXAMPLE'])).toEqual(['wss://r.example']);
    });

    it('caps at 3 valid relays in list order (invalid ones do not use up the cap)', () => {
      expect(urls(['wss://1.example', 'bad', 'wss://2.example', 'wss://3.example', 'wss://4.example', 'wss://5.example'])).toEqual([
        'wss://1.example',
        'wss://2.example',
        'wss://3.example',
      ]);
    });
  });
});
