/**
 * Unit tests for S2 (epic: invite-group-member-from-contacts) — group
 * invite-by-picker.
 *
 * Drives the REAL production down-conversion + invite orchestration exported
 * from InviteMemberModal.tsx (resolveInviteTarget, submitInvite — this
 * story's pure/async core, extracted per this repo's hooks-via-pure-
 * function-extraction convention, matching S4/S5's processContactInput /
 * card-invite idiom).
 *
 * Reshape note (DD-11, AC-STRUCT-2): prior to this story these two functions
 * accepted arbitrary free-text/card/link input and routed it through
 * parseContactCard (app/src/lib/contactCard.ts) — the app's single npub/card
 * decode seam (DD-1 of epic-contact-card-exchange). The invite-modal picker
 * now supplies a pubkey directly (sourced from a stored ContactListItem via
 * S1's selectableContactsForGroup predicate), so resolveInviteTarget's job
 * narrows to re-encoding that pubkeyHex to canonical npub form — it no
 * longer parses free text, cards, links, or scanner payloads, and this file
 * no longer exercises that surface (card/QR/tampered-signature tests removed
 * per AC-STRUCT-2 — that coverage lives at parseContactCard's own call sites,
 * unaffected by this epic).
 *
 * Mocking: idb-keyval is Map-backed (not spied) and ndkClient is stubbed for
 * the same transitive-import reason as addContactCardWiring.test.ts —
 * InviteMemberModal.tsx imports useMarmot from MarmotContext, whose
 * transitive dependency groupStorage.ts calls idb-keyval's createStore() at
 * module load time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    idbStore.delete(key);
  }),
  delMany: vi.fn(async (ks: string[]) => {
    ks.forEach((k) => idbStore.delete(k));
  }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  createStore: vi.fn(() => ({})),
}));

vi.mock('@/src/lib/ndkClient', () => ({
  getNdk: vi.fn(),
  connectNdk: vi.fn(),
}));

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    Object.keys(store).forEach((k) => delete store[k]);
  },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ── Module imports (after mocks are set up) ────────────────────────────────

const { readStoredContacts } = await import('@/src/lib/contacts');
const { readContactEntry } = await import('@/src/lib/contactCache');
const { loadKnownPeers } = await import('@/src/lib/knownPeers');
const { pubkeyToNpub } = await import('@/src/lib/nostrKeys');
// S2: pure/async core extracted from InviteMemberModal.tsx (this repo's
// convention — see AddContactModal.tsx / dmMessageEdits.test.ts precedent).
// Importing the component module does not mount React or touch the DOM.
// computeSelectionState/getErrorMessage: extraction added during the
// epic-invite-contact-picker-redesign S1 mutation gate (2026-07-14) — these
// were inline closures inside the component (100% NoCoverage under Stryker,
// 0 unit tests) with no behavior change; see their docstrings in
// InviteMemberModal.tsx.
// getInviteReasonText: gate-remediation extraction (Codex P3, 2026-07-15,
// epic: pending-contact-confirmation) — same rationale as
// computeSelectionState/getErrorMessage above; previously an inline ternary
// that silently fell through to `null` (no explanation shown) for the
// `'pending_confirmation'` disabledReason this epic added.
const {
  resolveInviteTarget,
  submitInvite,
  submitInviteWithMarker,
  computeSelectionState,
  getErrorMessage,
  getInviteReasonText,
} = await import('@/src/components/groups/InviteMemberModal');

function makePubkeyHex(): string {
  const sk = generateSecretKey();
  return getPublicKey(sk);
}

beforeEach(() => {
  localStorageMock.clear();
  idbStore.clear();
});

const GROUP_ID = 'group-under-test';

// ── resolveInviteTarget — pubkeyHex-in, npub-out ────────────────────────────

describe('resolveInviteTarget — converts a stored contact pubkeyHex to its canonical npub', () => {
  it('resolves a valid 64-char hex pubkey to pubkeyToNpub(pubkeyHex)', () => {
    const pubkeyHex = makePubkeyHex();
    expect(resolveInviteTarget(pubkeyHex)).toEqual({ ok: true, npub: pubkeyToNpub(pubkeyHex) });
  });

  it('resolves an uppercase-hex pubkey identically to its lowercase form', () => {
    const pubkeyHex = makePubkeyHex();
    expect(resolveInviteTarget(pubkeyHex.toUpperCase())).toEqual(resolveInviteTarget(pubkeyHex));
  });

  it('rejects an empty string as invalid_npub, without throwing', () => {
    expect(resolveInviteTarget('')).toEqual({ ok: false, error: 'invalid_npub' });
  });

  it('rejects a malformed/short pubkeyHex as invalid_npub, without throwing', () => {
    expect(resolveInviteTarget('not-a-pubkey')).toEqual({ ok: false, error: 'invalid_npub' });
    expect(resolveInviteTarget('a'.repeat(63))).toEqual({ ok: false, error: 'invalid_npub' });
  });

  /**
   * The validation must match the FULL 64-hex string, not merely contain a
   * 64-hex substring — a longer string with valid-hex padding on either
   * side must still be rejected. No AC pins this exact-match/anchoring
   * contract (filed as a spec-gap finding); worth asserting anyway since
   * this is identity-shaped input validation.
   */
  it('rejects a 64-hex substring padded with extra leading or trailing characters', () => {
    const validHex = 'a'.repeat(64);
    expect(resolveInviteTarget(`${validHex}x`)).toEqual({ ok: false, error: 'invalid_npub' });
    expect(resolveInviteTarget(`x${validHex}`)).toEqual({ ok: false, error: 'invalid_npub' });
  });
});

// ── submitInvite — happy path, zero contactCache/contacts/knownPeers writes ─

describe('submitInvite — invites the resolved npub for a valid pubkeyHex, zero contactCache/contacts/knownPeers writes', () => {
  it('invites the derived npub and leaves the cache/contacts/knownPeers untouched for the invitee', async () => {
    const pubkeyHex = makePubkeyHex();
    const expectedNpub = pubkeyToNpub(pubkeyHex);

    const inviteByNpub = vi.fn(async (groupId: string, npub: string) => {
      expect(groupId).toBe(GROUP_ID);
      expect(npub).toBe(expectedNpub);
      return { ok: true };
    });

    const result = await submitInvite(pubkeyHex, GROUP_ID, inviteByNpub);

    expect(result).toEqual({ ok: true });
    expect(inviteByNpub).toHaveBeenCalledTimes(1);
    expect(inviteByNpub).toHaveBeenCalledWith(GROUP_ID, expectedNpub);
    expect(readContactEntry(pubkeyHex)).toBeUndefined();
    expect(readStoredContacts()[pubkeyHex]).toBeUndefined();
    expect(loadKnownPeers().has(pubkeyHex)).toBe(false);
  });
});

// ── invalid pubkeyHex — hard failure, never a silent downgrade ─────────────

describe('submitInvite — an invalid pubkeyHex is rejected before inviteByNpub is ever called', () => {
  it('returns invalid_npub and never invokes inviteByNpub for garbage input', async () => {
    const inviteByNpub = vi.fn(async () => ({ ok: true }));
    await expect(submitInvite('not-a-pubkey', GROUP_ID, inviteByNpub)).resolves.toEqual({
      ok: false,
      error: 'invalid_npub',
    });
    expect(inviteByNpub).not.toHaveBeenCalled();
  });

  it('returns invalid_npub and never invokes inviteByNpub for an empty pubkeyHex', async () => {
    const inviteByNpub = vi.fn(async () => ({ ok: true }));
    await expect(submitInvite('', GROUP_ID, inviteByNpub)).resolves.toEqual({
      ok: false,
      error: 'invalid_npub',
    });
    expect(inviteByNpub).not.toHaveBeenCalled();
  });
});

// ── inviteByNpub failure results are forwarded verbatim ────────────────────

describe('submitInvite — forwards inviteByNpub failure results verbatim (AC-UX-5 mapping surface)', () => {
  it.each([
    ['no_key_package', { ok: false, error: 'no_key_package' }],
    ['offline', { ok: false, error: 'offline' }],
    ['timeout', { ok: false, error: 'timeout' }],
  ] as const)('forwards a %s failure unchanged', async (_label, expected) => {
    const pubkeyHex = makePubkeyHex();
    const inviteByNpub = vi.fn(async () => expected);
    await expect(submitInvite(pubkeyHex, GROUP_ID, inviteByNpub)).resolves.toEqual(expected);
  });
});

// ── submitInviteWithMarker — pending-direct-invite marker bookkeeping ──────
// (epic: invite-rescind-and-member-removal S7. markPendingDirectInvite /
// clearPendingDirectInvite are injected as markerDeps — vi.fn() spies, NOT
// the real pendingDirectInviteStorage.ts store, precisely so this test does
// not need real IDB.)

describe('submitInviteWithMarker — pending-direct-invite marker bookkeeping around submitInvite', () => {
  it('AC-MARKER-1: awaits markPendingDirectInvite(GROUP_ID, lowercasePubkey) to completion before inviteByNpub runs, and does not clear on success', async () => {
    const pubkeyHex = makePubkeyHex();
    const expectedNpub = pubkeyToNpub(pubkeyHex);
    const callOrder: string[] = [];

    const markPendingDirectInvite = vi.fn(async (gId: string, pubkey: string) => {
      expect(gId).toBe(GROUP_ID);
      expect(pubkey).toBe(pubkeyHex);
      callOrder.push('mark');
    });
    const clearPendingDirectInvite = vi.fn(async () => {
      callOrder.push('clear');
    });

    const inviteByNpub = vi.fn(async (gId: string, npub: string) => {
      // Assert the marker write already settled before inviteByNpub runs —
      // call ORDER, not just "both got called".
      expect(callOrder).toEqual(['mark']);
      expect(gId).toBe(GROUP_ID);
      expect(npub).toBe(expectedNpub);
      callOrder.push('invite');
      return { ok: true };
    });

    const result = await submitInviteWithMarker(pubkeyHex, GROUP_ID, inviteByNpub, {
      markPendingDirectInvite,
      clearPendingDirectInvite,
    });

    expect(result).toEqual({ ok: true });
    expect(markPendingDirectInvite).toHaveBeenCalledTimes(1);
    expect(markPendingDirectInvite).toHaveBeenCalledWith(GROUP_ID, pubkeyHex);
    expect(callOrder).toEqual(['mark', 'invite']);
    expect(clearPendingDirectInvite).not.toHaveBeenCalled();
  });

  it('AC-MARKER-2: a throwing markPendingDirectInvite is caught, logged, and does not block inviteByNpub', async () => {
    const pubkeyHex = makePubkeyHex();
    const expectedNpub = pubkeyToNpub(pubkeyHex);
    const markerError = new Error('idb quota exceeded');

    const markPendingDirectInvite = vi.fn(async () => {
      throw markerError;
    });
    const clearPendingDirectInvite = vi.fn(async () => {});
    const inviteByNpub = vi.fn(async () => ({ ok: true }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await submitInviteWithMarker(pubkeyHex, GROUP_ID, inviteByNpub, {
      markPendingDirectInvite,
      clearPendingDirectInvite,
    });

    expect(inviteByNpub).toHaveBeenCalledTimes(1);
    expect(inviteByNpub).toHaveBeenCalledWith(GROUP_ID, expectedNpub);
    expect(result).toEqual({ ok: true });
    expect(warnSpy).toHaveBeenCalled();
    const loggedWithContext = warnSpy.mock.calls.some(
      (call) => String(call[0]).includes('InviteMemberModal') && call.includes(markerError),
    );
    expect(loggedWithContext).toBe(true);

    warnSpy.mockRestore();
  });

  it('AC-MARKER-3: clears the marker (same groupId/canonicalPubkey as the write) before returning, on an inviteByNpub failure', async () => {
    const pubkeyHex = makePubkeyHex();
    const callOrder: string[] = [];

    const markPendingDirectInvite = vi.fn(async () => {
      callOrder.push('mark');
    });
    const clearPendingDirectInvite = vi.fn(async (gId: string, pubkey: string) => {
      expect(gId).toBe(GROUP_ID);
      expect(pubkey).toBe(pubkeyHex);
      // Resolve after a microtask so a caller that didn't truly await this
      // promise would observe the wrong order.
      await Promise.resolve();
      callOrder.push('clear');
    });
    const inviteByNpub = vi.fn(async () => {
      callOrder.push('invite');
      return { ok: false, error: 'timeout' };
    });

    const result = await submitInviteWithMarker(pubkeyHex, GROUP_ID, inviteByNpub, {
      markPendingDirectInvite,
      clearPendingDirectInvite,
    });

    expect(clearPendingDirectInvite).toHaveBeenCalledTimes(1);
    expect(clearPendingDirectInvite).toHaveBeenCalledWith(GROUP_ID, pubkeyHex);
    expect(callOrder).toEqual(['mark', 'invite', 'clear']);
    expect(result).toEqual({ ok: false, error: 'timeout' });
  });

  it('AC-MARKER-1 casing: an uppercase-hex pubkeyHex is marked under its lowercase form', async () => {
    const pubkeyHex = makePubkeyHex().toUpperCase();
    const canonicalPubkey = pubkeyHex.toLowerCase();

    const markPendingDirectInvite = vi.fn(async () => {});
    const clearPendingDirectInvite = vi.fn(async () => {});
    const inviteByNpub = vi.fn(async () => ({ ok: true }));

    await submitInviteWithMarker(pubkeyHex, GROUP_ID, inviteByNpub, {
      markPendingDirectInvite,
      clearPendingDirectInvite,
    });

    expect(markPendingDirectInvite).toHaveBeenCalledWith(GROUP_ID, canonicalPubkey);
    expect(markPendingDirectInvite).not.toHaveBeenCalledWith(GROUP_ID, pubkeyHex);
  });

  it('regression guard: a successful inviteByNpub result never triggers a marker clear', async () => {
    const pubkeyHex = makePubkeyHex();
    const markPendingDirectInvite = vi.fn(async () => {});
    const clearPendingDirectInvite = vi.fn(async () => {});
    const inviteByNpub = vi.fn(async () => ({ ok: true }));

    const result = await submitInviteWithMarker(pubkeyHex, GROUP_ID, inviteByNpub, {
      markPendingDirectInvite,
      clearPendingDirectInvite,
    });

    expect(result).toEqual({ ok: true });
    expect(clearPendingDirectInvite).not.toHaveBeenCalled();
  });

  it('clears the marker for an invalid pubkeyHex too, even though inviteByNpub never runs (submitInvite\'s own early rejection)', async () => {
    const markPendingDirectInvite = vi.fn(async () => {});
    const clearPendingDirectInvite = vi.fn(async () => {});
    const inviteByNpub = vi.fn(async () => ({ ok: true }));

    const result = await submitInviteWithMarker('not-a-pubkey', GROUP_ID, inviteByNpub, {
      markPendingDirectInvite,
      clearPendingDirectInvite,
    });

    expect(markPendingDirectInvite).toHaveBeenCalledTimes(1);
    expect(markPendingDirectInvite).toHaveBeenCalledWith(GROUP_ID, 'not-a-pubkey');
    expect(inviteByNpub).not.toHaveBeenCalled();
    expect(clearPendingDirectInvite).toHaveBeenCalledTimes(1);
    expect(clearPendingDirectInvite).toHaveBeenCalledWith(GROUP_ID, 'not-a-pubkey');
    expect(result).toEqual({ ok: false, error: 'invalid_npub' });
  });
});

// ── computeSelectionState — hasSelectable / isSelectionValid predicates ────
// (mutation-gate extraction, epic-invite-contact-picker-redesign S1)

describe('computeSelectionState — derives picker enablement from entries + the current selection', () => {
  const selectableEntry = (pubkeyHex: string) => ({ selectable: true, contact: { pubkeyHex } });
  const disabledEntry = (pubkeyHex: string) => ({ selectable: false, contact: { pubkeyHex } });

  it('reports neither selectable nor valid for an empty entries list', () => {
    expect(computeSelectionState([], '')).toEqual({ hasSelectable: false, isSelectionValid: false });
  });

  it('reports hasSelectable true but isSelectionValid false when nothing is selected yet', () => {
    const entries = [selectableEntry('a'.repeat(64))];
    expect(computeSelectionState(entries, '')).toEqual({ hasSelectable: true, isSelectionValid: false });
  });

  it('reports hasSelectable false when every entry is disabled, even if one matches selectedPubkeyHex', () => {
    const target = 'b'.repeat(64);
    const entries = [disabledEntry(target)];
    // The selection can never be valid if the matching row isn't selectable —
    // this pins the `entry.selectable &&` half of the AND, not just the
    // pubkeyHex equality (a stale selection on a now-disabled row, e.g. the
    // invitee just got blocked mid-picker, must not read as valid).
    expect(computeSelectionState(entries, target)).toEqual({ hasSelectable: false, isSelectionValid: false });
  });

  it('reports both true when selectedPubkeyHex matches a selectable entry', () => {
    const target = 'c'.repeat(64);
    const entries = [disabledEntry('d'.repeat(64)), selectableEntry(target)];
    expect(computeSelectionState(entries, target)).toEqual({ hasSelectable: true, isSelectionValid: true });
  });

  it('reports isSelectionValid false when selectedPubkeyHex does not match any entry', () => {
    const entries = [selectableEntry('e'.repeat(64))];
    expect(computeSelectionState(entries, 'f'.repeat(64))).toEqual({
      hasSelectable: true,
      isSelectionValid: false,
    });
  });
});

// ── getErrorMessage — error-code -> copy mapping, one branch per code ──────
// (mutation-gate extraction, epic-invite-contact-picker-redesign S1)

describe('getErrorMessage — maps each known error code to its own copy key, unknown/undefined to generic', () => {
  const copy = {
    inviteErrorInvalidNpub: 'invalid-npub-copy',
    inviteErrorNoKeyPackage: 'no-key-package-copy',
    inviteErrorOffline: 'offline-copy',
    inviteErrorTimeout: 'timeout-copy',
    inviteErrorGeneric: 'generic-copy',
  };

  it.each([
    ['invalid_npub', copy.inviteErrorInvalidNpub],
    ['no_key_package', copy.inviteErrorNoKeyPackage],
    ['offline', copy.inviteErrorOffline],
    ['timeout', copy.inviteErrorTimeout],
  ] as const)('maps %s to its own distinct copy string', (code, expected) => {
    expect(getErrorMessage(code, copy)).toBe(expected);
  });

  it('falls back to the generic copy for an unrecognized error code', () => {
    expect(getErrorMessage('some_future_error_code', copy)).toBe(copy.inviteErrorGeneric);
  });

  it('falls back to the generic copy for undefined (e.g. a thrown, code-less error)', () => {
    expect(getErrorMessage(undefined, copy)).toBe(copy.inviteErrorGeneric);
  });
});

describe('getInviteReasonText — maps each disabledReason to its own copy key, including pending_confirmation (Codex P3, gate-remediation 2026-07-15)', () => {
  const copy = {
    inviteReasonAlreadyMember: 'already-member-copy',
    inviteReasonBlocked: 'blocked-copy',
    inviteReasonPendingConfirmation: 'pending-confirmation-copy',
    inviteReasonInvitePending: 'invite-pending-copy',
  };

  it.each([
    ['already_member', copy.inviteReasonAlreadyMember],
    ['blocked', copy.inviteReasonBlocked],
    ['pending_confirmation', copy.inviteReasonPendingConfirmation],
    ['invite_pending', copy.inviteReasonInvitePending],
  ] as const)('maps %s to its own distinct copy string', (reason, expected) => {
    expect(getInviteReasonText(reason, copy)).toBe(expected);
  });

  it('returns null for undefined (a selectable row has no disabledReason)', () => {
    expect(getInviteReasonText(undefined, copy)).toBeNull();
  });
});
