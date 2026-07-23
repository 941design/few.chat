/**
 * Unit tests for authenticatedSenderResolver.ts
 *
 * Gate-remediation for VQ-S1-010 (group-message-author-auth-app-layer S1):
 * proves the window.__fewTest override lookup is re-evaluated on every
 * resolver CALL, not memoized once at resolver-construction time. A
 * regression here (hoisting the lookup outside the returned closure) would
 * be invisible without this test — MarmotContext.tsx has no test file of
 * its own (untestable React context under this repo's no-jsdom convention),
 * and the behavior is otherwise only observable via a mid-session e2e
 * toggle of the override hook.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAuthenticatedSenderResolver } from '@/src/lib/marmot/authenticatedSenderResolver';
import type { ApplicationRumor, AuthenticatedSender } from '@/src/lib/marmot/applicationRumorDispatcher';

function makeRumor(overrides: Partial<ApplicationRumor> = {}): ApplicationRumor {
  return {
    id: 'rumor-id',
    pubkey: 'aa'.repeat(32),
    created_at: 1000000,
    kind: 9,
    tags: [],
    content: 'hello',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createAuthenticatedSenderResolver', () => {
  it('defaults to the claimed rumor.pubkey when no override is registered', () => {
    const resolver = createAuthenticatedSenderResolver();
    const rumor = makeRumor({ pubkey: 'bb'.repeat(32) });

    expect(resolver(rumor)).toEqual({ pubkey: rumor.pubkey, authenticity: 'claimed' });
  });

  it('re-evaluates the window.__fewTest override on every call, not once at construction', () => {
    const senderA: AuthenticatedSender = { pubkey: 'aa'.repeat(32), authenticity: 'mls' };
    const senderB: AuthenticatedSender = { pubkey: 'bb'.repeat(32), authenticity: 'mls' };

    const hooks: { resolveAuthenticatedSender?: (rumor: ApplicationRumor) => AuthenticatedSender | undefined | null } = {
      resolveAuthenticatedSender: () => senderA,
    };
    vi.stubGlobal('window', { __fewTest: hooks });

    // Construct the resolver exactly once and reuse the SAME function instance
    // for both calls — this is the case that would fail if the __fewTest
    // lookup were hoisted outside the returned closure and captured once.
    const resolver = createAuthenticatedSenderResolver();
    const rumor = makeRumor();

    expect(resolver(rumor)).toEqual(senderA);

    // Change the override's return value mid-session, without rebuilding the resolver.
    hooks.resolveAuthenticatedSender = () => senderB;

    expect(resolver(rumor)).toEqual(senderB);
  });

  it('ignores a registered override in production and returns the identity default', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubGlobal('window', {
      __fewTest: {
        resolveAuthenticatedSender: () => ({ pubkey: 'cc'.repeat(32), authenticity: 'mls' as const }),
      },
    });

    const resolver = createAuthenticatedSenderResolver();
    const rumor = makeRumor({ pubkey: 'dd'.repeat(32) });

    expect(resolver(rumor)).toEqual({ pubkey: rumor.pubkey, authenticity: 'claimed' });
  });
});
