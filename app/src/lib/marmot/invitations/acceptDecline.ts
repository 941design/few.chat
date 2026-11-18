/**
 * Accept / decline of a pending invitation (D7, AC-INV-2 / AC-INV-3), native to the library.
 *
 *  - `accept(id)` calls `invitations.accept(id)`: the library joins, verifies and starts the group sync. Only an
 *    invitation the view SHOWS (not blocked, within the caps) can be accepted: the pending list is re-read
 *    first, so a hidden or vanished id fails with `InvitationActionError` instead of reaching the library.
 *    The joined group is handed to `attachGroup` (the notification listener of `AccountClient`).
 *  - `decline(id)` mirrors accept: the pending list is re-read first. An id the view does not show (blocked,
 *    expired, over a cap, or already gone) is NOT declined with a rumor: the refresh has already declined it
 *    silently (or it is gone), so the call resolves quietly - a rumor would tell a blocked sender something. For a
 *    shown id it calls `invitations.decline(id, {declineRumor:true})`; if that throws but the id is no longer
 *    pending afterwards (a not-found race), the decline counts as done. The library sends the native decline
 *    rumor (the library decline kind, an addressed gift wrap to the sponsor, whose client then emits `welcomeDeclined`) ONLY when
 *    `declineRumor` is exactly `true`; its default is no rumor, so the flag is explicit. No kind-21063 DM exists.
 *
 * Accept and a local purge of the same group id are mutually exclusive through the purger's per-group lock
 * (`purge.withGroupLock`): the library `accept` (and `attachGroup`) run INSIDE the lock, so an accept started during a
 * purge waits for it, and a purge started once the accept holds the lock waits for the accept (it cannot delete the
 * new membership's first messages). The visibility check before the lock is not part of the exclusion: it only
 * decides whether to try. The `purge` port is REQUIRED (validated at construction), so the exclusion cannot be
 * silently disabled. (S13 edited this accept path, which S9 introduced.)
 *
 * These are called from UI handlers, outside any library frame, so awaiting account-scope calls is allowed.
 * After either, the view is refreshed (a refresh failure is reported, it never turns a success into a failure).
 * Ports are injected and validated at construction.
 */
import type { MarmotGroup } from '@941design/marmot';
import type { LocalGroupPurger } from '../membership/purgeLocalGroup';
import type { PendingInvitationsApi, PendingInvitationView } from './pendingView';

class InvitationActionError extends Error {
  readonly code = 'unknown-invitation' as const;
  constructor(readonly invitationId: string) {
    super(`invitation ${invitationId} is not pending`);
    this.name = 'InvitationActionError';
  }
}

interface InvitationActionsDeps {
  invitations: PendingInvitationsApi & { accept: (id: string) => Promise<MarmotGroup> };
  view: Pick<PendingInvitationView, 'refresh' | 'isVisible'>;
  /** The local purger's per-group lock (`LocalGroupPurger.withGroupLock`): an accept never overlaps a purge of its group. REQUIRED. */
  purge: Pick<LocalGroupPurger, 'withGroupLock'>;
  /** `AccountClient.attachGroup`: starts the app's notification listener on the joined group. */
  attachGroup: (group: MarmotGroup) => void;
  onError?: (error: unknown) => void;
}

export type VerifyInvitationAccept = () => boolean | Promise<boolean>;

export interface InvitationActions {
  accept: (id: string, verify?: VerifyInvitationAccept) => Promise<MarmotGroup>;
  decline: (id: string) => Promise<void>;
}

function requireFn(value: unknown, name: string): void {
  if (typeof value !== 'function') throw new TypeError(`createInvitationActions: required dependency "${name}" is missing`);
}

export function createInvitationActions(deps: InvitationActionsDeps): InvitationActions {
  if (!deps) throw new TypeError('createInvitationActions: dependencies are required');
  requireFn(deps.invitations?.accept, 'invitations.accept');
  requireFn(deps.invitations?.decline, 'invitations.decline');
  requireFn(deps.view?.refresh, 'view.refresh');
  requireFn(deps.view?.isVisible, 'view.isVisible');
  requireFn(deps.attachGroup, 'attachGroup');
  requireFn(deps.purge?.withGroupLock, 'purge.withGroupLock');
  const { invitations, view, attachGroup } = deps;
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/invitations] actions', e));

  const refreshQuietly = async () => {
    try {
      await view.refresh();
    } catch (e) {
      onError(e);
    }
  };

  return {
    accept: async (id, verify) => {
      const shown = await view.refresh();
      if (!view.isVisible(id)) throw new InvitationActionError(id);
      const groupId = Array.isArray(shown) ? shown.find((i) => i.id === id)?.groupId : undefined;
      const join = async () => {
        if (!view.isVisible(id)) throw new InvitationActionError(id);
        if (verify && !(await verify())) throw new InvitationActionError(id);
        const joined = await invitations.accept(id);
        if (process.env.NODE_ENV === 'development') {
          const { afterInvitationAccept } = await import('../../testHooks/marmotSession');
          await afterInvitationAccept(joined.id);
        }
        attachGroup(joined);
        return joined;
      };
      // Without a known group id there is nothing to exclude against (the library rejects the accept of an unknown id).
      const group = groupId !== undefined ? await deps.purge.withGroupLock(groupId, join) : await join();
      await refreshQuietly();
      return group;
    },
    decline: async (id) => {
      await view.refresh();
      if (!view.isVisible(id)) return;
      try {
        await invitations.decline(id, { declineRumor: true });
      } catch (e) {
        await refreshQuietly();
        if (view.isVisible(id)) throw e; // still pending: a real failure
        return; // gone meanwhile: nothing left to decline
      }
      await refreshQuietly();
    },
  };
}
