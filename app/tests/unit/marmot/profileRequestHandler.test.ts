/** Behavioral coverage for requests handled after authenticated group dispatch. */
import { describe, it, expect, vi } from 'vitest';

const { createProfileRequestGroupHandler } = await import('@/src/lib/marmot/handlers/profileRequestHandler');
const { PROFILE_REQUEST_KIND } = await import('@/src/lib/marmot/profileRequestSync');

// Compatibility call shape is confined to the fixture; the real sink handler owns all effects.
function createProfileRequestHandler(deps: any) {
  const jobs: Array<() => Promise<void>> = [];
  const handler = createProfileRequestGroupHandler({ ...deps, groupOf: async () => ({ members: () => [PEER_PUBKEY], admins: [] }), enqueue: (job: () => Promise<void>) => jobs.push(job) });
  expect(handler).not.toHaveProperty('handle');
  return {
    async handle(rumor: any, ctx: any, sender?: { pubkey: string }) {
      await handler.dispatch({ groupId: ctx.groupId, eventId: rumor.id, rumor, sender: sender?.pubkey ?? rumor.pubkey }, ctx);
      while (jobs.length) await jobs.shift()!();
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PEER_PUBKEY = 'bb'.repeat(32);
const SELF_PUBKEY = 'aa'.repeat(32);
const THIRD_PUBKEY = 'cc'.repeat(32);
const GROUP_ID = 'group-request-test';

function makeProfileRequestRumor(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}> = {}) {
  const validContent = JSON.stringify({
    type: 'profile_request',
    targetPubkey: THIRD_PUBKEY,
    nonce: 'abc123',
  });
  return {
    id: 'req-rumor-' + 'ee'.repeat(28),
    pubkey: PEER_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: PROFILE_REQUEST_KIND,
    content: validContent,
    tags: [] as string[][],
    ...overrides,
  };
}

function makeCtx(selfPubkeyHex = SELF_PUBKEY) {
  return {
    groupId: GROUP_ID,
    selfPubkeyHex,
    getActiveGroupId: () => GROUP_ID,
  };
}

// AuthenticatedSender fixture (epic: group-message-author-auth-app-layer S2).
// Unused in profileRequestHandler's body this story — only needed to satisfy
// the widened 3-arg handle() signature.
function makeSender(pubkey: string = PEER_PUBKEY): { pubkey: string; authenticity: 'claimed' | 'mls' } {
  return { pubkey, authenticity: 'mls' };
}

const OTHER_FOR_RELAY = '9f'.repeat(32);

function makeDeps() {
  return {
    recordRequestEmitted: vi.fn(async () => {}),
    sendSelfProfile: vi.fn(async () => {}),
    handleIncomingProfileRequest: vi.fn(async () => {}),
  };
}

describe('profileRequestHandler', () => {
  it('peer-request path: handleIncomingProfileRequest called, sendSelfProfile NOT called', async () => {
    const deps = makeDeps();
    const handler = createProfileRequestHandler(deps);
    // targetPubkey is THIRD_PUBKEY (not self)
    const rumor = makeProfileRequestRumor();
    const ctx = makeCtx(SELF_PUBKEY); // self is SELF_PUBKEY, target is THIRD_PUBKEY

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.recordRequestEmitted).toHaveBeenCalledOnce();
    expect(deps.recordRequestEmitted.mock.calls[0][0]).toBe(GROUP_ID);
    expect(deps.recordRequestEmitted.mock.calls[0][1]).toBe(THIRD_PUBKEY);

    expect(deps.handleIncomingProfileRequest).toHaveBeenCalledOnce();
    const { groupId, payload } = deps.handleIncomingProfileRequest.mock.calls[0][0];
    expect(groupId).toBe(GROUP_ID);
    expect(payload.targetPubkey).toBe(THIRD_PUBKEY);
    expect(payload.type).toBe('profile_request');

    expect(deps.sendSelfProfile).not.toHaveBeenCalled();
  });

  it('self-target reply path: sendSelfProfile called, handleIncomingProfileRequest NOT called', async () => {
    const deps = makeDeps();
    const handler = createProfileRequestHandler(deps);
    // Request targets SELF_PUBKEY
    const content = JSON.stringify({
      type: 'profile_request',
      targetPubkey: SELF_PUBKEY,
      nonce: 'xyz789',
    });
    const rumor = makeProfileRequestRumor({ content });
    const ctx = makeCtx(SELF_PUBKEY);

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.recordRequestEmitted).toHaveBeenCalledOnce();
    expect(deps.sendSelfProfile).toHaveBeenCalledOnce();
    expect(deps.sendSelfProfile.mock.calls[0][0]).toBe(GROUP_ID);
    expect(deps.handleIncomingProfileRequest).not.toHaveBeenCalled();
  });

  it('a failed self-profile reply is warned and swallowed (not a durable failure: the requester re-asks), so the rumor is acked rather than replayed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps();
    deps.sendSelfProfile.mockRejectedValueOnce(new Error('no relay acked'));
    const handler = createProfileRequestHandler(deps);
    const content = JSON.stringify({ type: 'profile_request', targetPubkey: SELF_PUBKEY, nonce: 'n1' });
    const rumor = makeProfileRequestRumor({ content });
    await expect(handler.handle(rumor, makeCtx(SELF_PUBKEY), makeSender(rumor.pubkey))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('answering the request failed'), expect.any(Error));
    warn.mockRestore();
  });

  it.each([
    ['recordRequestEmitted', SELF_PUBKEY],
    ['recordRequestEmitted', OTHER_FOR_RELAY],
    ['handleIncomingProfileRequest', OTHER_FOR_RELAY],
  ] as const)('a failing %s is warned and swallowed (target %s): the requester retries, so the rumor is never kept for replay', async (step, target) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps();
    deps[step].mockRejectedValueOnce(new Error('idb'));
    const handler = createProfileRequestHandler(deps);
    const rumor = makeProfileRequestRumor({ content: JSON.stringify({ type: 'profile_request', targetPubkey: target, nonce: 'n2' }) });
    await expect(handler.handle(rumor, makeCtx(SELF_PUBKEY), makeSender(rumor.pubkey))).resolves.toBeUndefined();
    // A failed record never skips the answer.
    if (step === 'recordRequestEmitted') {
      expect(target === SELF_PUBKEY ? deps.sendSelfProfile : deps.handleIncomingProfileRequest).toHaveBeenCalledOnce();
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[dispatcher.profileRequest]'), expect.any(Error));
    warn.mockRestore();
  });

  it('malformed payload: returns before any step (nothing recorded, nothing warned)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps();
    const rumor = makeProfileRequestRumor({ content: '{ not valid request }' });
    await createProfileRequestHandler(deps).handle(rumor, makeCtx(), makeSender(rumor.pubkey));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('malformed payload: does not throw, no side effects fired', async () => {
    const deps = makeDeps();
    const handler = createProfileRequestHandler(deps);
    const rumor = makeProfileRequestRumor({ content: '{ not valid request }' });
    const ctx = makeCtx();

    await expect(handler.handle(rumor, ctx, makeSender(rumor.pubkey))).resolves.not.toThrow();
    expect(deps.recordRequestEmitted).not.toHaveBeenCalled();
    expect(deps.sendSelfProfile).not.toHaveBeenCalled();
    expect(deps.handleIncomingProfileRequest).not.toHaveBeenCalled();
  });

});
