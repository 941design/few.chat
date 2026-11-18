import { ChakraProvider } from '@chakra-ui/react';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GroupsPage from '@/pages/groups';
import type { useMarmot } from '@/src/context/MarmotContext';
import { getCopy } from '@/src/lib/i18n';
import { pubkeyToNpub } from '@/src/lib/nostrKeys';
import type { OutboundJoinRequestRecord } from '@/src/lib/marmot/outboundJoinRequests';

type Marmot = ReturnType<typeof useMarmot>;

const copy = getCopy('en');
const own = 'a'.repeat(64);
const admin = 'b'.repeat(64);
const invitation: Marmot['pendingInvitations'][number] = {
  id: 'welcome',
  groupId: 'garden',
  displayName: 'Garden club',
  sponsorAccount: admin,
  sponsors: [admin],
  keyPackageRef: 'key-package',
  receivedAt: 1,
};
const joinQuery = { join: 'nonce', admin: pubkeyToNpub(admin), name: 'Garden club' };
const replace = vi.fn();

let marmot: Partial<Marmot>;
let query: Record<string, string>;
let isFreshIdentity: boolean;
let outboundRecords: OutboundJoinRequestRecord[];

vi.mock('next/router', () => ({ useRouter: () => ({ query, replace }) }));
vi.mock('@/src/context/LanguageContext', () => ({ useCopy: () => copy }));
vi.mock('@/src/context/MarmotContext', () => ({ useMarmot: () => marmot }));
vi.mock('@/src/context/NostrIdentityContext', () => ({
  useNostrIdentity: () => ({ hydrated: true, backedUp: true, pubkeyHex: own, isFreshIdentity }),
}));
vi.mock('@/src/context/ProfileContext', () => ({
  useProfile: () => ({ profile: { nickname: 'Alice', avatar: null } }),
}));
vi.mock('@/src/components/HeroAccents', () => ({ default: () => null }));
vi.mock('@/src/hooks/useOutboundJoinRequests', () => ({
  useOutboundJoinRequests: () => ({ records: outboundRecords, loaded: true }),
}));

function renderPage() {
  return renderToStaticMarkup(createElement(ChakraProvider, null, createElement(GroupsPage)));
}

function button(html: string, testId: string) {
  const match = html.match(/<button[^>]*>/g)?.find((tag) => tag.includes(`data-testid="${testId}"`));
  expect(match).toBeDefined();
  return match;
}

beforeEach(() => {
  // Next supplies the JSX runtime for components that omit a React import.
  // The unit runner uses the classic JSX transform.
  vi.stubGlobal('React', React);
  query = {};
  isFreshIdentity = false;
  outboundRecords = [];
  marmot = { groups: [], pendingInvitations: [], ready: false, waitingForLease: true, unavailableReason: null };
});

afterEach(() => vi.unstubAllGlobals());

describe('groups while waiting for the lease', () => {
  it('shows the lease message and the overlay group name on a detail route', () => {
    query = { id: 'garden', manageLinks: '1' };
    marmot.groups = [{ id: 'garden', name: 'Garden club', createdAt: 1, relays: [], memberPubkeys: [own] }];
    const html = renderPage();
    expect(html).toContain('data-testid="groups-lease-held"');
    expect(html).toContain('Garden club');
    expect(html).not.toContain('group-detail-loading');
    expect(html).not.toContain('group-detail-not-found');
  });

  it('shows a lease message on the preview route before invitation data is available', () => {
    query = { invite: invitation.id };
    const html = renderPage();
    expect(html).toContain('data-testid="invitation-preview"');
    expect(html).toContain('data-testid="groups-lease-held"');
    expect(html).toContain(copy.groups.backToGroups);
    expect(html).not.toContain('invitation-preview-accept');
  });

  it('keeps preview details visible and enables responses after readiness', () => {
    query = { invite: invitation.id };
    marmot.pendingInvitations = [invitation];
    const waiting = renderPage();
    expect(waiting).toContain(invitation.displayName);
    expect(waiting).toContain('invitation-preview-invited-by');
    expect(button(waiting, 'invitation-preview-accept')).toContain('disabled=""');
    expect(button(waiting, 'invitation-preview-decline')).toContain('disabled=""');

    Object.assign(marmot, { ready: true, waitingForLease: false });
    const ready = renderPage();
    expect(ready).not.toContain('groups-lease-held');
    expect(button(ready, 'invitation-preview-accept')).not.toContain('disabled');
    expect(button(ready, 'invitation-preview-decline')).not.toContain('disabled');
  });

  it.each([
    { firstVisit: true, action: 'welcome-primary-action' },
    { firstVisit: false, action: 'invite-awaiting-request-btn' },
  ])('keeps the invite visible with its request action gated (first visit $firstVisit)', ({ firstVisit, action }) => {
    query = joinQuery;
    isFreshIdentity = firstVisit;
    const waiting = renderPage();
    expect(waiting).toContain('groups-lease-held');
    expect(waiting).toContain('Garden club');
    expect(waiting).not.toContain(copy.identity.notReady);
    expect(button(waiting, action)).toContain('disabled=""');

    marmot.waitingForLease = false;
    const starting = renderPage();
    expect(starting).toContain('Garden club');
    expect(button(starting, action)).toContain('disabled=""');

    marmot.ready = true;
    expect(button(renderPage(), action)).not.toContain('disabled');
  });

  it('shows a returning user their existing outbound request while waiting', () => {
    query = joinQuery;
    outboundRecords = [{
      nonce: joinQuery.join,
      accountPubkey: own,
      adminPubkeyHex: admin,
      groupName: joinQuery.name,
      sentAt: Date.now(),
    }];
    const html = renderPage();
    expect(html).toContain(copy.groups.awaitingApprovalBanner(joinQuery.name));
    expect(html).not.toContain('invite-awaiting-request-btn');
  });
});

describe('group startup status', () => {
  it.each([
    { route: 'list', params: {} },
    { route: 'detail', params: { id: 'garden' } },
    { route: 'preview', params: { invite: invitation.id } },
  ])('shows a retry message in place of loading on the $route route', ({ params }) => {
    query = params as Record<string, string>;
    Object.assign(marmot, { waitingForLease: false, unavailableReason: 'signer-timeout' });
    const html = renderPage();
    expect(html).toContain(copy.groups.startupRetrying);
    expect(html).not.toContain(copy.groups.loading);
    expect(html).not.toContain('groups-https-required');
  });

  it.each([
    ['insecure-context', copy.groups.httpsRequiredBody, 'groups-https-required'],
    ['nip44', copy.groups.unsupportedNip44, 'groups-unavailable'],
    ['storage', copy.groups.storageUnavailable, 'groups-unavailable'],
    ['store-incompatible', copy.groups.storageUnavailable, 'groups-unavailable'],
    ['startup', copy.groups.startupUnavailable, 'groups-unavailable'],
  ] as const)('shows the correct terminal message for %s', (unavailableReason, description, testId) => {
    Object.assign(marmot, { waitingForLease: false, unsupported: true, unavailableReason });
    const html = renderPage();
    expect(html).toContain(description);
    expect(html).toContain(`data-testid="${testId}"`);
    expect(html).not.toContain(copy.groups.loading);
  });
});
