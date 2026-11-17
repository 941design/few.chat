/** Shared fixtures of the invite-context tests (not a test file). */
import type { Rumor } from '@941design/nostr-events/event';
import type { PendingInvitation } from '@941design/marmot';
import { APP_INBOX_KINDS } from '@/src/lib/marmot/kinds';
import { createInviteContextSender, type InviteContextStorePort, type InviteContextRecord } from '@/src/lib/marmot/invitations';

export const APP_INBOX_KINDS_FOR_TEST = APP_INBOX_KINDS;

export const hex = (n: number) => n.toString(16).padStart(64, '0');
export const SELF = 'aa'.repeat(32);

/** A recording `sendInboxRumor` (the real `sendInboxRumor` is exercised by the harness). */
export function makeSender(status: 'delivered' | 'retryable' | 'failed' = 'delivered') {
  const sent: Array<{ to: string; rumor: Rumor }> = [];
  const sender = createInviteContextSender({
    inbox: { sendInboxRumor: async (input) => { sent.push({ to: input.to, rumor: input.rumor }); return { status }; } },
    ownPubkey: SELF,
    now: () => 1_700_000_000_000,
  });
  return { sender, sent };
}

export const delivered = (status: 'delivered' | 'retryable' | 'failed' | 'declined') =>
  ({ outcome: { inviteeRef: 'r', pubkey: 'p', status, relays: [] }, keyPackageEventId: 'k', attempts: 1 }) as never;

export const inv = (id: string, sponsor: number, groupId = `g${id}`): PendingInvitation => ({
  id, groupId, sponsorAccount: hex(sponsor), sponsors: [hex(sponsor)], keyPackageRef: `kp-${id}`, receivedAt: 1,
});

/**
 * In-memory snapshot port. Like an idb Map mock it hands records back in the order they were SAVED/seeded,
 * which tests deliberately choose out of `seq` order.
 */
export function memoryPort(initial?: InviteContextRecord[]) {
  let stored: InviteContextRecord[] | undefined = initial;
  const saves: InviteContextRecord[][] = [];
  const port: InviteContextStorePort = {
    load: async () => stored?.map((r) => ({ ...r })),
    save: async (records) => { stored = records.map((r) => ({ ...r })); saves.push(stored); },
  };
  return { port, saves, get stored() { return stored; } };
}

export const rumor = (over: Partial<Rumor> & { groupId?: string; name?: string }): Rumor => ({
  id: over.id ?? 'r1',
  pubkey: over.pubkey ?? hex(1),
  kind: over.kind ?? 21064,
  created_at: over.created_at ?? 1,
  tags: [],
  content: over.content ?? JSON.stringify({ groupId: over.groupId ?? 'ab', name: over.name ?? 'Club' }),
});
