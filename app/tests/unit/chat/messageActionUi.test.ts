/**
 * Unit tests for the message edit/delete UI pure helper functions
 * (S6, epic-feature-request-message-edit-and-delete).
 *
 * All tests are pure — no component rendering, no react-testing-library, no
 * idb-keyval / crypto mocking needed (these functions are synchronous and
 * have no I/O side effects), per architecture.md's "no fast-check, no
 * jsdom" convention and the `reactionUiHelpers.test.ts` precedent.
 */

import { describe, it, expect } from 'vitest';
import {
  canEditMessage,
  canShowMessageActions,
  computeDeleteConfirmTransition,
  computeThreadPreviewMessage,
  formatThreadPreviewText,
  isEditSubmitBlocked,
  isInformativeAnnouncement,
  shouldShowEditedMarker,
} from '@/src/lib/messageEdits/messageActionUi';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';

const SELF = 'aabb'.repeat(16);
const OTHER = 'ccdd'.repeat(16);

// The whole informative-announcement family (S7, epic-group-invite-lifecycle):
// every StructuredContent variant EXCEPT `image`. Each entry's content is a
// minimally-valid payload for that variant's parseStructured guard.
const ANNOUNCEMENT_FAMILY: Array<{ name: string; content: string }> = [
  { name: 'invite_lifecycle', content: JSON.stringify({ type: 'invite_lifecycle', event: 'invited', pubkey: OTHER }) },
  { name: 'member_admitted', content: JSON.stringify({ type: 'member_admitted', pubkey: OTHER }) },
  { name: 'leave_intent', content: JSON.stringify({ type: 'leave_intent', pubkey: OTHER }) },
  { name: 'invite_cancelled', content: JSON.stringify({ type: 'invite_cancelled', pubkey: OTHER, by: OTHER }) },
  { name: 'call_notice', content: JSON.stringify({ type: 'call_notice', event: 'started', callId: 'c1', initiator: OTHER }) },
  { name: 'poll_open', content: JSON.stringify({ type: 'poll_open', pollId: 'p1', title: 'Pizza?', creatorPubkey: OTHER }) },
];

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '0'.repeat(64),
    content: 'hello',
    senderPubkey: SELF,
    groupId: 'dm:test',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ─── canShowMessageActions (AC-AUTH-1, AC-TIME-1) ─────────────────────────────

describe('canShowMessageActions', () => {
  it('returns true for a message authored by the current user', () => {
    expect(canShowMessageActions(makeMsg({ senderPubkey: SELF }), SELF)).toBe(true);
  });

  it('returns false for a message authored by someone else (a group peer)', () => {
    expect(canShowMessageActions(makeMsg({ senderPubkey: OTHER }), SELF)).toBe(false);
  });

  it('AC-TIME-1: returns true for an own message regardless of age — no time-window gate', () => {
    const ancient = makeMsg({ senderPubkey: SELF, createdAt: 0 });
    const brandNew = makeMsg({ senderPubkey: SELF, createdAt: Date.now() });
    expect(canShowMessageActions(ancient, SELF)).toBe(true);
    expect(canShowMessageActions(brandNew, SELF)).toBe(true);
  });

  it('compares pubkeys case-insensitively, matching the epic\'s other seam guards', () => {
    expect(canShowMessageActions(makeMsg({ senderPubkey: SELF.toUpperCase() }), SELF)).toBe(true);
    expect(canShowMessageActions(makeMsg({ senderPubkey: SELF }), SELF.toUpperCase())).toBe(true);
  });

  it('gate-remediation (finding 1): allowMessageActions=false hides actions even on an own message', () => {
    expect(canShowMessageActions(makeMsg({ senderPubkey: SELF }), SELF, false)).toBe(false);
  });

  it('gate-remediation (finding 1): allowMessageActions defaults to true when omitted', () => {
    expect(canShowMessageActions(makeMsg({ senderPubkey: SELF }), SELF)).toBe(true);
    expect(canShowMessageActions(makeMsg({ senderPubkey: SELF }), SELF, true)).toBe(true);
  });

  // ─── S7 immutability: whole informative-announcement family (AC-IMMUT-1/2/3) ──
  // All group-context cases now pass isGroupContext=true explicitly (5th arg) —
  // gate-remediation (S7, group-vs-DM scoping) moved the family suppression
  // behind that flag so it no longer fires for DM threads (see the DM-context
  // describe block below).

  describe.each(ANNOUNCEMENT_FAMILY)('for a $name announcement (group context)', ({ content }) => {
    it('gate-remediation (finding 1): DD-5 closes the pre-existing gap — a non-admin viewer loses Delete even on their OWN announcement (previously true via bare own-message authorship, before this predicate existed)', () => {
      const ownAnnouncement = makeMsg({ senderPubkey: SELF, content });
      expect(canShowMessageActions(ownAnnouncement, SELF, true, false, true)).toBe(false);
    });

    it('AC-IMMUT-1: non-admin viewer gets no actions on a peer-authored announcement either', () => {
      const peerAnnouncement = makeMsg({ senderPubkey: OTHER, content });
      expect(canShowMessageActions(peerAnnouncement, SELF, true, false, true)).toBe(false);
    });

    it('AC-IMMUT-3: admin viewer sees the moderation Delete affordance regardless of who authored it', () => {
      const peerAnnouncement = makeMsg({ senderPubkey: OTHER, content });
      expect(canShowMessageActions(peerAnnouncement, SELF, true, true, true)).toBe(true);
    });

    it('AC-IMMUT-3: admin carve-out is Delete-only — canEditMessage stays false even for the admin viewer', () => {
      const peerAnnouncement = makeMsg({ senderPubkey: OTHER, content });
      expect(canShowMessageActions(peerAnnouncement, SELF, true, true, true)).toBe(true);
      expect(canEditMessage(peerAnnouncement)).toBe(false);
    });

    it('isCurrentUserAdmin defaults to false when omitted (no accidental moderation-delete grant)', () => {
      const ownAnnouncement = makeMsg({ senderPubkey: SELF, content });
      expect(canShowMessageActions(ownAnnouncement, SELF, true, undefined, true)).toBe(false);
    });
  });

  // ─── Gate-remediation (S7, group-vs-DM scoping): DM context restores pre-S7 behavior ──
  // A DM thread never passes isGroupContext (ContactChat has no such prop and
  // ChatBox defaults it to false), so an announcement-shaped DM message (e.g. a
  // call_notice) must fall through to the ordinary own-message authorship rule —
  // exactly as it behaved before S7 introduced the family-wide suppression.

  describe.each(ANNOUNCEMENT_FAMILY)('for a $name announcement (DM context)', ({ content }) => {
    it('DM: author CAN still delete their own announcement-shaped message with isGroupContext omitted (pre-S7 behavior restored)', () => {
      const ownAnnouncement = makeMsg({ senderPubkey: SELF, content });
      expect(canShowMessageActions(ownAnnouncement, SELF, true, false)).toBe(true);
    });

    it('DM: author CAN still delete their own announcement-shaped message with isGroupContext explicitly false', () => {
      const ownAnnouncement = makeMsg({ senderPubkey: SELF, content });
      expect(canShowMessageActions(ownAnnouncement, SELF, true, false, false)).toBe(true);
    });

    it('DM: non-author gets no actions on the peer\'s announcement-shaped message — ordinary authorship rule, not the family suppression', () => {
      const peerAnnouncement = makeMsg({ senderPubkey: OTHER, content });
      expect(canShowMessageActions(peerAnnouncement, SELF, true, false, false)).toBe(false);
    });

    it('DM: a stray isCurrentUserAdmin=true does not grant a moderation delete outside group context (DMs have no admins)', () => {
      const peerAnnouncement = makeMsg({ senderPubkey: OTHER, content });
      expect(canShowMessageActions(peerAnnouncement, SELF, true, true, false)).toBe(false);
    });
  });

  it('AC-IMMUT-2: a non-admin viewer keeps Delete on their OWN image-type message — the family suppression does not extend to image', () => {
    const ownImage = makeMsg({
      senderPubkey: SELF,
      content: JSON.stringify({ type: 'image', version: 1, caption: 'hi' }),
    });
    expect(canShowMessageActions(ownImage, SELF, true, false)).toBe(true);
  });

  it('AC-IMMUT-2: an admin viewer authoring their own image message is gated by ordinary authorship, not the moderation carve-out', () => {
    const peerImage = makeMsg({
      senderPubkey: OTHER,
      content: JSON.stringify({ type: 'image', version: 1, caption: 'hi' }),
    });
    // Not the author, and image is excluded from the announcement family, so even
    // an admin viewer does NOT get a moderation delete on someone else's photo.
    expect(canShowMessageActions(peerImage, SELF, true, true)).toBe(false);
  });

  it('does not over-suppress a plain-text message for a non-admin viewer (predicate must not fire on parseStructured === null)', () => {
    expect(canShowMessageActions(makeMsg({ senderPubkey: SELF, content: 'hello' }), SELF, true, false)).toBe(true);
  });

  it('does not over-suppress a plain-text message for an admin viewer either', () => {
    expect(canShowMessageActions(makeMsg({ senderPubkey: SELF, content: 'hello' }), SELF, true, true)).toBe(true);
  });

  it('allowMessageActions=false still hides actions on an announcement even for an admin viewer', () => {
    const announcement = makeMsg({
      senderPubkey: OTHER,
      content: JSON.stringify({ type: 'member_admitted', pubkey: OTHER }),
    });
    expect(canShowMessageActions(announcement, SELF, false, true)).toBe(false);
  });
});

// ─── isInformativeAnnouncement (S7, epic-group-invite-lifecycle) ──────────────

describe('isInformativeAnnouncement', () => {
  it.each(ANNOUNCEMENT_FAMILY)('returns true for a $name message', ({ content }) => {
    expect(isInformativeAnnouncement(makeMsg({ content }))).toBe(true);
  });

  it('returns false for an image-type message — image is excluded from the family', () => {
    const imageMsg = makeMsg({ content: JSON.stringify({ type: 'image', version: 1, caption: 'hi' }) });
    expect(isInformativeAnnouncement(imageMsg)).toBe(false);
  });

  it('returns false for a plain-text message (parseStructured returns null)', () => {
    expect(isInformativeAnnouncement(makeMsg({ content: 'just chatting' }))).toBe(false);
  });

  it('returns false for content that is not valid JSON at all', () => {
    expect(isInformativeAnnouncement(makeMsg({ content: 'not { json' }))).toBe(false);
  });
});

// ─── canEditMessage (AC-IMG-2) ─────────────────────────────────────────────────

describe('canEditMessage', () => {
  it('returns true for a text message (no attachments)', () => {
    expect(canEditMessage(makeMsg())).toBe(true);
  });

  it('returns false for an image-shaped message (attachments present)', () => {
    const imageMsg = makeMsg({
      attachments: { full: { url: 'https://example.com/a.webp' } } as ChatMessage['attachments'],
    });
    expect(canEditMessage(imageMsg)).toBe(false);
  });

  it('gate-remediation (finding 3): returns false for a structured poll_open announcement', () => {
    const pollMsg = makeMsg({
      content: JSON.stringify({ type: 'poll_open', pollId: 'p1', title: 'Pizza?', creatorPubkey: SELF }),
    });
    expect(canEditMessage(pollMsg)).toBe(false);
  });

  it('gate-remediation (finding 3): returns false for a structured leave_intent announcement', () => {
    const leaveMsg = makeMsg({ content: JSON.stringify({ type: 'leave_intent', pubkey: SELF }) });
    expect(canEditMessage(leaveMsg)).toBe(false);
  });

  it('gate-remediation (finding 3): returns false for an image-structured message even without an attachments bag', () => {
    const imageStructuredMsg = makeMsg({
      content: JSON.stringify({ type: 'image', version: 1, caption: 'hi' }),
    });
    expect(canEditMessage(imageStructuredMsg)).toBe(false);
  });
});

// ─── isEditSubmitBlocked (AC-EDIT-5) ───────────────────────────────────────────

describe('isEditSubmitBlocked', () => {
  it('blocks empty content', () => {
    expect(isEditSubmitBlocked('')).toBe(true);
  });

  it('blocks whitespace-only content', () => {
    expect(isEditSubmitBlocked('   \n\t  ')).toBe(true);
  });

  it('allows non-empty trimmed content', () => {
    expect(isEditSubmitBlocked('hello')).toBe(false);
  });

  it('allows content with surrounding whitespace but real text', () => {
    expect(isEditSubmitBlocked('  hi  ')).toBe(false);
  });
});

// ─── shouldShowEditedMarker (AC-EDIT-3) ────────────────────────────────────────

describe('shouldShowEditedMarker', () => {
  it('returns false when edited is absent', () => {
    expect(shouldShowEditedMarker(makeMsg())).toBe(false);
  });

  it('returns false when edited is explicitly false', () => {
    expect(shouldShowEditedMarker(makeMsg({ edited: false }))).toBe(false);
  });

  it('returns true when edited is true', () => {
    expect(shouldShowEditedMarker(makeMsg({ edited: true }))).toBe(true);
  });
});

// ─── computeDeleteConfirmTransition (AC-DEL-6) ────────────────────────────────

describe('computeDeleteConfirmTransition', () => {
  it('a single click on an unarmed message arms it, does not delete', () => {
    const result = computeDeleteConfirmTransition(null, 'msg-1');
    expect(result).toEqual({ nextPendingId: 'msg-1', shouldDelete: false });
  });

  it('a second click on the SAME armed message confirms the delete', () => {
    const result = computeDeleteConfirmTransition('msg-1', 'msg-1');
    expect(result).toEqual({ nextPendingId: null, shouldDelete: true });
  });

  it('a click on a DIFFERENT message re-arms that one instead of stacking', () => {
    const result = computeDeleteConfirmTransition('msg-1', 'msg-2');
    expect(result).toEqual({ nextPendingId: 'msg-2', shouldDelete: false });
  });
});

// ─── computeThreadPreviewMessage / formatThreadPreviewText (AC-LIST-1, AC-LIST-2) ──

describe('computeThreadPreviewMessage', () => {
  it('returns null for an empty thread', () => {
    expect(computeThreadPreviewMessage([])).toBeNull();
  });

  it('returns null when every message is tombstoned', () => {
    const messages = [makeMsg({ id: 'a', tombstoned: true, createdAt: 1 })];
    expect(computeThreadPreviewMessage(messages)).toBeNull();
  });

  it('returns the latest message by createdAt (unsorted input)', () => {
    const messages = [
      makeMsg({ id: 'older', content: 'first', createdAt: 100 }),
      makeMsg({ id: 'newest', content: 'third', createdAt: 300 }),
      makeMsg({ id: 'middle', content: 'second', createdAt: 200 }),
    ];
    expect(computeThreadPreviewMessage(messages)?.id).toBe('newest');
  });

  it('AC-LIST-1: reflects new content once the last message has been edited in place', () => {
    const messages = [
      makeMsg({ id: 'a', content: 'original text', createdAt: 100, edited: true, rev: 5 }),
    ];
    const preview = computeThreadPreviewMessage(messages);
    expect(preview?.content).toBe('original text');
  });

  it('AC-LIST-2: falls back to the previous surviving message once the last message is tombstoned', () => {
    const messages = [
      makeMsg({ id: 'first', content: 'still here', createdAt: 100 }),
      makeMsg({ id: 'last', content: 'deleted content', createdAt: 200, tombstoned: true }),
    ];
    const preview = computeThreadPreviewMessage(messages);
    expect(preview?.id).toBe('first');
    expect(preview?.content).toBe('still here');
  });
});

describe('formatThreadPreviewText', () => {
  const strings = { emptyText: 'No messages yet', photoText: 'Photo', structuredText: 'New activity' };

  it('AC-LIST-2: returns the empty-state text when no surviving messages remain', () => {
    const messages = [makeMsg({ id: 'a', tombstoned: true })];
    expect(formatThreadPreviewText(messages, strings)).toBe('No messages yet');
  });

  it('returns the empty-state text for a thread with no messages at all', () => {
    expect(formatThreadPreviewText([], strings)).toBe('No messages yet');
  });

  it('AC-LIST-1: returns the edited content for a text message', () => {
    const messages = [makeMsg({ content: 'updated text', edited: true })];
    expect(formatThreadPreviewText(messages, strings)).toBe('updated text');
  });

  it('returns the photo placeholder for an image-shaped last message, not raw content', () => {
    const messages = [
      makeMsg({
        content: '{"type":"image"}',
        attachments: { full: { url: 'https://example.com/a.webp' } } as ChatMessage['attachments'],
      }),
    ];
    expect(formatThreadPreviewText(messages, strings)).toBe('Photo');
  });

  it('AC-LIST-2: falls back past a deleted last message to the previous surviving one', () => {
    const messages = [
      makeMsg({ id: 'first', content: 'earlier message', createdAt: 100 }),
      makeMsg({ id: 'last', content: 'retracted', createdAt: 200, tombstoned: true }),
    ];
    expect(formatThreadPreviewText(messages, strings)).toBe('earlier message');
  });

  it('gate-remediation (finding 2): returns the neutral structured placeholder for a poll_open last message, not raw JSON', () => {
    const messages = [
      makeMsg({ content: JSON.stringify({ type: 'poll_open', pollId: 'p1', title: 'Pizza?', creatorPubkey: SELF }) }),
    ];
    expect(formatThreadPreviewText(messages, strings)).toBe('New activity');
  });

  it('gate-remediation (finding 2): returns the neutral structured placeholder for a call_notice last message', () => {
    const messages = [
      makeMsg({ content: JSON.stringify({ type: 'call_notice', event: 'started', callId: 'c1', initiator: SELF }) }),
    ];
    expect(formatThreadPreviewText(messages, strings)).toBe('New activity');
  });

  it('gate-remediation (finding 2): returns the neutral structured placeholder for a leave_intent last message', () => {
    const messages = [makeMsg({ content: JSON.stringify({ type: 'leave_intent', pubkey: SELF }) })];
    expect(formatThreadPreviewText(messages, strings)).toBe('New activity');
  });

  it('gate-remediation (finding 2): returns the neutral structured placeholder for an invite_cancelled last message', () => {
    const messages = [makeMsg({ content: JSON.stringify({ type: 'invite_cancelled', pubkey: SELF, by: SELF }) })];
    expect(formatThreadPreviewText(messages, strings)).toBe('New activity');
  });

  it('gate-remediation (finding 2): returns the photo placeholder for an image-structured last message even without an attachments bag', () => {
    const messages = [makeMsg({ content: JSON.stringify({ type: 'image', version: 1, caption: 'hi' }) })];
    expect(formatThreadPreviewText(messages, strings)).toBe('Photo');
  });
});
