// @vitest-environment node
/**
 * Unit tests for the invitee key-package lookup and the single-candidate invite (S8).
 *
 *  AC-KP-1  group.invite gets exactly one key-package event per call; invalid-options falls through to the next
 *           candidate; success stops; exhaustion is the value {error:'no usable key package'}.
 *  AC-KP-2  the lookup asks transport.requestWithDeadline with {kinds:[30443], authors:[pk]} over the de-duplicated
 *           union of the invitee's 10050 relays, 10002 write relays and the app defaults; nothing found (EOSE or
 *           deadline) is reported; an invitee advertising a relay outside the defaults is found (commit aa39de3).
 *  AC-KP-3  equal created_at: lexicographically lower event id first.
 *  Review hardening: no double add (already-member), rejection allowlist, relay URL policy split (app defaults as
 *           given, advertised: public wss only), candidate cap + cheap checks before signature verification,
 *           normalised abort, timeout bound.
 *
 * Events are REAL signed events (nostr-tools finalizeEvent); the transport is a recording fake that answers per
 * relay set from a fixture store, so a stub that never queries (or queries the wrong relays) fails. The inviter
 * runs over the REAL GroupOpQueue and a recording group.
 */
import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from '@941design/nostr-events/event';
import type { Filter } from '@941design/nostr-events/event';
import type { RequestWithDeadlineResult, TransportContract } from '@941design/nostr-events/transport/contract';
import { MarmotError } from '@941design/marmot';
import { createGroupOpQueue, GroupOpError } from '@/src/lib/marmot/send';
import {
  createKeyPackageInviter,
  createKeyPackageLookup,
  KEY_PACKAGE_KIND,
  MAX_ADVERTISED_RELAYS,
  MAX_KEY_PACKAGE_CANDIDATES,
  normaliseAdvertisedRelayUrl,
  normaliseRelayUrl,
  orderKeyPackageCandidates,
  type InviteGroup,
} from '@/src/lib/marmot/invitations';

const SK_INVITEE = Uint8Array.from(Buffer.from('c3'.repeat(32), 'hex'));
const SK_OTHER = Uint8Array.from(Buffer.from('d4'.repeat(32), 'hex'));
const INVITEE = getPublicKey(SK_INVITEE);
const OTHER = getPublicKey(SK_OTHER);
const DEFAULT = 'wss://default.example';
const RELAY_X = 'wss://invitee-advertised.example';
const RELAY_Y = 'wss://invitee-write.example';

const sign = (sk: Uint8Array, kind: number, created_at: number, tags: string[][] = [], content = ''): NostrEvent =>
  finalizeEvent({ kind, created_at, tags, content }, sk) as NostrEvent;
const kp = (created_at: number, content = `kp-${created_at}`, sk = SK_INVITEE) => sign(sk, KEY_PACKAGE_KIND, created_at, [['d', content]], content);
const inboxList = (relays: string[], created_at = 100, sk = SK_INVITEE) => sign(sk, 10050, created_at, relays.map((r) => ['relay', r]));
const nip65 = (rs: Array<[string] | [string, 'read' | 'write']>, created_at = 100, sk = SK_INVITEE) => sign(sk, 10002, created_at, rs.map((r) => ['r', ...r]));

interface Call {
  relays: string[];
  filters: Filter[];
  opts: { timeoutMs: number; signal?: AbortSignal };
}

/** Recording transport: each event lives on a set of relays; a request returns the matching events of the asked relays. */
function recordingTransport(store: Array<{ event: NostrEvent; on: string[] }>, over: Partial<{ timedOut: boolean; fail: (call: Call) => Error | undefined; extra: (call: Call) => NostrEvent[] }> = {}) {
  const calls: Call[] = [];
  const transport: Pick<TransportContract, 'requestWithDeadline'> = {
    async requestWithDeadline(relays, filters, opts): Promise<RequestWithDeadlineResult> {
      const call: Call = { relays: [...relays], filters: Array.isArray(filters) ? filters : [filters], opts };
      calls.push(call);
      const err = over.fail?.(call);
      if (err) throw err;
      const events = store
        .filter((s) => s.on.some((r) => relays.includes(r)))
        .map((s) => s.event)
        .filter((e) => call.filters.some((f) => (f.kinds ?? []).includes(e.kind) && (f.authors ?? []).includes(e.pubkey)));
      return { events: [...events, ...(over.extra?.(call) ?? [])], timedOut: over.timedOut ?? false, eosedRelays: [...relays], silentRelays: [] };
    },
  };
  return { transport, calls, kpCalls: () => calls.filter((c) => c.filters.some((f) => f.kinds?.includes(KEY_PACKAGE_KIND))) };
}

const lookupOf = (t: Pick<TransportContract, 'requestWithDeadline'>, defaultRelays = [DEFAULT], extra: Partial<Parameters<typeof createKeyPackageLookup>[0]> = {}) =>
  createKeyPackageLookup({ transport: t, defaultRelays, timeoutMs: 1000, ...extra });

describe('AC-KP-3 candidate order: created_at desc, tie lower event id', () => {
  it('orders newest first and breaks created_at ties by the lexicographically lower id, whatever the input order', () => {
    const tied = [kp(500, 'a'), kp(500, 'b'), kp(500, 'c'), kp(500, 'd')];
    const idsAsc = tied.map((e) => e.id).sort();
    const events = [kp(100, 'old'), ...tied, kp(900, 'new'), kp(500, 'e')];
    const ordered = orderKeyPackageCandidates(events);
    expect(ordered[0].created_at).toBe(900);
    expect(ordered.at(-1)!.created_at).toBe(100);
    const mid = ordered.slice(1, -1).map((e) => e.id);
    expect(mid).toEqual([...idsAsc, kp(500, 'e').id].sort());
    // every rotation / reversal of the input yields the same order
    for (let i = 0; i < events.length; i++) {
      const rotated = [...events.slice(i), ...events.slice(0, i)];
      expect(orderKeyPackageCandidates(rotated).map((e) => e.id)).toEqual(ordered.map((e) => e.id));
      expect(orderKeyPackageCandidates([...rotated].reverse()).map((e) => e.id)).toEqual(ordered.map((e) => e.id));
    }
  });

  it('does not mutate its input', () => {
    const events = [kp(1, 'x'), kp(3, 'y'), kp(2, 'z')];
    const before = events.map((e) => e.id);
    orderKeyPackageCandidates(events);
    expect(events.map((e) => e.id)).toEqual(before);
  });

  it('the lookup returns the tie in id order even when the relay delivers the higher id first', async () => {
    const a = kp(500, 'one');
    const b = kp(500, 'two');
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    const { transport } = recordingTransport([{ event: hi, on: [DEFAULT] }, { event: lo, on: [DEFAULT] }]);
    const res = await lookupOf(transport).lookup(INVITEE);
    expect(res.ok && res.candidates.map((e) => e.id)).toEqual([lo.id, hi.id]);
  });
});

describe('AC-KP-2 lookup relays and filter', () => {
  it('queries exactly {kinds:[30443], authors:[pk], limit} over the de-duplicated union of 10050 relays, 10002 write relays and the defaults', async () => {
    const store = [
      { event: inboxList([RELAY_X, DEFAULT]), on: [DEFAULT] },
      { event: nip65([[RELAY_Y, 'write'], ['wss://read-only.example', 'read']]), on: [DEFAULT] },
      { event: kp(10), on: [RELAY_X] },
    ];
    const { transport, kpCalls } = recordingTransport(store);
    const res = await lookupOf(transport).lookup(INVITEE);
    expect(kpCalls()).toHaveLength(1);
    const call = kpCalls()[0];
    expect(call.filters).toEqual([{ kinds: [30443], authors: [INVITEE], limit: MAX_KEY_PACKAGE_CANDIDATES }]);
    expect([...call.relays].sort()).toEqual([DEFAULT, RELAY_X, RELAY_Y].sort()); // deduplicated, read-only relay excluded
    expect(call.opts.timeoutMs).toBe(1000);
    expect(res.ok && res.candidates).toHaveLength(1);
  });

  it('finds a key package that lives only on a relay the invitee advertises outside the defaults (commit aa39de3)', async () => {
    const onlyOnX = kp(10, 'only-x');
    const store = [{ event: inboxList([RELAY_X]), on: [DEFAULT] }, { event: onlyOnX, on: [RELAY_X] }];
    const { transport } = recordingTransport(store);
    const found = await lookupOf(transport).lookup(INVITEE);
    expect(found.ok && found.candidates.map((e) => e.id)).toEqual([onlyOnX.id]);
    // control: without the advertisement the same fixture is not found (the lookup does not just query everything)
    const { transport: t2 } = recordingTransport([{ event: onlyOnX, on: [RELAY_X] }]);
    expect(await lookupOf(t2).lookup(INVITEE)).toMatchObject({ ok: false, reason: 'none-found' });
  });

  it('uses the NEWEST relay list of each kind', async () => {
    const store = [
      { event: inboxList(['wss://stale.example'], 50), on: [DEFAULT] },
      { event: inboxList([RELAY_X], 200), on: [DEFAULT] },
    ];
    const { transport, kpCalls } = recordingTransport(store);
    await lookupOf(transport).lookup(INVITEE);
    expect(kpCalls()[0].relays).toContain(RELAY_X);
    expect(kpCalls()[0].relays).not.toContain('wss://stale.example');
  });

  it('reports none-found on EOSE with nothing and timed-out on the deadline; never throws for either', async () => {
    const { transport } = recordingTransport([]);
    expect(await lookupOf(transport).lookup(INVITEE)).toMatchObject({ ok: false, reason: 'none-found' });
    const { transport: slow } = recordingTransport([], { timedOut: true });
    expect(await lookupOf(slow).lookup(INVITEE)).toMatchObject({ ok: false, reason: 'timed-out' });
  });

  it('a failing or timed-out relay discovery still looks for the key package on the defaults', async () => {
    const e = kp(10);
    const { transport, kpCalls } = recordingTransport([{ event: e, on: [DEFAULT] }], { fail: (c) => (c.filters.some((f) => f.kinds?.includes(10050)) ? new Error('discovery down') : undefined) });
    const res = await lookupOf(transport).lookup(INVITEE);
    expect(res.ok && res.candidates[0].id).toBe(e.id);
    expect(kpCalls()[0].relays).toEqual([DEFAULT]);
  });

  it('forwards the abort signal to both requests and rethrows an abort', async () => {
    const ac = new AbortController();
    const { transport, calls } = recordingTransport([]);
    await lookupOf(transport).lookup(INVITEE, { signal: ac.signal });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.opts.signal === ac.signal)).toBe(true);
    ac.abort();
    const aborting = recordingTransport([], { fail: () => new Error('aborted') });
    await expect(lookupOf(aborting.transport).lookup(INVITEE, { signal: ac.signal })).rejects.toThrow('aborted');
  });

  it('never publishes and never touches keyPackages.observe: the lookup port has only requestWithDeadline', async () => {
    const { transport } = recordingTransport([{ event: kp(1), on: [DEFAULT] }]);
    // a transport exposing only requestWithDeadline is enough: publish/subscription would be undefined and throw
    expect(Object.keys(transport)).toEqual(['requestWithDeadline']);
    expect((await lookupOf(transport).lookup(INVITEE)).ok).toBe(true);
  });
});

describe('candidate cap and verification cost', () => {
  it('keeps the newest MAX_KEY_PACKAGE_CANDIDATES verified candidates, newest first, and asks the relays for no more', async () => {
    const all = Array.from({ length: 20 }, (_, i) => kp(1000 + i, `many-${i}`));
    const { transport, kpCalls } = recordingTransport(all.map((event) => ({ event, on: [DEFAULT] })));
    const res = await lookupOf(transport).lookup(INVITEE);
    expect(kpCalls()[0].filters[0].limit).toBe(MAX_KEY_PACKAGE_CANDIDATES);
    expect(res.ok && res.candidates.map((e) => e.created_at)).toEqual([1019, 1018, 1017, 1016, 1015, 1014]);
  });

  it('junk is rejected by cheap checks without a signature verification, and verification stops once enough candidates verified', async () => {
    const good = Array.from({ length: 12 }, (_, i) => kp(500 + i, `g-${i}`));
    const junk: NostrEvent[] = [];
    for (let i = 0; i < 100; i++) {
      junk.push(kp(9000 + i, `foreign-${i}`, SK_OTHER)); // another author
      junk.push(sign(SK_INVITEE, 443, 8000 + i, [], `kind-${i}`)); // another kind
      junk.push({ ...JSON.parse(JSON.stringify(kp(7000 + i, `badid-${i}`))), id: 'zz' } as NostrEvent); // malformed id
    }
    junk.push(good[0], good[0], good[0]); // duplicates of one id
    const verify = vi.fn((e: NostrEvent) => verifyEvent(e));
    const { transport } = recordingTransport(good.map((event) => ({ event, on: [DEFAULT] })), { extra: () => junk });
    const res = await lookupOf(transport, [DEFAULT], { verifyEvent: verify }).lookup(INVITEE);
    expect(res.ok && res.candidates).toHaveLength(MAX_KEY_PACKAGE_CANDIDATES);
    expect(verify.mock.calls.length).toBeLessThanOrEqual(MAX_KEY_PACKAGE_CANDIDATES); // none for junk, none past the cap
  });
});

describe('failure pins', () => {
  it('a rejected (non-abort) key-package request is the lookup\'s rejection, unchanged; a discovery that times out still reaches the defaults', async () => {
    const boom = new Error('all relays refused');
    const failing = recordingTransport([], { fail: (c) => (c.filters.some((f) => f.kinds?.includes(KEY_PACKAGE_KIND)) ? boom : undefined) });
    await expect(lookupOf(failing.transport).lookup(INVITEE)).rejects.toBe(boom);
    const e = kp(10);
    const timedOutDiscovery = recordingTransport([{ event: e, on: [DEFAULT] }], { fail: (c) => (c.filters.some((f) => f.kinds?.includes(10002)) ? Object.assign(new Error('deadline'), { name: 'TimeoutError' }) : undefined) });
    const res = await lookupOf(timedOutDiscovery.transport).lookup(INVITEE);
    expect(res.ok && res.candidates[0].id).toBe(e.id);
    expect(timedOutDiscovery.kpCalls()[0].relays).toEqual([DEFAULT]);
  });
});

describe('hostile relay input', () => {
  it('drops events of another author, another kind, with a bad signature or a malformed id; keeps the good one', async () => {
    const good = kp(10, 'good');
    const foreignAuthor = kp(99, 'foreign', SK_OTHER);
    const wrongKind = sign(SK_INVITEE, 443, 98, [], 'legacy');
    // a plain JSON copy: nostr-tools caches the verified mark on the event object (a spread would carry it over)
    const tampered = { ...JSON.parse(JSON.stringify(kp(97, 'tampered'))), content: 'changed-after-signing' } as NostrEvent;
    const badId = { ...JSON.parse(JSON.stringify(kp(96, 'badid'))), id: 'zz' } as NostrEvent;
    const { transport } = recordingTransport([{ event: good, on: [DEFAULT] }], { extra: () => [foreignAuthor, wrongKind, tampered, badId, null as never] });
    const res = await lookupOf(transport).lookup(INVITEE);
    expect(res.ok && res.candidates.map((e) => e.id)).toEqual([good.id]);
  });

  it('a duplicate event id from two relays is one candidate', async () => {
    const e = kp(10);
    const { transport } = recordingTransport([{ event: e, on: [DEFAULT] }], { extra: () => [e] });
    const res = await lookupOf(transport).lookup(INVITEE);
    expect(res.ok && res.candidates).toHaveLength(1);
  });

  it('advertised relay URLs: wss + public DNS host only; credentials, junk, local and private hosts are dropped; at most MAX_ADVERTISED_RELAYS per list', async () => {
    const many = Array.from({ length: 8 }, (_, i) => `wss://adv-${i}.example`);
    const hostile = [
      'ws://remote.example', 'wss://user:pw@creds.example', 'not a url', 'http://web.example', 'ws://localhost:7777',
      'wss://192.168.1.1', 'wss://10.0.0.5:4848', 'wss://127.0.0.1', 'wss://[::1]', 'wss://[fd00::1]', 'wss://169.254.169.254', 'wss://2130706433',
      'ws://localhost:3000', 'wss://printer.local', 'wss://nas.internal', 'wss://intranet', 'wss://localhost',
    ];
    const store = [{ event: inboxList([...hostile, ...many]), on: [DEFAULT] }];
    const { transport, kpCalls } = recordingTransport(store);
    await lookupOf(transport).lookup(INVITEE);
    const relays = kpCalls()[0].relays;
    expect(relays.filter((r) => r !== DEFAULT)).toEqual(many.slice(0, MAX_ADVERTISED_RELAYS));
  });

  it('normaliseAdvertisedRelayUrl rejects wss://192.168.1.1, ws://localhost:3000 and wss://printer.local by default and accepts a public wss host', () => {
    for (const bad of ['wss://192.168.1.1', 'ws://localhost:3000', 'wss://printer.local', 'wss://172.16.0.1', 'wss://100.64.0.1', 'wss://0.0.0.0', 'wss://localhost.', 'wss://x.localhost', 'wss://u@relay.example']) {
      expect(normaliseAdvertisedRelayUrl(bad), bad).toBeNull();
    }
    expect(normaliseAdvertisedRelayUrl('wss://Relay.Example/')).toBe('wss://relay.example');
    expect(normaliseAdvertisedRelayUrl('ws://relay.example')).toBeNull();
  });

  it('allowLocalAdvertised lifts the host rule for advertised relays (and only that): local ws:// is queried, credentials are still refused', async () => {
    const store = [{ event: inboxList(['ws://localhost:7777', 'wss://u:p@relay.example']), on: [DEFAULT] }];
    const { transport, kpCalls } = recordingTransport(store);
    await lookupOf(transport, [DEFAULT], { allowLocalAdvertised: true }).lookup(INVITEE);
    expect(kpCalls()[0].relays).toContain('ws://localhost:7777');
    expect(kpCalls()[0].relays.some((r) => r.includes('relay.example'))).toBe(false);
    const { transport: t2, kpCalls: k2 } = recordingTransport(store);
    await lookupOf(t2).lookup(INVITEE); // default: not queried
    expect(k2()[0].relays).toEqual([DEFAULT]);
  });

  it('app-configured defaults are used as given: a ws:// LAN relay (umbrel.local) stays, de-duplicated and canonicalised', async () => {
    const { transport, calls } = recordingTransport([]);
    await createKeyPackageLookup({ transport, defaultRelays: ['ws://umbrel.local:4848', 'WS://Umbrel.local:4848/', 'ws://192.168.1.20:7777'], timeoutMs: 1000 }).lookup(INVITEE);
    expect(calls[0].relays).toEqual(['ws://umbrel.local:4848', 'ws://192.168.1.20:7777']);
    expect(normaliseRelayUrl('ws://umbrel.local:4848')).toBe('ws://umbrel.local:4848');
  });

  it('a kind-10002 [r, url, read] relay is NOT queried (write set only)', async () => {
    const store = [{ event: nip65([['wss://read-only.example', 'read'], [RELAY_Y, 'write']]), on: [DEFAULT] }];
    const { transport, kpCalls } = recordingTransport(store);
    await lookupOf(transport).lookup(INVITEE);
    expect(kpCalls()[0].relays).toContain(RELAY_Y);
    expect(kpCalls()[0].relays).not.toContain('wss://read-only.example');
  });

  it('a relay list signed by someone else is ignored', async () => {
    const store = [{ event: inboxList([RELAY_X], 100, SK_OTHER), on: [DEFAULT] }];
    const { transport, kpCalls } = recordingTransport(store);
    await lookupOf(transport).lookup(INVITEE);
    expect(kpCalls()[0].relays).toEqual([DEFAULT]);
  });

  it('normaliseRelayUrl: lowercases scheme and host, drops fragment and trailing slash, keeps the query', () => {
    expect(normaliseRelayUrl('WSS://Relay.Example/path/#frag')).toBe('wss://relay.example/path');
    expect(normaliseRelayUrl('wss://r.example/?token=a')).toBe('wss://r.example?token=a');
    expect(normaliseRelayUrl(42)).toBeNull();
    expect(normaliseRelayUrl('')).toBeNull();
  });
});

describe('construction validates its ports', () => {
  it('createKeyPackageLookup rejects a missing transport, a transport without requestWithDeadline, empty or invalid defaults, a bad timeout', () => {
    expect(() => createKeyPackageLookup(undefined as never)).toThrow(TypeError);
    expect(() => createKeyPackageLookup({ transport: undefined as never, defaultRelays: [DEFAULT] })).toThrow(/transport/);
    expect(() => createKeyPackageLookup({ transport: {} as never, defaultRelays: [DEFAULT] })).toThrow(/requestWithDeadline/);
    const { transport } = recordingTransport([]);
    expect(() => createKeyPackageLookup({ transport, defaultRelays: [] })).toThrow(/defaultRelays/);
    expect(() => createKeyPackageLookup({ transport, defaultRelays: ['http://nope'] })).toThrow(/defaultRelays/);
    expect(() => createKeyPackageLookup({ transport, defaultRelays: [DEFAULT], timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => createKeyPackageLookup({ transport, defaultRelays: [DEFAULT], timeoutMs: 2 ** 31 })).toThrow(/timeoutMs/); // setTimeout would fire at once
    expect(() => createKeyPackageLookup({ transport, defaultRelays: [DEFAULT], timeoutMs: 2 ** 31 - 1 })).not.toThrow();
  });

  it('createKeyPackageInviter rejects a missing lookup or queue', () => {
    const queue = createGroupOpQueue();
    const { transport } = recordingTransport([]);
    const lookup = lookupOf(transport);
    expect(() => createKeyPackageInviter(undefined as never)).toThrow(TypeError);
    expect(() => createKeyPackageInviter({ lookup: undefined as never, queue })).toThrow(/lookup/);
    expect(() => createKeyPackageInviter({ lookup, queue: undefined as never })).toThrow(/queue/);
    expect(() => createKeyPackageInviter({ lookup, queue: {} as never })).toThrow(/runCommit/);
  });

  it('lookup rejects a pubkey that is not 64 hex chars', async () => {
    const { transport } = recordingTransport([]);
    await expect(lookupOf(transport).lookup('npub1abc')).rejects.toThrow(TypeError);
  });
});

/** A recording group: `invite` receives the call, answers from `decide`. */
function fakeGroup(decide: (events: NostrEvent[], call: number) => unknown, synced: () => Promise<void> = async () => undefined, leaves: (pubkey: string) => readonly unknown[] = () => []) {
  const calls: NostrEvent[][] = [];
  const group = {
    id: 'g'.repeat(64),
    synced,
    leaves,
    invite: async (events: NostrEvent[]) => {
      calls.push([...events]);
      const r = decide(events, calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as InviteGroup;
  return { group, calls };
}
const delivered = (pubkey = INVITEE) => [{ inviteeRef: 'ref', pubkey, status: 'delivered', relays: [] }];
const invalid = (reason?: string) => new MarmotError('invalid-options', 'invite: rejected', reason ? { details: { reason } } : undefined);

function inviterOver(store: NostrEvent[]) {
  const { transport } = recordingTransport(store.map((event) => ({ event, on: [DEFAULT] })));
  return createKeyPackageInviter({ lookup: lookupOf(transport), queue: createGroupOpQueue() });
}

describe('AC-KP-1 single-candidate invite', () => {
  const c1 = kp(300, 'c1');
  const c2 = kp(200, 'c2');
  const c3 = kp(100, 'c3');

  it('calls group.invite with exactly one event per call, newest first, and stops at the first success', async () => {
    const { group, calls } = fakeGroup(() => delivered());
    const res = await inviterOver([c3, c1, c2]).inviteByPubkey(group, INVITEE);
    expect(calls.map((c) => c.map((e) => e.id))).toEqual([[c1.id]]);
    expect(res).toMatchObject({ keyPackageEventId: c1.id, attempts: 1, outcome: { status: 'delivered' } });
  });

  it('invalid-options on c1 falls through to invite([c2]) and stops on success; c3 is never offered', async () => {
    const { group, calls } = fakeGroup((events) => (events[0].id === c1.id ? invalid('invalid-keypackage') : delivered()));
    const res = await inviterOver([c2, c3, c1]).inviteByPubkey(group, INVITEE);
    expect(calls.map((c) => c.map((e) => e.id))).toEqual([[c1.id], [c2.id]]);
    expect(calls.every((c) => c.length === 1)).toBe(true);
    expect(res).toMatchObject({ keyPackageEventId: c2.id, attempts: 2 });
  });

  it('only per-candidate reasons fall through: verifier, invalid-keypackage, ineligible (with this event\'s id, or none)', async () => {
    for (const reason of ['verifier', 'invalid-keypackage', 'ineligible']) {
      const { group, calls } = fakeGroup((events) => (events[0].id === c1.id ? new MarmotError('invalid-options', 'x', { details: { reason, eventId: c1.id } }) : delivered()));
      const res = await inviterOver([c1, c2]).inviteByPubkey(group, INVITEE);
      expect(calls, reason).toHaveLength(2);
      expect(res).toMatchObject({ keyPackageEventId: c2.id });
    }
  });

  it('a reason-less invalid-options ("group has no relays"), no-invitees, a group-level duplicate and a foreign eventId are thrown unchanged: no further candidate', async () => {
    const cases: Array<[string, unknown]> = [
      ['reason-less', invalid()],
      ['no-invitees', invalid('no-invitees')],
      ['duplicate', invalid('duplicate')],
      ['foreign event id', new MarmotError('invalid-options', 'x', { details: { reason: 'ineligible', eventId: c3.id } })],
    ];
    for (const [name, err] of cases) {
      const { group, calls } = fakeGroup(() => err);
      await expect(inviterOver([c1, c2]).inviteByPubkey(group, INVITEE), name).rejects.toBe(err);
      expect(calls, name).toHaveLength(1);
    }
  });

  it('exhaustion: every candidate rejected yields {error:"no usable key package"}, each offered once', async () => {
    const { group, calls } = fakeGroup(() => invalid('ineligible'));
    const res = await inviterOver([c1, c2, c3]).inviteByPubkey(group, INVITEE);
    expect(res).toEqual({ error: 'no usable key package', reason: 'all-rejected', attempts: 3 });
    expect(calls.map((c) => c[0].id)).toEqual([c1.id, c2.id, c3.id]);
  });

  it('no key package at all (none found / deadline) is the same error value and never calls group.invite', async () => {
    const { group, calls } = fakeGroup(() => delivered());
    expect(await inviterOver([]).inviteByPubkey(group, INVITEE)).toEqual({ error: 'no usable key package', reason: 'none-found', attempts: 0 });
    const { transport } = recordingTransport([], { timedOut: true });
    const slow = createKeyPackageInviter({ lookup: lookupOf(transport), queue: createGroupOpQueue() });
    expect(await slow.inviteByPubkey(group, INVITEE)).toEqual({ error: 'no usable key package', reason: 'timed-out', attempts: 0 });
    expect(calls).toHaveLength(0);
  });

  it('not-admin is the group\'s verdict on the caller: thrown at once, no further candidate is tried', async () => {
    const { group, calls } = fakeGroup(() => invalid('not-admin'));
    await expect(inviterOver([c1, c2]).inviteByPubkey(group, INVITEE)).rejects.toMatchObject({ code: 'invalid-options' });
    expect(calls).toHaveLength(1);
  });

  it('any other error (publish-failed, plain Error) is thrown unchanged and ends the walk', async () => {
    const boom = new MarmotError('publish-failed', 'relay refused');
    const { group, calls } = fakeGroup(() => boom);
    await expect(inviterOver([c1, c2]).inviteByPubkey(group, INVITEE)).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
  });

  it('every attempt runs through the queue: synced() is awaited before each invite, and two concurrent invites of one group never overlap', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inFlight = 0;
    let maxInFlight = 0;
    const group = {
      id: 'q'.repeat(64),
      synced: async () => { order.push('synced'); await gate; },
      leaves: () => [],
      invite: async (events: NostrEvent[]) => {
        order.push(`invite:${events[0].id === c1.id ? 'c1' : 'c2'}`);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return delivered();
      },
    } as unknown as InviteGroup;
    const inviter = inviterOver([c1]);
    const p1 = inviter.inviteByPubkey(group, INVITEE);
    const p2 = inviter.inviteByPubkey(group, INVITEE);
    await new Promise((r) => setTimeout(r, 20));
    expect(order.filter((o) => o.startsWith('invite'))).toEqual([]); // blocked behind synced()
    release();
    await Promise.all([p1, p2]);
    expect(maxInFlight).toBe(1);
    expect(order.indexOf('synced')).toBeLessThan(order.indexOf('invite:c1'));
  });

  it('a group that never syncs rejects GroupOpError not-synced (bounded), without calling invite', async () => {
    const { group, calls } = fakeGroup(() => delivered(), () => new Promise<void>(() => undefined));
    const err = await inviterOver([c1]).inviteByPubkey(group, INVITEE, { syncTimeoutMs: 30 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GroupOpError);
    expect((err as GroupOpError).code).toBe('not-synced');
    expect(calls).toHaveLength(0);
  });

  it('a pre-aborted signal rejects with aborted, without any lookup or invite', async () => {
    const ac = new AbortController();
    const { transport } = recordingTransport([], { fail: () => new Error('aborted') });
    const inviter = createKeyPackageInviter({ lookup: lookupOf(transport), queue: createGroupOpQueue() });
    ac.abort();
    const { group, calls } = fakeGroup(() => delivered());
    await expect(inviter.inviteByPubkey(group, INVITEE, { signal: ac.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(calls).toHaveLength(0);
  });

  it('already-member pre-check: a member with NO discoverable key package gets already-member, and no lookup request is made', async () => {
    const { group, calls } = fakeGroup(() => delivered(), undefined, () => [{ leafIndex: 1 }]);
    const t = recordingTransport([]); // nothing discoverable anywhere
    const inviter = createKeyPackageInviter({ lookup: lookupOf(t.transport), queue: createGroupOpQueue() });
    expect(await inviter.inviteByPubkey(group, INVITEE)).toEqual({ error: 'already-member' });
    expect(t.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('already-member: a pubkey that holds a leaf yields {error:"already-member"}, group.invite is never called', async () => {
    const { group, calls } = fakeGroup(() => delivered(), undefined, () => [{ leafIndex: 1 }]);
    expect(await inviterOver([c1, c2]).inviteByPubkey(group, INVITEE)).toEqual({ error: 'already-member' });
    expect(calls).toHaveLength(0);
  });

  it('authoritative in-queue member check sees the group AFTER synced(): a leaf that appears while syncing blocks the invite', async () => {
    let synced = false;
    const { group, calls } = fakeGroup(() => delivered(), async () => { await new Promise((r) => setTimeout(r, 5)); synced = true; }, () => (synced ? [{ leafIndex: 1 }] : []));
    expect(await inviterOver([c1]).inviteByPubkey(group, INVITEE)).toEqual({ error: 'already-member' });
    expect(calls).toHaveLength(0);
  });

  it('abort is one shape: GroupOpError "aborted" from a pre-aborted signal and from an abort during the lookup', async () => {
    const { group, calls } = fakeGroup(() => delivered());
    const pre = new AbortController();
    pre.abort();
    const e1 = await inviterOver([c1]).inviteByPubkey(group, INVITEE, { signal: pre.signal }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(GroupOpError);
    expect((e1 as GroupOpError).code).toBe('aborted');

    const ac = new AbortController();
    const { transport } = recordingTransport([], { fail: () => { ac.abort(); return new Error('socket closed by transport'); } });
    const inviter = createKeyPackageInviter({ lookup: lookupOf(transport), queue: createGroupOpQueue() });
    const e2 = await inviter.inviteByPubkey(group, INVITEE, { signal: ac.signal }).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(GroupOpError);
    expect((e2 as GroupOpError).code).toBe('aborted');
    expect(calls).toHaveLength(0);
  });

  it('a non-abort rejection of the lookup (relays down) is thrown unchanged, not folded into the error value', async () => {
    const boom = new Error('all relays refused');
    const { transport } = recordingTransport([], { fail: (c) => (c.filters.some((f) => f.kinds?.includes(KEY_PACKAGE_KIND)) ? boom : undefined) });
    const inviter = createKeyPackageInviter({ lookup: lookupOf(transport), queue: createGroupOpQueue() });
    const { group } = fakeGroup(() => delivered());
    await expect(inviter.inviteByPubkey(group, INVITEE)).rejects.toBe(boom);
  });

  it('rejects a non-group argument', async () => {
    await expect(inviterOver([]).inviteByPubkey({} as never, INVITEE)).rejects.toThrow(TypeError);
  });

  it('the seam types: success carries outcome + keyPackageEventId, failure carries error (discriminated by "error" in r)', async () => {
    const { group } = fakeGroup(() => delivered());
    const res = await inviterOver([c1]).inviteByPubkey(group, INVITEE);
    expect('error' in res).toBe(false);
    if (!('error' in res)) expect(res.outcome.pubkey).toBe(INVITEE);
  });
});
