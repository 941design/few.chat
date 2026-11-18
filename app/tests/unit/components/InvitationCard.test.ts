/**
 * InvitationCard.test.ts — source-scan + pure-helper unit tests for the S2
 * inline invitation card (epic: inline-invitation-cards, S2).
 *
 * This repo has NO jsdom / @testing-library / component-render capability
 * (vitest only) — mirrors OutboundJoinRequestCard.test.ts's precedent of
 * reading the built `.tsx` source as a string and asserting against it with
 * regexes. The extracted pure helper (`selectInvitationDisplayName`) is
 * exercised with a real import instead.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { selectCardViewModel, selectInvitationDisplayName } from '@/src/components/groups/InvitationCard';

const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(TEST_FILE_DIR, '..', '..', '..'); // app/tests/unit/components -> app/

const CARD_SOURCE = fs.readFileSync(
  path.join(APP_ROOT, 'src', 'components', 'groups', 'InvitationCard.tsx'),
  'utf8',
);

// Comment-stripped view for negative "does not reference X" assertions: doc
// comments legitimately NAME the forbidden symbols they explain the absence
// of, so a whole-file regex would false-positive on the explanation.
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/([^:])\/\/.*$/gm, '$1');
const CARD_CODE = stripComments(CARD_SOURCE);

const GROUPS_PAGE_SOURCE = fs.readFileSync(path.join(APP_ROOT, 'pages', 'groups.tsx'), 'utf8');
const GROUPS_PAGE_CODE = stripComments(GROUPS_PAGE_SOURCE);

// ── Accept/Decline call real MarmotContext methods ─────────────────────────

describe('InvitationCard.tsx — accept/decline wiring', () => {
  it('calls acceptPendingInvitation(invitation.id)', () => {
    expect(CARD_SOURCE).toMatch(/acceptPendingInvitation\(invitation\.id\)/);
  });

  it('calls declinePendingInvitation(invitation.id)', () => {
    expect(CARD_SOURCE).toMatch(/declinePendingInvitation\(invitation\.id\)/);
  });
});

// ── Delegates to S1 helpers rather than re-implementing them ────────────────

describe('InvitationCard.tsx — delegates to S1 seams', () => {
  it('uses the invitation view display name supplied by the session (D8)', () => {
    expect(CARD_CODE).toMatch(/model\?\.displayName \?\? invitation\.displayName/);
  });

  it('calls resolveInviterLabel(', () => {
    expect(CARD_SOURCE).toMatch(/resolveInviterLabel\(/);
  });

  it('does not re-implement pubkey truncation inline (no raw .slice(0, 8) pattern)', () => {
    expect(CARD_CODE).not.toMatch(/\.slice\(0,\s*8\)/);
  });
});

// ── Badge sourcing ───────────────────────────────────────────────────────────

describe('InvitationCard.tsx — badge accent', () => {
  it('references BADGE_ACCENT.invitation', () => {
    expect(CARD_SOURCE).toMatch(/BADGE_ACCENT\.invitation/);
  });
});

// ── Testids (load-bearing template literals) ────────────────────────────────

describe('InvitationCard.tsx — testids', () => {
  it('contains the invitation-card-${invitation.id} testid', () => {
    expect(CARD_SOURCE).toMatch(/`invitation-card-\$\{invitation\.id\}`/);
  });

  it('contains the accept-invitation-${invitation.id} testid', () => {
    expect(CARD_SOURCE).toMatch(/`accept-invitation-\$\{invitation\.id\}`/);
  });

  it('contains the decline-invitation-${invitation.id} testid', () => {
    expect(CARD_SOURCE).toMatch(/`decline-invitation-\$\{invitation\.id\}`/);
  });

  it('contains the legacy pending-invitation-row-${invitation.id} testid', () => {
    expect(CARD_SOURCE).toMatch(/`pending-invitation-row-\$\{invitation\.id\}`/);
  });
});

// ── Preview link ─────────────────────────────────────────────────────────────

describe('InvitationCard.tsx — preview link', () => {
  it('links to /groups?invite=${invitation.id}', () => {
    expect(CARD_SOURCE).toMatch(/`\/groups\?invite=\$\{invitation\.id\}`/);
  });
});

// ── Privacy / architecture negative checks ──────────────────────────────────

describe('InvitationCard.tsx — no direct relay/client access', () => {
  it('does not import welcomeSubscription', () => {
    expect(CARD_CODE).not.toMatch(/welcomeSubscription/);
  });

  it('does not construct a MarmotClient', () => {
    expect(CARD_CODE).not.toMatch(/new MarmotClient/);
  });
});

// ── AC-CARD-6 — decline has no confirmation step ────────────────────────────

describe('InvitationCard.tsx — decline has no confirmation (AC-CARD-6)', () => {
  it('does not contain window.confirm anywhere', () => {
    expect(CARD_SOURCE).not.toMatch(/window\.confirm/);
  });
});

// ── groups.tsx wiring ────────────────────────────────────────────────────────

describe('groups.tsx — InvitationCard wiring', () => {
  it('no longer imports from @/src/components/groups/PendingInvitations', () => {
    expect(GROUPS_PAGE_SOURCE).not.toMatch(
      /@\/src\/components\/groups\/PendingInvitations/,
    );
  });

  it('no longer renders <PendingInvitations', () => {
    expect(GROUPS_PAGE_SOURCE).not.toMatch(/<PendingInvitations/);
  });

  it('contains data-testid="pending-invitations-section"', () => {
    expect(GROUPS_PAGE_SOURCE).toMatch(/data-testid="pending-invitations-section"/);
  });

  it('contains the invitations.length === 0 empty-state fix', () => {
    expect(GROUPS_PAGE_CODE).toMatch(/invitations\.length === 0/);
  });

  it('renders invitation cards BEFORE joined-group cards inside the list block (AC-CARD-2, pinned at top)', () => {
    const listBlockStart = GROUPS_PAGE_SOURCE.indexOf('data-testid="groups-list"');
    expect(listBlockStart).toBeGreaterThan(-1);
    const listBlockSource = GROUPS_PAGE_SOURCE.slice(listBlockStart);
    const invitationsSectionIdx = listBlockSource.indexOf('pending-invitations-section');
    const groupsMapIdx = listBlockSource.indexOf('groups.map((group) => (');
    expect(invitationsSectionIdx).toBeGreaterThan(-1);
    expect(groupsMapIdx).toBeGreaterThan(-1);
    expect(invitationsSectionIdx).toBeLessThan(groupsMapIdx);
  });
});

// ── selectInvitationDisplayName — pure helper ───────────────────────────────

describe('selectInvitationDisplayName', () => {
  const fallback = 'Group invitation';

  it('returns groupData.name when non-null and non-empty', () => {
    expect(selectInvitationDisplayName({ name: 'Book Club' }, fallback)).toBe('Book Club');
  });

  it('returns the fallback when groupData is null', () => {
    expect(selectInvitationDisplayName(null, fallback)).toBe(fallback);
  });

  it('returns the fallback when groupData.name is an empty string (undecodable, AC-DATA-2)', () => {
    expect(selectInvitationDisplayName({ name: '' }, fallback)).toBe(fallback);
  });
});

describe('selectCardViewModel: the library view model is used only for its own invitation', () => {
  const model = { invitationId: 'inv-1', displayName: 'Chess club', nameSource: 'context' as const, sponsorAccount: 'a'.repeat(64) };

  it('returns the model when it was built for this invitation', () => {
    expect(selectCardViewModel('inv-1', model)).toBe(model);
  });
  it('ignores a model of another invitation (mismatched list index): the card falls back to the legacy path', () => {
    expect(selectCardViewModel('inv-2', model)).toBeUndefined();
  });
  it('no model: undefined', () => {
    expect(selectCardViewModel('inv-1', undefined)).toBeUndefined();
  });
  it('uses only the matched model when selecting a display name (D8)', () => {
    expect(CARD_CODE).toMatch(/const model = selectCardViewModel\(invitation\.id, viewModel\)/);
    expect(CARD_CODE).toMatch(/model\?\.displayName \?\? invitation\.displayName/);
  });
});
