import type { Group, ProfileAvatar } from '@/src/types';
import { STORAGE_KEYS } from '@/src/types';
import { isStorageAvailable } from '@/src/lib/storage';
import { isAllowedDmSender } from '@/src/lib/walledGarden';
import type { WhitelistArgs } from '@/src/lib/walledGarden';
import { npubToPubkeyHex } from '@/src/lib/nostrKeys';
import { rememberKnownPeers } from '@/src/lib/knownPeers';
import { postStoreChanged } from '@/src/lib/crossTab';
import { sanitizeStoredAvatar } from '@/src/lib/dmProfile/kinds';

export type StoredContact = {
  pubkeyHex: string;
  firstSeenAt: string;
  lastSeenAt: string;
  archivedAt?: string | null;
  /**
   * Non-null ISO timestamp while this contact is awaiting the user's
   * explicit confirmation (epic: pending-contact-confirmation); `null`
   * (the default for every contact-add path except `handlePairingAck`'s
   * issuer-side admission of a brand-new sender) means confirmed/normal.
   * Mirrors the existing `archivedAt` null-means-normal convention
   * (spec.md Design Decision 2) — a second, independent nullable-timestamp
   * axis, not a combined status enum.
   */
  pendingConfirmationSince?: string | null;
};

export type ContactListItem = StoredContact & {
  nickname: string;
  avatar: ProfileAvatar | null;
  updatedAt: string | null;
  archivedAt: string | null;
  isArchived: boolean;
  /** Derived from `pendingConfirmationSince != null`, mirroring `isArchived`. */
  isPendingConfirmation: boolean;
};

type StoredContactMap = Record<string, StoredContact>;
type ContactCacheMap = Record<string, { nickname: string; avatar: ProfileAvatar | null; updatedAt: string }>;

function readContactCacheSnapshot(): ContactCacheMap {
  if (!isStorageAvailable()) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.contactCache);
    const parsed = raw ? (JSON.parse(raw) as ContactCacheMap) : {};
    // Bug stored-group-avatars-not-resanitized: same on-read avatar rule as
    // contactCache.ts#readContactCache — unsafe avatar → null, entry kept.
    // (Read-only snapshot, looked up by pubkey: a JSON `null` throws into the
    // catch below; other malformed shapes simply yield no match.)
    return Object.fromEntries(
      Object.entries(parsed).map(([key, entry]) => [key, entry && { ...entry, avatar: sanitizeStoredAvatar(entry.avatar) }]),
    );
  } catch {
    return {};
  }
}

function normalizeStoredContact(pubkeyHex: string, value: Partial<StoredContact> | null | undefined): StoredContact {
  return {
    pubkeyHex: value?.pubkeyHex || pubkeyHex,
    firstSeenAt: value?.firstSeenAt || new Date(0).toISOString(),
    lastSeenAt: value?.lastSeenAt || value?.firstSeenAt || new Date(0).toISOString(),
    archivedAt: value?.archivedAt ?? null,
    // AC-STRUCT-1/AC-STRUCT-2: any persisted entry lacking this field
    // (every contact stored before this epic shipped) resolves to `null` —
    // purely additive, never a source of a spontaneously-pending contact.
    pendingConfirmationSince: value?.pendingConfirmationSince ?? null,
  };
}

export function readStoredContacts(): StoredContactMap {
  if (!isStorageAvailable()) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.contacts);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<StoredContact>>;
    return Object.fromEntries(
      Object.entries(parsed).map(([pubkeyHex, value]) => [pubkeyHex, normalizeStoredContact(pubkeyHex, value)]),
    );
  } catch {
    return {};
  }
}

/**
 * Persists the contacts map; true iff it landed. Other open tabs are told
 * only after a successful write (cross-tab change notifications).
 */
function writeStoredContacts(next: StoredContactMap): boolean {
  if (!isStorageAvailable()) return false;
  try {
    localStorage.setItem(STORAGE_KEYS.contacts, JSON.stringify(next));
  } catch {
    // silent — storage may be full
    return false;
  }
  postStoreChanged('contacts');
  return true;
}

/**
 * Persists a contact by pubkeyHex and last-seen timestamp.
 *
 * @param pubkeyHex - Hex pubkey of the contact to remember.
 * @param seenAt    - ISO timestamp of the event that triggered the remember.
 * @param isAllowed - Optional whitelist accessor injected by callers on the DM
 *                    inbound path (AC-STRUCT-2, DD-6). When provided and returns
 *                    `false` for `pubkeyHex`, the function silently no-ops without
 *                    throwing. Callers that are NOT on the DM path (e.g.
 *                    contactCache profile sync, rememberContactsFromGroups) omit
 *                    this parameter to preserve the existing allow-all behaviour.
 */
export function rememberContact(
  pubkeyHex: string,
  seenAt: string = new Date().toISOString(),
  isAllowed?: (peer: string) => boolean,
): void {
  if (!pubkeyHex) return;
  // AC-STRUCT-2: silently no-op when the whitelist accessor rejects this peer.
  if (isAllowed !== undefined && !isAllowed(pubkeyHex)) return;
  const contacts = readStoredContacts();
  const next = seenContact(contacts[pubkeyHex], pubkeyHex, seenAt);
  if (!next) return;
  contacts[pubkeyHex] = next;
  writeStoredContacts(contacts);
}

/**
 * The stored contact after a sighting at `seenAt`, or null when the sighting
 * changes nothing (an existing contact already seen at or after `seenAt`) —
 * callers skip the write, so other tabs are not told about a non-change.
 */
function seenContact(existing: StoredContact | undefined, pubkeyHex: string, seenAt: string): StoredContact | null {
  if (!existing) {
    return { pubkeyHex, firstSeenAt: seenAt, lastSeenAt: seenAt, archivedAt: null };
  }
  if (existing.lastSeenAt >= seenAt) return null;
  return { ...existing, lastSeenAt: seenAt };
}

/**
 * Admits the ISSUER-side (passive) sender of a pairing handshake — the
 * pending-admission primitive used ONLY by `handlePairingAck`'s Step 9
 * (`pairingAck.ts`), in place of {@link rememberContact}, for the person
 * whose contact card was scanned. Epic: pending-contact-confirmation.
 *
 * Unlike {@link rememberContact}, lookup against `readStoredContacts()` is
 * **case-insensitive** (AC-STRUCT-4), mirroring `addContactByNpub`'s
 * `matchingKeys` pattern (below) — stored keys are not guaranteed
 * lowercase, and this primitive must still find (and correctly preserve)
 * an existing entry regardless of the casing it was stored under.
 *
 * - **Brand-new sender** (no case-insensitive match): creates the entry
 *   with `pendingConfirmationSince` set to `seenAt` (AC-ADMIT-1).
 * - **Re-pairing sender** (a match already exists): bumps `lastSeenAt`
 *   exactly like `rememberContact` does today, leaving `archivedAt` AND
 *   `pendingConfirmationSince` byte-for-byte as they were — a re-pairing
 *   MUST NOT set a previously-`null` `pendingConfirmationSince` to
 *   non-null, and MUST NOT clear an already-pending value (AC-ADMIT-2),
 *   mirroring the existing `archivedAt`-preservation precedent right next
 *   to this call site in `pairingAck.ts`.
 *
 * @param pubkeyHex - Hex pubkey of the admitted sender (already
 *                    lowercase — `handlePairingAck` derives it from
 *                    `rumor.pubkey.toLowerCase()` — but this function does
 *                    not assume that of the STORED key it matches against).
 * @param seenAt    - ISO timestamp of the admission event.
 */
export function rememberPendingContact(
  pubkeyHex: string,
  seenAt: string = new Date().toISOString(),
): void {
  if (!pubkeyHex) return;
  const contacts = readStoredContacts();
  const target = pubkeyHex.toLowerCase();
  // Gather ALL case-insensitive matches (not just the first) — legacy
  // storage can hold two entries for one pubkey differing only in case,
  // and updating a single arbitrarily-chosen match could leave a
  // differently-cased duplicate stale. Mirrors addContactByNpub's
  // `matchingKeys` pattern above.
  const matchingKeys = Object.keys(contacts).filter((key) => key.toLowerCase() === target);
  if (matchingKeys.length > 0) {
    for (const matchingKey of matchingKeys) {
      const existing = contacts[matchingKey];
      contacts[matchingKey] = {
        ...existing,
        lastSeenAt: existing.lastSeenAt >= seenAt ? existing.lastSeenAt : seenAt,
      };
    }
  } else {
    contacts[pubkeyHex] = {
      pubkeyHex,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      archivedAt: null,
      pendingConfirmationSince: seenAt,
    };
  }
  writeStoredContacts(contacts);
}

/**
 * Finalizes a pending contact, clearing `pendingConfirmationSince` to
 * `null`. Epic: pending-contact-confirmation (AC-CONFIRM-1, AC-CONFIRM-2).
 *
 * Resolves `pubkeyHex` against `readStoredContacts()` **case-insensitively**
 * (AC-STRUCT-4), mirroring `addContactByNpub`'s `matchingKeys` pattern — a
 * pending contact stored under a differently-cased key is still found and
 * still cleared.
 *
 * A true no-op — no throw, no storage write — for a pubkey with no matching
 * stored contact, or whose `pendingConfirmationSince` is already `null`
 * (AC-CONFIRM-2). Otherwise, sets `pendingConfirmationSince` to `null` and
 * leaves every other field (`firstSeenAt`, `lastSeenAt`, `archivedAt`)
 * byte-for-byte unchanged (AC-CONFIRM-1).
 *
 * @param pubkeyHex - Hex pubkey of the contact to confirm (any case).
 */
export function confirmContact(pubkeyHex: string): void {
  if (!pubkeyHex) return;
  const contacts = readStoredContacts();
  const target = pubkeyHex.toLowerCase();
  // Gather ALL case-insensitive matches (not just the first) — legacy
  // storage can hold two entries for one pubkey differing only in case.
  // Clearing only an arbitrarily-chosen first match could leave the
  // actually-pending duplicate never confirmed. Mirrors addContactByNpub's
  // `matchingKeys` pattern above.
  const matchingKeys = Object.keys(contacts).filter((key) => key.toLowerCase() === target);
  if (matchingKeys.length === 0) return;
  let changed = false;
  for (const matchingKey of matchingKeys) {
    const existing = contacts[matchingKey];
    if (!existing.pendingConfirmationSince) continue;
    contacts[matchingKey] = {
      ...existing,
      pendingConfirmationSince: null,
    };
    changed = true;
  }
  if (!changed) return;
  writeStoredContacts(contacts);
}

/**
 * The single exported pending-confirmation predicate (AC-STRUCT-3). Every
 * call site that needs to know whether a contact is still awaiting
 * confirmation MUST import and call this function — never re-derive the
 * `pendingConfirmationSince != null` check inline. `listContacts` below
 * calls this same function (not a second inline check) to derive
 * {@link ContactListItem.isPendingConfirmation}, so there is exactly one
 * place in this module (and the codebase) that inspects the field.
 *
 * This predicate is a deliberate, documented exception to ADR-008's
 * "compose through the shared deny-layer composite" rule (spec.md Design
 * Decision 5): it MUST NOT call, or be folded into,
 * `isAllowedDmSenderComposite` / `isAllowedDmSender` / `isBlockedPeer`
 * (`blockedPeers.ts`). Blocking is a full storage/ingestion cut-off;
 * pending-confirmation is a visibility/notification gate layered on top of
 * an already-admitted, already-stored contact — the two cannot share one
 * predicate without gating message *persistence*, which this epic must not
 * do (spec.md §"Design Decisions" 4-5).
 *
 * Pure and synchronous. Reads only from `readStoredContacts()` when
 * `contacts` is omitted, or the supplied explicit array otherwise — never
 * any other store. Matches `pubkeyHex` case-insensitively against each
 * candidate's own `pubkeyHex` field.
 *
 * Checks ALL case-insensitive matches (not just the first) — legacy
 * storage can hold two entries for one pubkey differing only in case, and
 * only one of them may have `pendingConfirmationSince` set. Mirrors the
 * `matchingKeys` pattern in `confirmContact` and `rememberPendingContact`
 * above: any matching duplicate with the field set counts as pending.
 *
 * @param pubkeyHex - Hex pubkey to check (any case).
 * @param contacts  - Optional explicit contact list to check against,
 *                    instead of reading `readStoredContacts()` fresh
 *                    (callers that already hold a list, e.g. `listContacts`,
 *                    pass it directly to avoid a redundant storage read).
 * @returns `true` iff ANY case-insensitively matching stored contact has a
 *   non-null `pendingConfirmationSince`.
 */
export function isPendingConfirmation(pubkeyHex: string, contacts?: StoredContact[]): boolean {
  if (!pubkeyHex) return false;
  const list = contacts ?? Object.values(readStoredContacts());
  const target = pubkeyHex.toLowerCase();
  return list.some(
    (contact) => contact.pubkeyHex.toLowerCase() === target && Boolean(contact.pendingConfirmationSince),
  );
}

/**
 * Remembers every other member of `groups` in ONE write (one cross-tab
 * notification per call rather than one per member); no write at all when no
 * member's record changes.
 */
export function rememberContactsFromGroups(groups: Group[], ownPubkeyHex: string | null | undefined): void {
  const seenAt = new Date().toISOString();
  const contacts = readStoredContacts();
  let changed = false;
  for (const group of groups) {
    for (const memberPubkey of group.memberPubkeys) {
      if (!memberPubkey) continue;
      if (ownPubkeyHex && memberPubkey.toLowerCase() === ownPubkeyHex.toLowerCase()) continue;
      const next = seenContact(contacts[memberPubkey], memberPubkey, seenAt);
      if (!next) continue;
      contacts[memberPubkey] = next;
      changed = true;
    }
  }
  if (changed) writeStoredContacts(contacts);
}

export function archiveContact(pubkeyHex: string, archivedAt: string = new Date().toISOString()): void {
  if (!pubkeyHex) return;
  const contacts = readStoredContacts();
  const existing = contacts[pubkeyHex];
  if (!existing) return;
  contacts[pubkeyHex] = {
    ...existing,
    archivedAt,
  };
  if (writeStoredContacts(contacts)) postStoreChanged('blocked');
}

export function unarchiveContact(pubkeyHex: string): void {
  if (!pubkeyHex) return;
  const contacts = readStoredContacts();
  const existing = contacts[pubkeyHex];
  if (!existing) return;
  contacts[pubkeyHex] = {
    ...existing,
    archivedAt: null,
  };
  if (writeStoredContacts(contacts)) postStoreChanged('blocked');
}

export function listContacts(
  ownPubkeyHex: string | null | undefined,
  options?: { includeArchived?: boolean },
): ContactListItem[] {
  const stored = readStoredContacts();
  const storedList = Object.values(stored);
  const cache = readContactCacheSnapshot();
  const includeArchived = options?.includeArchived ?? false;

  return storedList
    .filter((contact) => {
      if (!ownPubkeyHex) return true;
      return contact.pubkeyHex.toLowerCase() !== ownPubkeyHex.toLowerCase();
    })
    .filter((contact) => includeArchived || !contact.archivedAt)
    .map((contact) => {
      const cached = cache[contact.pubkeyHex];
      return {
        ...contact,
        nickname: cached?.nickname ?? '',
        avatar: cached?.avatar ?? null,
        updatedAt: cached?.updatedAt ?? null,
        archivedAt: contact.archivedAt ?? null,
        isArchived: Boolean(contact.archivedAt),
        isPendingConfirmation: isPendingConfirmation(contact.pubkeyHex, storedList),
      };
    })
    .sort((a, b) => {
      if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
      const updatedA = a.updatedAt ?? a.lastSeenAt;
      const updatedB = b.updatedAt ?? b.lastSeenAt;
      if (updatedA !== updatedB) return updatedB.localeCompare(updatedA);
      return (a.nickname || a.pubkeyHex).localeCompare(b.nickname || b.pubkeyHex);
    });
}

export function getContact(
  pubkeyHex: string,
  ownPubkeyHex: string | null | undefined,
  options?: { includeArchived?: boolean },
): ContactListItem | null {
  return listContacts(ownPubkeyHex, options).find((contact) => contact.pubkeyHex === pubkeyHex) ?? null;
}

/**
 * Returns the groups shared by the current user and a given contact — i.e. the
 * groups whose `memberPubkeys` contains the contact's pubkey. Pubkey comparison
 * is case-insensitive, consistent with membership checks elsewhere
 * (MarmotContext.tsx).
 *
 * Pure: no storage access, no React. Callers pass the group list (typically
 * `useMarmot().groups`). The current user's own membership is implicit — the
 * groups array already only contains groups the user belongs to.
 *
 * @param groups        - Groups the current user belongs to.
 * @param contactPubkeyHex - Hex pubkey of the contact to test membership for.
 * @returns The subset of `groups` that also contain the contact, preserving
 *          input order. Empty array when none match or inputs are empty.
 */
export function commonGroups(groups: Group[], contactPubkeyHex: string): Group[] {
  if (!contactPubkeyHex) return [];
  const target = contactPubkeyHex.toLowerCase();
  return groups.filter((group) =>
    group.memberPubkeys.some((member) => member.toLowerCase() === target),
  );
}

/**
 * Returns the groups a contact can still be added to — groups the current user
 * belongs to where the contact is NOT already a member. Pubkey comparison is
 * case-insensitive. The complement of {@link commonGroups} over the same input.
 *
 * @param groups        - Groups the current user belongs to.
 * @param contactPubkeyHex - Hex pubkey of the contact to test membership for.
 * @returns The subset of `groups` that do NOT contain the contact, preserving
 *          input order. Empty array when all groups already contain them or
 *          inputs are empty.
 */
export function eligibleGroupsForContact(groups: Group[], contactPubkeyHex: string): Group[] {
  if (!contactPubkeyHex) return [];
  const target = contactPubkeyHex.toLowerCase();
  return groups.filter(
    (group) => !group.memberPubkeys.some((member) => member.toLowerCase() === target),
  );
}

/**
 * Returns the groups a contact can actually be added to: the {@link
 * eligibleGroupsForContact} subset further restricted to groups the current
 * user administers. `inviteByNpub` only succeeds for group admins (the MLS
 * `commit()` carries an admin check), so a non-admin group is never offered.
 *
 * Admin status is not part of the `Group` overlay — it lives in MLS state — so
 * the caller resolves it asynchronously and passes the resulting set of group
 * ids the current user is an admin of. Keeping that resolution outside this
 * function preserves its purity and testability.
 *
 * @param groups        - Groups the current user belongs to.
 * @param contactPubkeyHex - Hex pubkey of the contact to test membership for.
 * @param adminGroupIds - Ids of the groups the current user is an admin of.
 * @returns The eligible groups whose id is in `adminGroupIds`, preserving input
 *          order. Empty array when none qualify or inputs are empty.
 */
export function addableGroupsForContact(
  groups: Group[],
  contactPubkeyHex: string,
  adminGroupIds: ReadonlySet<string>,
): Group[] {
  return eligibleGroupsForContact(groups, contactPubkeyHex).filter((group) =>
    adminGroupIds.has(group.id),
  );
}

/**
 * One partition entry per input contact, returned by
 * {@link selectableContactsForGroup}. Cross-story seam contract consumed by
 * `InviteMemberModal.tsx` (epic: invite-group-member-from-contacts, S2) to
 * build the contact-invite `<Select>` picker's options.
 *
 * `disabledReason` is present if and only if `selectable` is `false`.
 */
export type ContactSelectabilityEntry = {
  contact: ContactListItem;
  selectable: boolean;
  disabledReason?: 'already_member' | 'blocked' | 'pending_confirmation';
};

/**
 * Partitions `contacts` into selectable / disabled-with-reason entries for a
 * given group's membership — the inverse of {@link eligibleGroupsForContact}
 * (which partitions groups for one contact; this partitions contacts for one
 * group). Pubkey comparison against `group.memberPubkeys` is case-insensitive,
 * consistent with {@link commonGroups}/{@link eligibleGroupsForContact} and
 * `listContacts` elsewhere in this module — stored contact keys and group
 * member keys are not case-normalised, so an exact-match `.includes()` would
 * wrongly treat an already-member contact as selectable.
 *
 * Precedence (epic: pending-contact-confirmation extends this to a third
 * tier — spec.md Design Decisions 6/9, AC-GROUP-1):
 * `'already_member'` > `'blocked'` > `'pending_confirmation'` > selectable.
 * A contact matching `group.memberPubkeys` is always
 * `{ selectable: false, disabledReason: 'already_member' }`, regardless of
 * `isArchived`/`isPendingConfirmation` — already-member wins over both. A
 * non-member contact with `isArchived === true` is `{ selectable: false,
 * disabledReason: 'blocked' }`, regardless of `isPendingConfirmation` —
 * blocking is a terminal decision that supersedes an undecided pending
 * state (spec.md Design Decision 9): a contact that is both pending AND
 * blocked resolves to `'blocked'`, never `'pending_confirmation'`. A
 * non-member, non-archived contact with `isPendingConfirmation === true` is
 * `{ selectable: false, disabledReason: 'pending_confirmation' }`. Every
 * other contact is `{ selectable: true }` — the `disabledReason` key is
 * omitted entirely, not set to `undefined`.
 *
 * Pure and synchronous: no storage or network access. Callers pass
 * `listContacts(ownPubkeyHex, { includeArchived: true })` output directly.
 *
 * @param contacts - Contacts to partition (typically the full
 *   `includeArchived: true` list, so blocked contacts are still shown,
 *   disabled).
 * @param group    - The group to check membership against.
 * @returns One {@link ContactSelectabilityEntry} per input contact,
 *   preserving `contacts`' order exactly (order-preservation, not just
 *   membership).
 */
export function selectableContactsForGroup(
  contacts: ContactListItem[],
  group: { memberPubkeys: string[] },
): ContactSelectabilityEntry[] {
  const memberPubkeys = new Set(group.memberPubkeys.map((pubkey) => pubkey.toLowerCase()));
  return contacts.map((contact) => {
    if (memberPubkeys.has(contact.pubkeyHex.toLowerCase())) {
      return { contact, selectable: false, disabledReason: 'already_member' };
    }
    if (contact.isArchived) {
      return { contact, selectable: false, disabledReason: 'blocked' };
    }
    if (contact.isPendingConfirmation) {
      return { contact, selectable: false, disabledReason: 'pending_confirmation' };
    }
    return { contact, selectable: true };
  });
}

export type AddContactResult =
  | { ok: true; pubkeyHex: string; reactivated: boolean }
  | {
      ok: false;
      error: 'invalid_npub' | 'self' | 'already_exists';
      /**
       * Present and `true` iff `error === 'already_exists'` because every
       * case-insensitively-matching stored entry is archived (blocked) —
       * epic: block-contact, DD-9. Distinguishes "you already have this
       * contact, archived/blocked" from the ordinary active-duplicate case
       * so a caller can surface "this contact is blocked" rather than a
       * generic already-exists message. Absent (or `false`) for the
       * ordinary active-duplicate `already_exists` case.
       */
      blocked?: boolean;
      /** Present iff `blocked` is `true` — the lowercase-hex pubkey of the blocked contact, so a caller need not re-decode the npub. */
      pubkeyHex?: string;
    };

/**
 * Adds a contact by npub, the entry point for "add contact by npub" (S1).
 *
 * Decodes `npub` to hex first — no storage read or write happens before that
 * check, so an invalid npub never touches storage. Self-addressing is
 * rejected next, comparing `ownPubkeyHex` case-insensitively (Nostr pubkeys
 * arrive in varying capitalisations from different clients), also before any
 * storage mutation.
 *
 * `npubToPubkeyHex` decodes any well-formed bech32 npub, including ones that
 * checksum-decode to a payload that is not a valid 32-byte pubkey (e.g. an
 * npub built from a 2-character payload). Its result is therefore validated
 * here as exactly 64 lowercase hex characters (`/^[0-9a-f]{64}$/`) before it
 * is treated as a pubkey — a decoded-but-malformed payload is rejected as
 * `invalid_npub` with no storage mutation, same as a decode failure.
 *
 * Contact lookup is **case-insensitive** against `readStoredContacts()`.
 * `npubToPubkeyHex` always returns lowercase hex, but stored keys are NOT
 * guaranteed to be lowercase: `rememberContact` and `rememberContactsFromGroups`
 * index by whatever case the caller (or a group's `memberPubkeys`) happens to
 * supply, un-normalized. An exact-key match would therefore miss an existing
 * entry stored under a mixed/upper-case key — silently creating a duplicate
 * and bypassing both the `already_exists` guard and the blocked-contact
 * guard below. The resolution gathers ALL case-insensitive matches (there
 * can be more than one, e.g. an active entry and a separately-stored
 * archived entry differing only in case) and operates on that set, consistent
 * with the case-insensitive comparisons used elsewhere in this module
 * (`commonGroups`, `eligibleGroupsForContact`, `listContacts`). If ANY match
 * is active, the request is rejected as `already_exists` even if another
 * matching entry is archived — an active entry always wins the guard check.
 *
 * An existing, non-archived contact is left completely untouched (not even
 * `lastSeenAt` is bumped) and reported as `already_exists`. An existing,
 * ARCHIVED (blocked) contact, with no active match, is likewise left
 * completely untouched — epic: block-contact, DD-9 — and reported as
 * `{ ok: false, error: 'already_exists', blocked: true, pubkeyHex }`. Prior
 * to this epic, re-adding an archived contact by npub silently called
 * `unarchiveContact`, clearing `archivedAt` and reopening the DM channel;
 * that silent-unblock hole is closed here. A blocked contact only becomes
 * unblocked through the explicit unblock action (`unarchiveContact`), never
 * as a side effect of a re-add attempt.
 *
 * @param npub          - Bech32 npub string supplied by the user.
 * @param ownPubkeyHex  - The local user's hex pubkey (any case, or
 *                        null/undefined). When falsy, the self-check is
 *                        skipped.
 * @returns `{ ok: true, pubkeyHex, reactivated: false }` for a brand-new
 *   entry (this function no longer ever reactivates, so `reactivated` is
 *   always `false` when present). `{ ok: false, error }` otherwise, where
 *   `error` identifies which guard rejected the request; `error:
 *   'already_exists'` additionally carries `blocked: true` and `pubkeyHex`
 *   when the rejection is specifically because the matching contact is
 *   archived/blocked.
 */
export function addContactByNpub(
  npub: string,
  ownPubkeyHex: string | null | undefined,
): AddContactResult {
  const decoded = npubToPubkeyHex(npub);
  if (decoded === null || !/^[0-9a-f]{64}$/.test(decoded.toLowerCase())) {
    return { ok: false, error: 'invalid_npub' };
  }
  const pubkeyHex = decoded.toLowerCase();

  if (ownPubkeyHex && pubkeyHex === ownPubkeyHex.toLowerCase()) {
    return { ok: false, error: 'self' };
  }

  const contacts = readStoredContacts();
  // Resolve ALL stored keys matching case-insensitively — pubkeyHex is
  // already lowercase (validated above), but the stored key(s) may not be,
  // and more than one case-variant entry can coexist.
  const matchingKeys = Object.keys(contacts).filter((key) => key.toLowerCase() === pubkeyHex);
  const hasActiveMatch = matchingKeys.some((key) => !contacts[key].archivedAt);

  if (hasActiveMatch) {
    return { ok: false, error: 'already_exists' };
  }

  if (matchingKeys.length > 0) {
    // All matches are archived — this peer is blocked (DD-9). Do NOT
    // reactivate: no unarchiveContact call, no rememberContact bump. Report
    // `blocked` so the caller can surface "this contact is blocked" instead
    // of silently restoring DM access.
    return { ok: false, error: 'already_exists', blocked: true, pubkeyHex };
  }

  rememberKnownPeers([pubkeyHex]);
  rememberContact(pubkeyHex);
  return { ok: true, pubkeyHex, reactivated: false };
}

/**
 * Purges stranger entries from both contact storage keys (AC-PURGE-5).
 *
 * Reads `STORAGE_KEYS.contacts` (lp_contacts_v1) and
 * `STORAGE_KEYS.contactCache` (lp_contactCache_v1), removes every entry
 * whose key is a stranger pubkey according to `isAllowedDmSender`, then
 * writes the cleaned objects back to localStorage.
 *
 * No-ops when localStorage is unavailable (SSR or restricted context).
 *
 * @returns `{ deleted: number }` — total number of contact entries deleted
 *   across both storage keys (AC-OBS-5).
 */
export function purgeStrangerContacts(
  getWhitelist: () => WhitelistArgs,
): { deleted: number } {
  if (!isStorageAvailable()) return { deleted: 0 };

  const { groups, knownPeers, ownPubkeyHex } = getWhitelist();
  let deleted = 0;

  // --- contacts store ---
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.contacts);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      let changed = false;
      for (const pubkey of Object.keys(parsed)) {
        if (!isAllowedDmSender(pubkey, groups, knownPeers, ownPubkeyHex)) {
          delete parsed[pubkey];
          changed = true;
          deleted++;
        }
      }
      if (changed) {
        localStorage.setItem(STORAGE_KEYS.contacts, JSON.stringify(parsed));
        postStoreChanged('contacts');
      }
    }
  } catch {
    // Non-fatal — storage may be full or corrupt
  }

  // --- contactCache store ---
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.contactCache);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      let changed = false;
      for (const pubkey of Object.keys(parsed)) {
        if (!isAllowedDmSender(pubkey, groups, knownPeers, ownPubkeyHex)) {
          delete parsed[pubkey];
          changed = true;
          deleted++;
        }
      }
      if (changed) {
        localStorage.setItem(STORAGE_KEYS.contactCache, JSON.stringify(parsed));
        postStoreChanged('contacts');
      }
    }
  } catch {
    // Non-fatal — storage may be full or corrupt
  }

  return { deleted };
}
