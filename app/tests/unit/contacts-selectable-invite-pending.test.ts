import { describe, expect, it } from 'vitest';
import { selectableContactsForGroup } from '@/src/lib/contacts';
import type { ContactListItem } from '@/src/lib/contacts';
import { getCopy } from '@/src/lib/i18n';

// Bug: admin-and-invite-guards (2). A member who has not yet confirmed (no
// non-provisional profile; the "Pending" badge signal, confirmedPubkeys) was
// labelled "already in group" in the invite picker. They now get the distinct
// disabled reason 'invite_pending'.

function makeContact(pubkeyHex: string, overrides: Partial<ContactListItem> = {}): ContactListItem {
  return {
    pubkeyHex,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    nickname: '',
    avatar: null,
    updatedAt: null,
    isArchived: false,
    isPendingConfirmation: false,
    ...overrides,
  };
}

const ALICE = 'aa11';
const BOB = 'bb22';
const CAROL = 'cc33';

describe('selectableContactsForGroup — invite_pending (VQ-3)', () => {
  it('a member not in confirmedPubkeys is disabled as invite_pending', () => {
    const contact = makeContact(BOB);
    expect(
      selectableContactsForGroup([contact], { memberPubkeys: [ALICE, BOB], confirmedPubkeys: new Set([ALICE]) }),
    ).toEqual([{ contact, selectable: false, disabledReason: 'invite_pending' }]);
  });

  it('a confirmed member keeps already_member', () => {
    const contact = makeContact(BOB);
    expect(
      selectableContactsForGroup([contact], { memberPubkeys: [BOB], confirmedPubkeys: new Set([BOB]) }),
    ).toEqual([{ contact, selectable: false, disabledReason: 'already_member' }]);
  });

  it('a non-member stays selectable whatever confirmedPubkeys holds', () => {
    const contact = makeContact(CAROL);
    expect(
      selectableContactsForGroup([contact], { memberPubkeys: [ALICE], confirmedPubkeys: new Set([ALICE]) }),
    ).toStrictEqual([{ contact, selectable: true }]);
  });

  it('without a confirmedPubkeys signal every member stays already_member (signal not loaded yet)', () => {
    const contact = makeContact(BOB);
    expect(selectableContactsForGroup([contact], { memberPubkeys: [BOB] })).toEqual([
      { contact, selectable: false, disabledReason: 'already_member' },
    ]);
  });

  it('compares pubkeys case-insensitively across memberPubkeys and confirmedPubkeys', () => {
    const pending = makeContact('BB22');
    const confirmed = makeContact('AA11');
    const result = selectableContactsForGroup([pending, confirmed], {
      memberPubkeys: ['bb22', 'aa11'],
      confirmedPubkeys: new Set(['AA11']),
    });
    expect(result.map((e) => e.disabledReason)).toEqual(['invite_pending', 'already_member']);
  });

  it('invite_pending applies regardless of isArchived/isPendingConfirmation (membership wins, like already_member)', () => {
    const contact = makeContact(BOB, { isArchived: true, isPendingConfirmation: true });
    const [entry] = selectableContactsForGroup([contact], {
      memberPubkeys: [BOB],
      confirmedPubkeys: new Set(),
    });
    expect(entry.disabledReason).toBe('invite_pending');
  });

  it('preserves input order in a mixed list', () => {
    const contacts = [makeContact(ALICE), makeContact(BOB), makeContact(CAROL)];
    const result = selectableContactsForGroup(contacts, {
      memberPubkeys: [ALICE, BOB],
      confirmedPubkeys: new Set([ALICE]),
    });
    expect(result.map((e) => [e.contact.pubkeyHex, e.selectable, e.disabledReason])).toEqual([
      [ALICE, false, 'already_member'],
      [BOB, false, 'invite_pending'],
      [CAROL, true, undefined],
    ]);
  });
});

describe('invite_pending copy (VQ-3)', () => {
  it('uses the decided en/de labels, lowercase like inviteReasonAlreadyMember', () => {
    expect(getCopy('en').groups.inviteReasonInvitePending).toBe('invitation pending');
    expect(getCopy('de').groups.inviteReasonInvitePending).toBe('Einladung ausstehend');
  });
});
