/**
 * authenticatedSenderResolver.ts
 *
 * Boundary rules (architecture.md):
 *   - Zero React imports
 *   - Zero context imports
 */

import type { ApplicationRumor, AuthenticatedSender, SenderResolver } from './applicationRumorDispatcher';

/**
 * S1 (authenticated-sender seam): app-side resolver, throwaway scaffolding
 * until the MLS sender-binding backbone lands (ADR-012). Defaults to the
 * claimed rumor.pubkey; dev-only override hook (window.__fewTest precedent)
 * lets e2e/tests inject a divergent sender to exercise the choke-point drop.
 * Gated NODE_ENV !== 'production' on every CALL (not just at construction)
 * so a production build cannot be made to silently trust an override, and so
 * mid-session e2e toggles of window.__fewTest.resolveAuthenticatedSender take
 * effect on the very next inbound rumor without rebuilding the resolver.
 *
 * NOTE: sender.authenticity is always 'claimed' under this app-side stub;
 * this becomes a required (non-optional) attribution once the MLS
 * sender-binding backbone lands (see VQ-S1-009 / ADR-012) — tracked, not
 * fixed here.
 */
export function createAuthenticatedSenderResolver(): SenderResolver {
  return (rumor: ApplicationRumor): AuthenticatedSender => {
    if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
      const hooks = (window as unknown as {
        __fewTest?: {
          resolveAuthenticatedSender?: (rumor: ApplicationRumor) => AuthenticatedSender | undefined | null;
        };
      }).__fewTest;
      const overridden = hooks?.resolveAuthenticatedSender?.(rumor);
      if (overridden) return overridden;
    }
    return { pubkey: rumor.pubkey, authenticity: 'claimed' };
  };
}
