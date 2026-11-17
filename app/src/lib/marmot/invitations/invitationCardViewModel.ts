/**
 * Invitation card view model (D3, AC-CTX-2 / AC-CTX-5): the pure projection the card renders.
 *
 * The group name comes ONLY from a held invite context whose sender is the invitation's `sponsorAccount` or one
 * of its `sponsors`; a context from anyone else, an expired one, or none at all yields the generic label. The
 * name is untrusted text: it is sanitised and capped again here (defence in depth over the store), and returned
 * as a plain string for a text node. Markup is never interpreted: `<b>x</b>` is shown as those literal
 * characters (React escapes text children; the card must not use `dangerouslySetInnerHTML`).
 *
 * The model deliberately has NO description and NO admin fields: the pre-join card never shows either (the
 * invite context does not carry them, and nothing else is read). It re-computes from the live store snapshot and
 * the pending list, so it is correct whichever of context and invitation arrived first.
 */
import { sanitizeContextName } from './inviteContext';
import { CONTEXT_TTL_MS, type InvitationRef, type InviteContextRecord } from './inviteContextStore';

export interface InvitationCardViewModel {
  invitationId: string;
  /** The text to show as the card title: the sponsor's group name, or the generic label. */
  displayName: string;
  /** Where `displayName` came from. */
  nameSource: 'context' | 'generic';
  sponsorAccount: string;
}

/** The invitation fields the view model reads (a `PendingInvitation` slice). */
export type CardInvitation = InvitationRef & { readonly id: string };

export interface CardViewModelInput {
  invitation: CardInvitation;
  /** Held contexts (`InviteContextStore.snapshot()`). */
  contexts: readonly InviteContextRecord[];
  /** The i18n generic label (`copy.groups.pendingInvitations.unknownGroupFallback`). */
  genericLabel: string;
  /** Clock, ms: contexts older than the 7-day TTL are ignored. */
  now: number;
}

export function buildInvitationCardViewModel(input: CardViewModelInput): InvitationCardViewModel {
  if (!input?.invitation) throw new TypeError('buildInvitationCardViewModel: "invitation" is required');
  if (typeof input.genericLabel !== 'string' || input.genericLabel.length === 0) throw new TypeError('buildInvitationCardViewModel: "genericLabel" is required');
  const { invitation, contexts, genericLabel, now } = input;
  const trusted = new Set([invitation.sponsorAccount, ...invitation.sponsors]);
  // Newest matching context wins (`seq` is the insertion order).
  const match = [...contexts]
    .filter((c) => c.groupId === invitation.groupId && trusted.has(c.sender) && now - c.receivedAt <= CONTEXT_TTL_MS)
    .sort((a, b) => b.seq - a.seq)[0];
  const name = match ? sanitizeContextName(match.name) : '';
  return {
    invitationId: invitation.id,
    displayName: name.length > 0 ? name : genericLabel,
    nameSource: name.length > 0 ? 'context' : 'generic',
    sponsorAccount: invitation.sponsorAccount,
  };
}

/** One model per invitation, in the given order. */
export function buildInvitationCardViewModels(
  invitations: readonly CardInvitation[],
  contexts: readonly InviteContextRecord[],
  genericLabel: string,
  now: number,
): InvitationCardViewModel[] {
  return invitations.map((invitation) => buildInvitationCardViewModel({ invitation, contexts, genericLabel, now }));
}
