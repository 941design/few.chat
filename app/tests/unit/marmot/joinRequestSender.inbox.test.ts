// @vitest-environment node
/**
 * Unit tests for the join-request INBOX sender (S12): AC-JOIN-1 (sent with `sendInboxRumor` of kind 21059; requester name
 * inside the rumor only), AC-JOIN-4 (a `retryable` or `failed` outcome is the existing send-failure state, no retry timer),
 * AC-AUTO-1 write side (the outbound record is written ONLY for a delivered request) and the privacy invariant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventHash } from 'nostr-tools/pure';
import type { Rumor } from '@941design/nostr-events/event';
import { createJoinRequestSender, JoinRequestSendError, JOIN_REQUEST_RUMOR_KIND } from '@/src/lib/marmot/joinRequestSender';
import { APP_INBOX_KINDS } from '@/src/lib/marmot/kinds';
import type { OutboundJoinRequestRecord } from '@/src/lib/marmot/outboundJoinRequests';

const OWN = 'ab'.repeat(32);
const ADMIN = 'cd'.repeat(32);
const NOW = 1_700_000_000_000;

type Status = 'delivered' | 'retryable' | 'failed';

function setup(status: Status | 'throws' = 'delivered', opts: { saveFails?: boolean } = {}) {
  const sent: Array<{ to: string; rumor: Rumor }> = [];
  const saved: OutboundJoinRequestRecord[] = [];
  const errors: unknown[] = [];
  const sender = createJoinRequestSender({
    inbox: {
      sendInboxRumor: async (input) => {
        sent.push({ to: input.to, rumor: input.rumor });
        if (status === 'throws') throw new Error('reentrant');
        return { status, reason: status === 'delivered' ? undefined : 'no-inbox-relays' };
      },
    },
    ownPubkey: OWN.toUpperCase(),
    now: () => NOW,
    saveOutbound: async (record) => {
      if (opts.saveFails) throw new Error('idb down');
      saved.push(record);
    },
    onError: (e) => void errors.push(e),
  });
  return { sender, sent, saved, errors };
}

const params = { adminPubkeyHex: ADMIN, nonce: 'nonce-1', groupName: 'Club', requesterName: 'Alice' };

afterEach(() => {
  vi.useRealTimers();
});

describe('AC-JOIN-1: sent through sendInboxRumor, kind 21059', () => {
  it('sends exactly one inbox rumor to the admin with the canonical id, the own pubkey as author and the app payload', async () => {
    const t = setup();
    await t.sender.send(params);
    expect(t.sent).toHaveLength(1);
    const { to, rumor } = t.sent[0];
    expect(to).toBe(ADMIN);
    expect(rumor.kind).toBe(APP_INBOX_KINDS.joinRequest);
    expect(JOIN_REQUEST_RUMOR_KIND).toBe(APP_INBOX_KINDS.joinRequest);
    expect(rumor.pubkey).toBe(OWN); // lowercase own pubkey
    expect(rumor.id).toBe(getEventHash(rumor));
    expect(rumor.created_at).toBe(Math.floor(NOW / 1000));
    expect(rumor.tags).toEqual([['p', ADMIN]]);
    expect(JSON.parse(rumor.content)).toEqual({ type: 'join_request', nonce: 'nonce-1', name: 'Club', requesterName: 'Alice' });
  });

  it('addresses the admin in lowercase hex', async () => {
    const t = setup();
    await t.sender.send({ ...params, adminPubkeyHex: ADMIN.toUpperCase() });
    expect(t.sent[0].to).toBe(ADMIN);
  });

  it('omits requesterName from the payload when none is given (nothing else about the requester travels)', async () => {
    const t = setup();
    await t.sender.send({ adminPubkeyHex: ADMIN, nonce: 'n', groupName: 'G' });
    expect(Object.keys(JSON.parse(t.sent[0].rumor.content)).sort()).toEqual(['name', 'nonce', 'type']);
  });

  it('privacy: the requester name appears only inside the rumor content, in no tag; the kind is never 0', async () => {
    const t = setup();
    await t.sender.send({ ...params, requesterName: 'Zoe-Unique' });
    const { rumor } = t.sent[0];
    expect(rumor.kind).not.toBe(0);
    expect(JSON.stringify(rumor.tags)).not.toContain('Zoe-Unique');
    expect(rumor.content).toContain('Zoe-Unique');
  });

  it('rejects a malformed admin pubkey before sending anything', async () => {
    const t = setup();
    await expect(t.sender.send({ ...params, adminPubkeyHex: 'npub1xyz' })).rejects.toThrow(TypeError);
    await expect(t.sender.send({ ...params, nonce: '' })).rejects.toThrow(TypeError);
    expect(t.sent).toEqual([]);
  });
});

describe('AC-AUTO-1 (write side): the outbound record exists only for a delivered request', () => {
  it('delivered: one record keyed by the nonce for the admin, with the link\'s group name and the send time', async () => {
    const t = setup('delivered');
    await t.sender.send(params);
    expect(t.saved).toEqual([{ nonce: 'nonce-1', adminPubkeyHex: ADMIN, groupName: 'Club', sentAt: NOW }]);
  });

  it.each(['retryable', 'failed', 'throws'] as const)('%s: no record is written', async (status) => {
    const t = setup(status);
    await expect(t.sender.send(params)).rejects.toBeInstanceOf(JoinRequestSendError);
    expect(t.saved).toEqual([]);
  });

  it('a record write failure after a delivered request is reported and does not fail the send', async () => {
    const t = setup('delivered', { saveFails: true });
    await expect(t.sender.send(params)).resolves.toBeUndefined();
    expect(t.errors.map((e) => (e as Error).message)).toEqual(['idb down']);
  });
});

describe('AC-JOIN-4: retryable / failed is the send-failure state, with no retry timer', () => {
  it.each(['retryable', 'failed'] as const)('%s: rejects with JoinRequestSendError carrying the outcome; exactly one send; no timer is created', async (status) => {
    vi.useFakeTimers();
    const t = setup(status);
    const error = await t.sender.send(params).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(JoinRequestSendError);
    expect((error as JoinRequestSendError).outcome).toBe(status);
    expect((error as JoinRequestSendError).reason).toBe('no-inbox-relays');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.sent).toHaveLength(1); // nothing retried it
  });

  it('a rejecting sendInboxRumor (e.g. reentrant, aborted) is the same failure state, cause kept', async () => {
    const t = setup('throws');
    const error = (await t.sender.send(params).then(
      () => undefined,
      (e: unknown) => e,
    )) as JoinRequestSendError;
    expect(error).toBeInstanceOf(JoinRequestSendError);
    expect(error.outcome).toBe('failed');
    expect((error.cause as Error).message).toBe('reentrant');
  });

  it('the error message carries only the machine reason, never the rumor, the name or the nonce', async () => {
    const t = setup('failed');
    const error = (await t.sender.send({ ...params, requesterName: 'Secret-Name' }).then(
      () => undefined,
      (e: unknown) => e,
    )) as Error;
    expect(error.message).not.toContain('Secret-Name');
    expect(error.message).not.toContain('nonce-1');
  });
});

describe('construction validates every required port (no silent degradation)', () => {
  const full = () => ({
    inbox: { sendInboxRumor: async () => ({ status: 'delivered' as const }) },
    ownPubkey: OWN,
    now: () => 0,
    saveOutbound: async () => undefined,
  });
  it.each(['inbox', 'ownPubkey', 'now', 'saveOutbound'] as const)('throws when %s is missing', (key) => {
    const deps = full() as Record<string, unknown>;
    delete deps[key];
    expect(() => createJoinRequestSender(deps as never)).toThrow(TypeError);
  });
  it('throws without dependencies and for a non-hex own pubkey', () => {
    expect(() => createJoinRequestSender(undefined as never)).toThrow(TypeError);
    expect(() => createJoinRequestSender({ ...full(), ownPubkey: 'nope' })).toThrow(TypeError);
  });
});
