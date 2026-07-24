/**
 * E2E spec for the group-message-author-auth-app-layer epic — AC-SEND-10.
 *
 * Story S8 (profile-request bind + meta-event send fails closed).
 *
 * AC-SEND-10 (integrated-e2e, INTERACTIVE path): if a forwardable inner
 * signature cannot be produced (locked/absent signer), the meta-event is
 * NOT emitted and NOT actioned locally. The interactive, user-initiated send
 * — editing the nickname on /profile and leaving the field
 * (app/pages/profile.tsx's handleNicknameBlur → broadcastProfile →
 * `useMarmot().publishProfileUpdate`) — shows a visible, i18n-backed error.
 *
 * There is no real NIP-07 browser extension in this Playwright harness (test
 * identities use a local in-app signer seeded via localStorage — see
 * auth-helpers.ts), so a locked/absent signer is simulated via the dev-only
 * `window.__fewTest.forceProfileSignerFailure` override on
 * MarmotContext.tsx's `publishProfileUpdate` (gated NODE_ENV !== 'production',
 * re-read on every call — mirrors the `resolveAuthenticatedSender` override
 * precedent from story S1's authenticatedSenderResolver.ts).
 *
 * Absence of the meta-event is verified via the SAME rumor-counter mechanism
 * groups-profile-request.spec.ts already relies on for its own "no rumor was
 * sent" assertions (FIXTURE-07-001's window.__fewTest.onRumorSent /
 * window.__rumorCounters), not by inspecting the relay directly — this test
 * drives the real UI + the real publishProfileUpdate implementation; only the
 * signer failure itself is simulated, per CLAUDE.md's "publish through the
 * app" rule.
 *
 * The BACKGROUND/relay half of AC-SEND-10 (dev-log only, no UI error, relies
 * on the EXISTING profile-request retry machinery) is handler-unit tested in
 * app/tests/unit/marmot/profileRequestHandler.test.ts's "AC-SEND-10:
 * background/relay send fails closed" describe block, which exercises the
 * REAL `signAndSendProfileBackground` implementation MarmotContext.tsx wires
 * as `deps.sendSelfProfile` — deliberately NOT duplicated here as a second
 * e2e scenario (VQ-S8-007: the two paths are tested independently, at the
 * level each is cheapest and most precise to verify).
 *
 * Requires the strfry relay harness: make e2e-up (or make test-e2e-groups).
 * Run: E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/groups-profile-send-fails-closed.spec.ts
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const PROFILE_RUMOR_KIND = 0;

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname },
  );
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

async function createGroup(page: Page, name: string): Promise<void> {
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('create-group-btn').click();
  await expect(page.getByTestId('create-group-modal-content')).toBeVisible();
  await page.getByTestId('create-group-name-input').fill(name);
  await page.getByTestId('create-group-submit-btn').click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
  await dismissErrorOverlay(page);
}

test.describe.serial('Meta-event send fails closed — interactive path (AC-SEND-10, epic: group-message-author-auth-app-layer S8)', () => {
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctx, page } = await bootUser(browser, USER_A, 'Alice'));
    // publishProfileUpdate's own precondition is `groups.length > 0`
    // (MarmotContext.tsx) — without a group there is nothing to fan out to,
    // and the interactive send path can't be meaningfully exercised.
    await createGroup(page, 'Signer Failure Group');
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  test('locked/absent signer: nickname-blur broadcast shows a visible error and emits NO group meta-event', async () => {
    test.setTimeout(60_000);

    await page.goto('/profile');
    await page.waitForLoadState('networkidle');

    // Arm the dev-only signer-failure override AND a rumor-out counter for
    // PROFILE_RUMOR_KIND directly on the already-loaded page. No reload
    // follows this step, so the addInitScript-based installRumorCounter
    // helper (meant for the NEXT navigation) doesn't apply here —
    // window.__fewTest already exists by the time the page is interactive
    // (populated by MarmotContext's own dev-hook useEffects), so writing to
    // it directly takes effect immediately for the click below.
    await page.evaluate((kind) => {
      const w = window as unknown as {
        __rumorCounters?: { in: Record<number, number>; out: Record<number, number> };
        __fewTest?: { onRumorSent?: (k: number) => void; forceProfileSignerFailure?: boolean };
      };
      w.__rumorCounters = w.__rumorCounters ?? { in: {}, out: {} };
      w.__rumorCounters.out[kind] = 0;
      w.__fewTest = w.__fewTest ?? {};
      w.__fewTest.onRumorSent = (k: number) => {
        if (w.__rumorCounters!.out[k] !== undefined) {
          w.__rumorCounters!.out[k]++;
        }
      };
      w.__fewTest.forceProfileSignerFailure = true;
    }, PROFILE_RUMOR_KIND);

    // Change the nickname and blur — the REAL interactive send path
    // (app/pages/profile.tsx's handleNicknameBlur → broadcastProfile →
    // publishProfileUpdate(next)), not a synthetic test-only trigger.
    await page.getByTestId('profile-nickname-input').clear();
    await page.getByTestId('profile-nickname-input').fill('Alice Locked');
    await page.getByTestId('profile-nickname-input').blur();

    // Visible, i18n-backed error (AC-SEND-10's interactive surfacing —
    // i18n.ts groups.profileSendFailed).
    await expect(page.getByText("Couldn't send your profile")).toBeVisible({ timeout: 15_000 });

    // Absence of the meta-event: no kind-0 rumor was ever published to ANY
    // group — not merely suppressed in the UI while still firing on the wire
    // (VQ-S8-001). A point-read immediately after the toast is NOT sufficient:
    // the toast fires (signProfileForInteractiveSend's onSignFailed) BEFORE
    // publishProfileUpdate's per-group send loop, so a regressed
    // implementation that toasts AND still runs the (awaited, per-group)
    // send loop would only increment the counter after those async sends
    // resolve — possibly after this read. Give the send loop a bounded
    // window to have run to completion (there is no app-exposed completion
    // hook for publishProfileUpdate to await deterministically), THEN assert
    // the counter has stayed at zero throughout.
    const readOutCount = () =>
      page.evaluate(
        (kind) => (window as unknown as { __rumorCounters?: { out: Record<number, number> } })
          .__rumorCounters?.out?.[kind] ?? 0,
        PROFILE_RUMOR_KIND,
      );
    expect(await readOutCount()).toBe(0);
    await page.waitForTimeout(2_000);
    expect(await readOutCount()).toBe(0);

    // Clear the override so a later action in this same session (were the
    // test extended) would not be permanently wedged into fail-closed.
    await page.evaluate(() => {
      const w = window as unknown as { __fewTest?: { forceProfileSignerFailure?: boolean } };
      if (w.__fewTest) w.__fewTest.forceProfileSignerFailure = false;
    });
  });
});
