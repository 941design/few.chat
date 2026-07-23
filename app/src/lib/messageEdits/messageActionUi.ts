/**
 * Pure UI helper functions for the message edit/delete surface (S6,
 * epic-feature-request-message-edit-and-delete).
 *
 * Mirrors `app/src/lib/reactions/reactionUiHelpers.ts`'s precedent: these
 * helpers are extracted from `ChatBox.tsx` so the action-menu gating,
 * edit-submit validation, delete-confirmation transition, and list-preview
 * computation can be unit tested without mounting React (this project has
 * no @testing-library/react / jsdom dependency — see
 * `themes/contrast.hexParsing.test.ts:3-6`).
 *
 * Exported from lib/ so components/chat/ and components/groups/ (GroupCard)
 * can both import without violating the downward-import rule (lib/ ← components/
 * is forbidden; components/ → lib/ is allowed).
 *
 * `computeThreadPreviewMessage` intentionally imports `filterVisibleMessages`
 * from `chatPersistence.ts` — the same pure tombstone-read-filter S1 defined
 * for every render path (`chatPersistence.ts:524`'s doc comment names "list
 * preview" explicitly as a consumer). This is a read-only filter import, not
 * a write/reconciliation primitive — it does not pull in `messageEdits/api.ts`
 * or `messageEdits/rumor.ts`.
 */

import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';
import { filterVisibleMessages } from '@/src/lib/marmot/chatPersistence';
import { parseStructured } from '@/src/lib/marmot/parseStructured';
import { isInformativeAnnouncementContent } from '@/src/lib/marmot/announcementFamily';

/**
 * S7 (epic-group-invite-lifecycle): true iff `message.content` parses (via
 * `parseStructured`) to a non-null, non-`image` StructuredContent — i.e. the
 * message belongs to the "informative-announcement" family (invite_lifecycle,
 * member_admitted, leave_intent, invite_cancelled, group_renamed, call_notice,
 * polls). Generic over ANY parseStructured result — this is the load-bearing
 * family identifier; it holds even for announcement types added after this
 * story lands, with no per-type special-casing.
 *
 * S8 gate-consistency note: this is now a thin wrapper over the shared
 * `isInformativeAnnouncementContent` (`lib/marmot/announcementFamily.ts`) —
 * the SAME content-level predicate S8's receive-side gate
 * (`messageEdits/api.ts`, `marmot/chatPersistence.ts`) imports and calls
 * directly. Extracted so the UI-suppression family definition (this
 * function) and the receive-side enforcement family definition can never
 * silently diverge into two parallel implementations.
 */
export function isInformativeAnnouncement(message: ChatMessage): boolean {
  return isInformativeAnnouncementContent(message.content);
}

/**
 * AC-AUTH-1 / AC-TIME-1: the edit/delete action menu is shown only on the
 * current user's own messages, and — critically — with NO age/time-window
 * gate at all (D6). There is deliberately no timestamp comparison here.
 *
 * `allowMessageActions` (default true) is the surface-level gate: the
 * sealed feedback surface (ContactChat `source="feedback"`) passes `false`
 * because its send paths carry no feedback marker tags — an edit/delete
 * kind-14/kind-5 published from that surface would land in the maintainer's
 * sealed channel unmarked. Mirrors the reactions precedent (gate off, never
 * thread markers through).
 *
 * Pubkey comparison is case-insensitive to match the epic's other seam
 * guards (e.g. `ContactChat`'s own-message auth checks), which all
 * `.toLowerCase()` both sides before comparing.
 *
 * AC-IMMUT-1/2/3 (S7, DD-5): for the WHOLE informative-announcement family
 * (every `StructuredContent` variant except `image` — see
 * `isInformativeAnnouncement`), ordinary authorship is ignored entirely —
 * but ONLY inside a group thread. A non-admin viewer gets no actions at
 * all on a GROUP announcement — even one they authored themselves (this
 * closes a pre-existing gap: before this predicate existed, an own
 * announcement was actions-visible via the bare authorship check below).
 * An admin viewer gets the action affordance on any group announcement
 * regardless of who authored it, but this is a moderation-only Delete:
 * `canEditMessage` already returns `false` for any structured message, so
 * Edit stays suppressed for everyone, admin included. `image` messages are
 * NOT part of the family — they keep the ordinary own-message authorship
 * rule below, for every viewer.
 *
 * Gate-remediation (S7, group-vs-DM scoping): the family-wide suppression
 * above is a GROUP-chat concept only — groups have admins and a shared
 * announcement history that must stay tamper-evident; 1:1 DMs have neither.
 * `isGroupContext` (default `false`, matching the DM surface which never
 * passes it) gates the whole announcement-family branch: when `false`, an
 * announcement message is judged by the ordinary own-message authorship
 * rule below, same as any other message — restoring the pre-S7 behavior
 * where a DM's own `call_notice` (or any other announcement-shaped
 * message) stays author-deletable/editable-per-`canEditMessage`. Only the
 * GROUP call path (`GroupChat.tsx`, unconditionally — an admin viewer is
 * still inside a group even when `isCurrentUserAdmin` is `false`) passes
 * `isGroupContext={true}`.
 */
export function canShowMessageActions(
  message: ChatMessage,
  currentUserPubkey: string,
  allowMessageActions: boolean = true,
  isCurrentUserAdmin: boolean = false,
  isGroupContext: boolean = false,
): boolean {
  if (!allowMessageActions) return false;
  if (isGroupContext && isInformativeAnnouncement(message)) return isCurrentUserAdmin;
  return message.senderPubkey.toLowerCase() === currentUserPubkey.toLowerCase();
}

/**
 * AC-IMG-2: an image-shaped message (attachments present) never offers an
 * edit affordance — delete-only. A message with no `attachments` (or an
 * empty attachments bag) is text-shaped and editable.
 *
 * Also false for any structured-content message (poll/call/leave/invite —
 * anything `parseStructured` recognizes), including an image-structured
 * message whose `attachments` bag happens to be absent: only plain text is
 * editable. Editing a structured announcement would pre-fill the composer
 * with raw JSON and, on save, corrupt the announcement for every member.
 */
export function canEditMessage(message: ChatMessage): boolean {
  if (message.attachments) return false;
  return parseStructured(message.content) === null;
}

/**
 * AC-EDIT-5: an edit that would produce empty (or whitespace-only) content
 * is disallowed. Used to gate the Save button AND to decide whether to show
 * the "delete instead" hint — never a silent no-op.
 */
export function isEditSubmitBlocked(content: string): boolean {
  return content.trim().length === 0;
}

/** AC-EDIT-3: the "(edited)" marker renders iff the row's `edited` flag is set. */
export function shouldShowEditedMarker(message: ChatMessage): boolean {
  return message.edited === true;
}

export interface DeleteConfirmTransition {
  /** The next value for the component's pendingDeleteId state. */
  nextPendingId: string | null;
  /** True iff this click is the confirming click — handleDeleteMessage should fire. */
  shouldDelete: boolean;
}

/**
 * AC-DEL-6: deleting requires an explicit confirmation step — a single click
 * must not delete. Models the two-click flow as a pure state transition:
 * the first click on a message's delete action arms it (shows a confirm
 * affordance); a second click on the SAME armed message confirms; a click on
 * a DIFFERENT message re-arms that one instead (never stacks confirmations).
 */
export function computeDeleteConfirmTransition(
  pendingDeleteId: string | null,
  clickedMessageId: string,
): DeleteConfirmTransition {
  if (pendingDeleteId === clickedMessageId) {
    return { nextPendingId: null, shouldDelete: true };
  }
  return { nextPendingId: clickedMessageId, shouldDelete: false };
}

/**
 * AC-LIST-1 / AC-LIST-2: resolves a thread's list-preview source message —
 * the latest surviving (non-tombstoned) message, or `null` when none remain
 * (empty state). Filtering through `filterVisibleMessages` means a deleted
 * last message automatically falls back to the previous surviving message
 * (or `null`); an edited last message is reflected because `content` is
 * already updated in place by the reconciliation core (AC-EDIT-2) — no
 * edit-specific branch is needed here.
 *
 * Does not assume the input is pre-sorted (storage reads are not guaranteed
 * sorted by `createdAt`).
 */
export function computeThreadPreviewMessage(messages: ChatMessage[]): ChatMessage | null {
  const visible = filterVisibleMessages(messages);
  if (visible.length === 0) return null;
  return visible.reduce((latest, m) => (m.createdAt > latest.createdAt ? m : latest));
}

export interface ThreadPreviewStrings {
  /** Shown when the thread has no surviving messages (AC-LIST-2 empty-state branch). */
  emptyText: string;
  /** Shown in place of raw content for an image-shaped message. */
  photoText: string;
  /**
   * Shown in place of raw content for any other structured-content message
   * (poll/call/leave/invite — anything `parseStructured` recognizes besides
   * `image`). Without this, list previews rendered the raw JSON envelope
   * (e.g. `{"type":"poll_open",...}`) whenever a structured message was the
   * thread's last surviving row.
   */
  structuredText: string;
}

/**
 * Formats the list-preview text for a thread given its (possibly raw,
 * possibly unsorted) message array. Pure — no i18n context dependency; the
 * caller supplies the already-resolved copy strings.
 */
export function formatThreadPreviewText(messages: ChatMessage[], strings: ThreadPreviewStrings): string {
  const preview = computeThreadPreviewMessage(messages);
  if (!preview) return strings.emptyText;
  if (preview.attachments) return strings.photoText;
  const structured = parseStructured(preview.content);
  if (structured?.type === 'image') return strings.photoText;
  if (structured) return strings.structuredText;
  return preview.content;
}
