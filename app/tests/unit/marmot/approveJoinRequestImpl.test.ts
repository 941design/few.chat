// D8 replaces the context helper with the queued approval seam. The full
// key-package and error-path contract is covered by joinRequestApproval.test.ts.
import { describe, it, expect, vi } from 'vitest';
import { createJoinRequestApproval } from '@/src/lib/marmot/joinRequestApproval';

const request = { groupId: 'group', pubkeyHex: 'AB', nonce: 'link', eventId: 'event', receivedAt: Date.now(), nickname: 'Alice' };

describe('approval follow-ups', () => {
  it('consumes the request before running the successful invite follow-up', async () => {
    const order: string[] = [];
    const inviteByPubkey = vi.fn(async () => ({ outcome: { status: 'delivered' } }));
    const approval = createJoinRequestApproval({
      inviter: { inviteByPubkey } as never,
      getGroup: async () => ({ id: 'group' }) as never,
      enqueue: (job) => { void job(); },
      consumeRequest: async () => { order.push('consume'); },
      onApproved: async (r, kind) => { expect(r).toEqual(request); expect(kind).toBe('invited'); order.push('follow-up'); },
    });
    await expect(approval.approve(request)).resolves.toEqual({ ok: true, kind: 'invited', welcomeStatus: 'delivered' });
    expect(inviteByPubkey).toHaveBeenCalledWith({ id: 'group' }, 'ab');
    expect(order).toEqual(['consume', 'follow-up']);
  });
  it('keeps the request pending when the invite fails', async () => {
    const consumeRequest = vi.fn();
    const onApproved = vi.fn();
    const approval = createJoinRequestApproval({
      inviter: { inviteByPubkey: async () => ({ error: 'no-usable-key-package', reason: 'none-found' }) } as never,
      getGroup: async () => ({ id: 'group' }) as never,
      enqueue: (job) => { void job(); }, consumeRequest, onApproved,
    });
    expect((await approval.approve(request)).ok).toBe(false);
    expect(consumeRequest).not.toHaveBeenCalled();
    expect(onApproved).not.toHaveBeenCalled();
  });
});
