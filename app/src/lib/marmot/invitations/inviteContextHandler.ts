/**
 * Invite-context inbox handler (D3, AC-CTX-2 / AC-CTX-4, AC-BLK-1 invite-context leg).
 *
 * Registered by the client bootstrap with `extensions.registerInboxHandler(APP_INBOX_KINDS.inviteContext, ...)`.
 * It runs INSIDE a library frame, so it follows the inbox-handler rules (architecture.md, re-entrancy): it only
 * validates and persists through the context store and returns. It never calls an account-scope client method
 * (the store port is app storage, not the client), and it enqueues nothing: the live update of the card is the
 * store's own synchronous change notification, which touches no client state.
 *
 * Order of checks, each dropping silently (no store write, no bell, no log of content):
 *   1. wrong kind (defence in depth: the registry already routes by kind);
 *   2. the sender is blocked (`DenyLayer.isBlocked`, called BEFORE anything is stored);
 *   3. malformed payload (`parseInviteContextContent`);
 *   4. the sender is not a sponsor of a pending invitation of that group (the store drops it when an invitation
 *      for the group is already pending; otherwise it is held until one arrives, then validated).
 * The sender identity is the seal-bound `rumor.pubkey` (lowercased), never a field of the content. Redelivery of
 * the same rumor id stores one entry. A persistence failure rejects delivery so the library can defer and retry it.
 */
import type { InboxRumorHandler } from '@941design/marmot';
import { APP_INBOX_KINDS } from '../kinds';
import type { DenyLayer } from './denyLayer';
import { parseInviteContextContent } from './inviteContext';
import type { InviteContextStore } from './inviteContextStore';

interface InviteContextHandlerDeps {
  store: Pick<InviteContextStore, 'add'>;
  denyLayer: DenyLayer;
  onError?: (error: unknown) => void;
}

const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

export function createInviteContextHandler(deps: InviteContextHandlerDeps): InboxRumorHandler {
  if (!deps) throw new TypeError('createInviteContextHandler: dependencies are required');
  if (typeof deps.store?.add !== 'function') throw new TypeError('createInviteContextHandler: required dependency "store.add" is missing');
  if (typeof deps.denyLayer?.isBlocked !== 'function') throw new TypeError('createInviteContextHandler: required dependency "denyLayer.isBlocked" is missing');
  const { store, denyLayer } = deps;
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/invitations] invite context handler', e));

  return async (rumor) => {
    if (rumor.kind !== APP_INBOX_KINDS.inviteContext) return;
    const sender = typeof rumor.pubkey === 'string' ? rumor.pubkey.toLowerCase() : '';
    if (!PUBKEY_PATTERN.test(sender)) return;
    if (denyLayer.isBlocked(sender)) return;
    const payload = parseInviteContextContent(rumor.content);
    if (!payload || typeof rumor.id !== 'string' || rumor.id.length === 0) return;
    try {
      await store.add({ rumorId: rumor.id, sender, groupId: payload.groupId, name: payload.name }, { requirePersistence: true });
    } catch (e) {
      onError(e);
      throw e;
    }
  };
}
