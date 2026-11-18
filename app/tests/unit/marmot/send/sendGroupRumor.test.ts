// @vitest-environment node
/**
 * AC-SEND-1: `sendGroupRumor` builds the canonical rumor (id = getEventHash, pubkey = own account), calls
 * `group.send({type:'application', rumor})` exactly once with it and never retries; the id it returns is the id
 * the optimistic row carries. Over the REAL ownRowTracker (no mocked collaborator at the SUT call site).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventHash, getPublicKey } from 'nostr-tools/pure';
import { buildGroupRumor, createGroupRumorSender, createOwnRowTracker, type OwnRowTracker, type SendableGroup } from '@/src/lib/marmot/send';

const OWN = getPublicKey(Uint8Array.from(Buffer.from('a1'.repeat(32), 'hex')));
const GROUP = 'ab'.repeat(32);

const trackers: OwnRowTracker[] = [];
function setup(sendImpl: (intent: unknown) => Promise<unknown> = async () => undefined) {
  const statuses: Array<[string, string, string]> = [];
  const tracker = createOwnRowTracker({ ports: { setStatus: (g, id, s) => void statuses.push([g, id, s]) } });
  trackers.push(tracker);
  const send = vi.fn(sendImpl);
  const group: SendableGroup = { id: GROUP, send: send as unknown as SendableGroup['send'], pendingIntents: async () => [] };
  const sender = createGroupRumorSender({ ownPubkey: OWN, tracker, nowSeconds: () => 1_700_000_000 });
  return { tracker, statuses, send, group, sender };
}
afterEach(() => {
  for (const t of trackers.splice(0)) t.dispose();
});

describe('buildGroupRumor', () => {
  it('id is the nostr-tools event hash of exactly the other five fields', () => {
    const rumor = buildGroupRumor(OWN, 9, 'hello', [['e', 'x']], 1_700_000_000);
    expect(rumor).toEqual({ id: getEventHash({ pubkey: OWN, created_at: 1_700_000_000, kind: 9, tags: [['e', 'x']], content: 'hello' }), pubkey: OWN, created_at: 1_700_000_000, kind: 9, tags: [['e', 'x']], content: 'hello' });
    expect(rumor.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('copies the tags (a later caller mutation cannot change the id basis)', () => {
    const tags = [['t', '1']];
    const rumor = buildGroupRumor(OWN, 9, 'c', tags, 5);
    tags[0][1] = 'changed';
    expect(rumor.tags).toEqual([['t', '1']]);
    expect(rumor.id).toBe(getEventHash(rumor));
  });

  it.each([
    ['a non-hex pubkey', () => buildGroupRumor('nothex', 9, 'c', [], 1)],
    ['an upper-case pubkey', () => buildGroupRumor(OWN.toUpperCase(), 9, 'c', [], 1)],
    ['a negative kind', () => buildGroupRumor(OWN, -1, 'c', [], 1)],
    ['a fractional kind', () => buildGroupRumor(OWN, 9.5, 'c', [], 1)],
    ['a kind above 65535', () => buildGroupRumor(OWN, 65536, 'c', [], 1)],
    ['non-string content', () => buildGroupRumor(OWN, 9, 5 as unknown as string, [], 1)],
    ['non-array tags', () => buildGroupRumor(OWN, 9, 'c', 'x' as unknown as string[][], 1)],
    ['a tag with a non-string value', () => buildGroupRumor(OWN, 9, 'c', [['e', 1 as unknown as string]], 1)],
    ['a fractional created_at', () => buildGroupRumor(OWN, 9, 'c', [], 1.5)],
  ])('rejects %s', (_label, build) => {
    expect(build).toThrow(TypeError);
  });
});

describe('sendGroupRumor', () => {
  it('preserves an explicit timestamp and refuses to silently change it on a collision', async () => {
    const { sender, group, send } = setup();
    const prepared = sender.prepare(group, 9, 'edit', [['e', 'original', '', 'edit']], { createdAt: 123 });
    await prepared.send();
    expect(prepared.rumor.created_at).toBe(123);
    expect((send.mock.calls[0][0] as { rumor: { id: string; created_at: number } }).rumor).toMatchObject({ id: prepared.id, created_at: 123 });
    expect(() => sender.prepare(group, 9, 'edit', [['e', 'original', '', 'edit']], { createdAt: 123 })).toThrow(/already tracked/);
  });

  it('calls group.send exactly once with {type:application, rumor}; the rumor is authored by the own account', async () => {
    const { sender, send, group } = setup();
    const out = await sender.sendGroupRumor(group, 9, 'hi there', [['x', 'y']]);
    expect(send).toHaveBeenCalledTimes(1);
    const intent = send.mock.calls[0][0] as { type: string; rumor: ReturnType<typeof buildGroupRumor> };
    expect(intent.type).toBe('application');
    expect(intent.rumor.pubkey).toBe(OWN);
    expect(intent.rumor.kind).toBe(9);
    expect(intent.rumor.content).toBe('hi there');
    expect(intent.rumor.tags).toEqual([['x', 'y']]);
    expect(intent.rumor.created_at).toBe(1_700_000_000);
    expect(intent.rumor.id).toBe(getEventHash(intent.rumor));
    expect(out.id).toBe(intent.rumor.id);
  });

  it('resolves with what group.send resolved with', async () => {
    const { sender, group } = setup(async () => ({ queued: true }));
    expect((await sender.sendGroupRumor(group, 9, 'c', [])).result).toEqual({ queued: true });
  });

  it('prepare gives the final id BEFORE anything is sent; send() is then the single group.send, however often called', async () => {
    const { sender, send, group, tracker } = setup();
    const prepared = sender.prepare(group, 9, 'optimistic', []);
    expect(send).not.toHaveBeenCalled();
    expect(prepared.id).toBe(getEventHash(prepared.rumor));
    expect(tracker.statusOf(GROUP, prepared.id)).toBe('sending'); // the optimistic row is tracked from prepare on
    const [a, b] = await Promise.all([prepared.send(), prepared.send()]);
    expect(a).toBe(b);
    expect(a.id).toBe(prepared.id);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('the id is a pure function of (pubkey, created_at, kind, tags, content)', () => {
    const build = (content: string, at = 1) => buildGroupRumor(OWN, 9, content, [], at).id;
    expect(build('same')).toBe(build('same'));
    expect(build('same')).not.toBe(build('other'));
    expect(build('same', 1)).not.toBe(build('same', 2));
  });

  it('a rejecting group.send is NOT retried and its error reaches the caller unchanged; the row fails', async () => {
    const failure = Object.assign(new Error('terminal'), { code: 'send-rejected' });
    const { sender, send, group, tracker, statuses } = setup(async () => {
      throw failure;
    });
    const prepared = sender.prepare(group, 9, 'x', []);
    await expect(prepared.send()).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
    expect(tracker.statusOf(GROUP, prepared.id)).toBe('failed');
    expect(statuses).toEqual([[GROUP, prepared.id, 'failed']]);
  });

  it('a commit-pending style rejection is also not retried by the helper (the library queues; the app has no retry code)', async () => {
    const { sender, send, group } = setup(async () => {
      throw Object.assign(new Error('pending'), { code: 'commit-pending' });
    });
    await expect(sender.sendGroupRumor(group, 9, 'x', [])).rejects.toThrow('pending');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a resolved send starts the confirmation clock: still sending until the echo', async () => {
    const { sender, group, tracker } = setup();
    const out = await sender.sendGroupRumor(group, 9, 'x', []);
    expect(tracker.statusOf(GROUP, out.id)).toBe('sending');
    tracker.onOwnEcho(GROUP, out.id);
    expect(tracker.statusOf(GROUP, out.id)).toBe('confirmed');
  });

  it('carries the signal rumor for a later recompute only while the send is unconfirmed', async () => {
    const { sender, group, tracker } = setup();
    const prepared = sender.prepare(group, 11, '{"pollId":"p"}', []);
    expect(tracker.pendingSignals(GROUP)).toEqual([prepared.rumor]);
    await prepared.send();
    tracker.onOwnEcho(GROUP, prepared.id);
    expect(tracker.pendingSignals(GROUP)).toEqual([]); // echoed: the sink row now carries it
  });
});

describe('construction and call-site validation (loud, never a silent no-op)', () => {
  const tracker = () => {
    const t = createOwnRowTracker({ ports: { setStatus: () => undefined } });
    trackers.push(t);
    return t;
  };
  it('requires an own pubkey in hex', () => {
    expect(() => createGroupRumorSender({ ownPubkey: '', tracker: tracker() })).toThrow(TypeError);
    expect(() => createGroupRumorSender({ ownPubkey: 'zz'.repeat(32), tracker: tracker() })).toThrow(TypeError);
    expect(() => createGroupRumorSender(undefined as never)).toThrow(TypeError);
  });
  it('requires the tracker (an untracked send would escape failure detection)', () => {
    expect(() => createGroupRumorSender({ ownPubkey: OWN } as never)).toThrow(/tracker/);
    expect(() => createGroupRumorSender({ ownPubkey: OWN, tracker: { register: () => undefined } as never })).toThrow(/tracker/);
  });
  it('requires a group with id and send', () => {
    const sender = createGroupRumorSender({ ownPubkey: OWN, tracker: tracker() });
    expect(() => sender.prepare({ id: GROUP } as never, 9, 'c', [])).toThrow(TypeError);
    expect(() => sender.prepare(undefined as never, 9, 'c', [])).toThrow(TypeError);
  });
  it('an invalid rumor registers nothing and sends nothing', () => {
    const { sender, send, group, tracker: t } = setup();
    expect(() => sender.sendGroupRumor(group, -5, 'c', [])).toThrow(TypeError);
    expect(send).not.toHaveBeenCalled();
    expect(t.pendingSignals(GROUP)).toEqual([]);
  });
});
