/**
 * E2E: pending contact confirmation (epic: pending-contact-confirmation, S2)
 * — AC-MSG-1, AC-MSG-2, AC-OBS-1, AC-OBS-2, AC-UX-1, AC-UX-2.
 *
 * Behavior update (detail-page disabled for restricted contacts): a blocked or
 * pending contact no longer has an openable /contacts?id=<hex> detail page.
 * The list row is not a link, and a direct URL redirects back to the list.
 * Every action for those states is inline on the row: Confirm + Reject for a
 * pending contact, Unblock for a blocked one. The tests below therefore drive
 * confirm/reject inline and assert the redirect, rather than exercising a
 * detail-view prompt (which was removed).
 *
 * AC-OBS-2 was amended 2026-07-15 (spec.md `## Amendments`,
 * acceptance-criteria.md AC-OBS-2), after a Stage-1 review found the
 * original wording unsatisfiable: this app only persists a contact's
 * message content once their conversation has been opened at least once (a
 * pre-existing, out-of-epic-scope DM-pipeline property), so the unread count
 * cannot reconcile held messages at `confirmContact` time — there is nothing
 * persisted yet to reconcile against. The amended AC instead requires the
 * held messages AND the unread count to both catch up correctly the next time
 * the user OPENS the contact's conversation, within the same session (no
 * leave-and-re-enter required). Both tests below assert this end-to-end
 * after confirming: they navigate to the contact's conversation and check
 * both that the held messages render (already-existing coverage) AND that
 * the notification count has cleared once the thread has been viewed — this
 * app's normal "opening a thread marks it read" behavior
 * (`ContactChat`'s `markDirectMessagesRead` mount effect), which is what
 * the amended AC-OBS-2 relies on rather than a special immediate-on-confirm
 * reconciliation. AC-OBS-1 (no unread count raised while still pending) is
 * covered separately, before confirm.
 *
 * Extends the contact-pairing-code epic's `dm-pairing-*.spec.ts` two-browser-
 * context pattern (`bootIdentity`, `getShareCardLink`, `waitForAdmission`).
 * A is the issuer (passive side, scanned by B) — the only side this epic
 * gives a pending contact. B is the scanner — admitted immediately,
 * unaffected by this epic (spec.md "Design Decisions" 1).
 *
 * Every action is driven through the real app: A's code via the real Profile
 * "Share contact card" action, B's scan via the real `/add#c=…` deep-link
 * entry point, every DM via `chat-input`/`chat-send-btn`, every
 * confirm/block action via its real button. No event is hand-signed or sent
 * via raw WebSocket (project CLAUDE.md e2e rule).
 *
 * Requires the strfry relay harness: make e2e-up (or make test-e2e-groups).
 * Run: E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/dm-pairing-pending-confirmation.spec.ts
 */
import { test, expect, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { bootIdentity, getShareCardLink, extractCardPayload } from './helpers/contact-card';
import { waitForAdmission } from './helpers/pairing';

/**
 * Read a contact's `lastSeenAt` from `lp_contacts_v1` (contacts.ts /
 * STORAGE_KEYS.contacts). `rememberContact(peer)` bumps this on EVERY inbound
 * DM event the unread watcher processes — including one from a still-pending
 * peer, since `rememberContact` fires unconditionally ahead of the
 * pending-confirmation gate (spec.md, `directMessageNotifications.ts`
 * Technical Approach). Used as a proxy for "the live gift-wrap event reached
 * and was processed by A's unread watcher", without depending on message
 * CONTENT ever being locally persisted — see the note on
 * `waitForLastSeenAtBump` below for why content persistence is the wrong
 * signal here.
 */
async function readContactLastSeenAt(page: Page, peerHex: string): Promise<string | null> {
  return page.evaluate((hex) => {
    try {
      const raw = localStorage.getItem('lp_contacts_v1');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, { lastSeenAt?: string }>;
      const entry = parsed[hex] ?? parsed[hex.toLowerCase()] ?? parsed[hex.toUpperCase()];
      return entry?.lastSeenAt ?? null;
    } catch {
      return null;
    }
  }, peerHex);
}

/**
 * Read the Contacts-domain nav pill count (0 when the pill is absent).
 *
 * The old flat notification bell was removed; a DM or a pending contact now
 * surfaces on the `contacts-nav-badge` count pill, whose total is
 * (unread DMs) + (pending contacts). In this spec only peer B is involved and
 * A has no other contacts/groups, so this total equals B's own contribution —
 * the exact scalar the removed bell badge used to show here.
 */
async function readBadgeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const badge = document.querySelector('[data-testid="contacts-nav-badge"]');
    if (!badge) return 0;
    return parseInt((badge.textContent ?? '0').trim(), 10);
  });
}

test.describe('Pending contact confirmation — message hold, notification-count delay, confirmation UI', () => {
  test.beforeAll(async () => {
    await computeTestKeypairs();
  });

  test.afterEach(async ({ browser }) => {
    await Promise.all(browser.contexts().map((c) => c.close()));
  });

  test(
    'a pending contact\'s messages raise no unread count (AC-OBS-1); the contacts-list confirm action clears the pending badge (AC-UX-1); no message is lost and the notification count correctly clears once the thread is opened post-confirm (AC-MSG-1, AC-OBS-2)',
    async ({ browser }) => {
      // ── 1. A (issuer) shares a code; B (scanner) scans it once. B is
      // admitted immediately (unaffected by this epic); A ends up with a
      // PENDING contact for B. ─────────────────────────────────────────────
      const a = await bootIdentity(browser, USER_A, 'Alice-Pending-List');
      const cardLink = await getShareCardLink(a.page);
      const payload = extractCardPayload(cardLink);

      const b = await bootIdentity(browser, USER_B, 'Bob-Pending-List');
      await b.page.goto(`/add#c=${payload}`);
      await expect(b.page.getByTestId('contact-added-success')).toBeVisible({ timeout: 20_000 });

      await a.page.goto('/contacts');
      const admitted = await waitForAdmission(a.page, USER_B.pubkeyHex, 90_000);
      expect(admitted, 'A must auto-admit B from the pairing-ack (as a PENDING contact)').toBe(true);

      // ── 2. AC-BADGE-1 (epic: pending-contact-notification): the contacts
      // list shows B with Confirm + Reject and NO "Pending" badge (removed as
      // redundant). AC-E2E-1: A's pending contact surfaces as a count;
      // AC-E2E-2: that count is the pending flag only, no DM. ──────────────
      await a.page.reload();
      await expect(a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`)).toBeVisible({ timeout: 15_000 });
      await expect(a.page.getByTestId(`contact-pending-reject-${USER_B.pubkeyHex}`)).toBeVisible();
      await expect(a.page.getByTestId(`contact-pending-badge-${USER_B.pubkeyHex}`)).toHaveCount(0);

      // AC-E2E-1: the pending contact registers as a count — B's card pill
      // (`contact-unread-badge`) shows 1 (the pending flag, folded into the
      // per-contact number) and the Contacts-domain nav pill total is 1.
      // AC-E2E-2: that 1 is the pending flag ONLY — no DM has been counted yet.
      // (The old notification bell + its per-item dropdown rows were removed and
      // replaced by these count pills.)
      await expect(a.page.getByTestId(`contact-unread-badge-${USER_B.pubkeyHex}`)).toHaveText('1', { timeout: 15_000 });
      expect(await readBadgeCount(a.page)).toBe(1);

      const baselineLastSeenAt = await readContactLastSeenAt(a.page, USER_B.pubkeyHex);

      // ── 3. B sends two DMs to A while A's B-contact is still pending. ──
      await b.page.goto(`/contacts?id=${USER_A.pubkeyHex}`);
      await expect(b.page.getByTestId('contact-detail-page')).toBeVisible({ timeout: 15_000 });
      const msg1 = `held-1-${Date.now()}`;
      await b.page.getByTestId('chat-input').fill(msg1);
      await b.page.getByTestId('chat-send-btn').click();
      await expect(b.page.locator('[data-testid^="msg-"]').filter({ hasText: msg1 })).toBeVisible({ timeout: 15_000 });
      const msg2 = `held-2-${Date.now()}`;
      await b.page.getByTestId('chat-input').fill(msg2);
      await b.page.getByTestId('chat-send-btn').click();
      await expect(b.page.locator('[data-testid^="msg-"]').filter({ hasText: msg2 })).toBeVisible({ timeout: 15_000 });

      // ── 4. AC-OBS-1: wait until A's LIVE unread watcher has genuinely
      // processed at least one of B's events — proven by `lastSeenAt`
      // advancing, since `rememberContact` fires unconditionally ahead of
      // the pending-confirmation gate — THEN assert no DM was counted.
      // A's B-contact's message CONTENT is not expected to be locally
      // persisted yet at this point: like any brand-new DM thread (pending
      // or not), content is only fetched from the relay and persisted the
      // first time that peer's ContactChat mounts (see this repo's existing
      // dm-giftwrap-bell.spec.ts, which proves the count bumps for a normal
      // contact via the SAME live-only path, with no IDB write required).
      await expect.poll(
        async () => readContactLastSeenAt(a.page, USER_B.pubkeyHex),
        { timeout: 30_000 },
      ).not.toBe(baselineLastSeenAt);
      // AC-DM-1 / AC-E2E-2: B's held DMs were NOT counted while pending — B's
      // card pill stays at 1 (the pending flag only, never climbing to fold in
      // the two held DMs) and the Contacts nav-pill total stays 1.
      await expect(a.page.getByTestId(`contact-unread-badge-${USER_B.pubkeyHex}`)).toHaveText('1');
      expect(await readBadgeCount(a.page)).toBe(1);

      // ── 5. AC-BADGE-1 / AC-DM-3: confirm from the LIST row. B becomes an
      // ordinary confirmed contact (Confirm control gone), the pending-contact
      // count clears, and the unread pill for the two held DMs appears
      // IMMEDIATELY — before A ever opens the thread (AC-E2E-3). ────────────
      await a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`).click();
      await expect(a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`)).toHaveCount(0, { timeout: 15_000 });
      // The pending flag clears (−1) and the two held DMs are revealed as unread
      // (+2) on confirm — B's card pill and the Contacts nav total both settle
      // at 2 with no chat open.
      await expect.poll(async () => readBadgeCount(a.page), { timeout: 15_000 }).toBe(2);
      await expect(a.page.getByTestId(`contact-unread-badge-${USER_B.pubkeyHex}`)).toHaveText('2', { timeout: 15_000 });

      // ── 6. AC-MSG-1: no message is lost — both DMs sent while B was
      // pending are still recoverable once A actually opens the thread
      // (this repo's existing historical-relay-fetch-on-open behavior,
      // unchanged by this epic per spec.md Design Decision 4). ───────────
      await a.page.goto(`/contacts?id=${USER_B.pubkeyHex}`);
      await expect(a.page.getByTestId('chat-input')).toBeVisible({ timeout: 20_000 });
      await expect(a.page.locator('[data-testid^="msg-"]').filter({ hasText: msg1 })).toBeVisible({ timeout: 20_000 });
      await expect(a.page.locator('[data-testid^="msg-"]').filter({ hasText: msg2 })).toBeVisible({ timeout: 15_000 });

      // ── 7. AC-OBS-2 (amended 2026-07-15): now that A has opened B's
      // conversation post-confirm, the notification count must correctly
      // reflect that both held messages have been seen — i.e. the count clears,
      // via this app's normal open-marks-read behavior (`ContactChat`'s
      // `markDirectMessagesRead` mount effect). This proves the confirm
      // path doesn't leave B's held messages permanently stuck as unread. ─
      await expect.poll(
        async () => readBadgeCount(a.page),
        { timeout: 15_000 },
      ).toBe(0);
    },
  );

  test(
    'a pending contact has no openable detail page — a direct URL redirects to the list; confirming inline then opening the now-confirmed contact shows held messages and clears the notification count (AC-MSG-2, AC-OBS-2)',
    async ({ browser }) => {
      const a = await bootIdentity(browser, USER_A, 'Alice-Pending-Detail');
      const cardLink = await getShareCardLink(a.page);
      const payload = extractCardPayload(cardLink);

      const b = await bootIdentity(browser, USER_B, 'Bob-Pending-Detail');
      await b.page.goto(`/add#c=${payload}`);
      await expect(b.page.getByTestId('contact-added-success')).toBeVisible({ timeout: 20_000 });

      await a.page.goto('/contacts');
      const admitted = await waitForAdmission(a.page, USER_B.pubkeyHex, 90_000);
      expect(admitted).toBe(true);

      // B sends one message to A while A's B-contact is pending.
      await b.page.goto(`/contacts?id=${USER_A.pubkeyHex}`);
      await expect(b.page.getByTestId('contact-detail-page')).toBeVisible({ timeout: 15_000 });
      const heldMsg = `detail-held-${Date.now()}`;
      await b.page.getByTestId('chat-input').fill(heldMsg);
      await b.page.getByTestId('chat-send-btn').click();
      await expect(b.page.locator('[data-testid^="msg-"]').filter({ hasText: heldMsg })).toBeVisible({ timeout: 15_000 });

      // A direct /contacts?id=<pending> URL does NOT open the detail page — it
      // redirects back to the contacts list. No prompt, no composer ever
      // mounts (the redirect returns before ContactChat renders).
      await a.page.goto(`/contacts?id=${USER_B.pubkeyHex}`);
      await a.page.waitForURL((url) => !url.searchParams.has('id'), { timeout: 20_000 });
      await expect(a.page.getByTestId('contacts-page')).toBeVisible({ timeout: 20_000 });
      await expect(a.page.getByTestId('contact-detail-page')).toHaveCount(0);
      await expect(a.page.getByTestId('pending-confirmation-prompt')).toHaveCount(0);
      await expect(a.page.getByTestId('chat-input')).toHaveCount(0);

      // The pending row is present with an inline Confirm (and Reject) and NO
      // "Pending" badge (AC-BADGE-1); the card itself is NOT a link (a
      // non-linked UserCard renders no anchor).
      await expect(a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`)).toBeVisible({ timeout: 15_000 });
      await expect(a.page.getByTestId(`contact-pending-badge-${USER_B.pubkeyHex}`)).toHaveCount(0);
      await expect(a.page.getByTestId(`contact-card-${USER_B.pubkeyHex}`).locator('a')).toHaveCount(0);

      // Confirm inline from the list row — the Confirm control clears.
      await a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`).click();
      await expect(a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`)).toHaveCount(0, { timeout: 15_000 });

      // Now B is a normal contact: the detail page opens, AC-MSG-2's held
      // message renders, and opening the thread clears the notification count
      // (AC-OBS-2, via ContactChat's open-marks-read mount effect).
      await a.page.goto(`/contacts?id=${USER_B.pubkeyHex}`);
      await expect(a.page.getByTestId('chat-input')).toBeVisible({ timeout: 20_000 });
      await expect(a.page.locator('[data-testid^="msg-"]').filter({ hasText: heldMsg })).toBeVisible({ timeout: 15_000 });
      await expect.poll(
        async () => readBadgeCount(a.page),
        { timeout: 15_000 },
      ).toBe(0);
    },
  );

  test(
    'the pending list row offers a first-class inline Reject button; rejecting opens the block confirm modal and, on confirm, blocks the contact (reject-is-block, mirrors group Approve/Deny)',
    async ({ browser }) => {
      const a = await bootIdentity(browser, USER_A, 'Alice-Pending-Reject');
      const cardLink = await getShareCardLink(a.page);
      const payload = extractCardPayload(cardLink);

      const b = await bootIdentity(browser, USER_B, 'Bob-Pending-Reject');
      await b.page.goto(`/add#c=${payload}`);
      await expect(b.page.getByTestId('contact-added-success')).toBeVisible({ timeout: 20_000 });

      await a.page.goto('/contacts');
      const admitted = await waitForAdmission(a.page, USER_B.pubkeyHex, 90_000);
      expect(admitted).toBe(true);
      await a.page.reload();

      // The pending row carries an inline Confirm + Reject and NO "Pending"
      // badge (AC-BADGE-1). AC-E2E-1: the pending contact registered as a count
      // (Contacts nav-pill total is 1 — the pending flag, no DMs in this flow).
      await expect(a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`)).toBeVisible({ timeout: 15_000 });
      await expect(a.page.getByTestId(`contact-pending-badge-${USER_B.pubkeyHex}`)).toHaveCount(0);
      await expect.poll(async () => readBadgeCount(a.page), { timeout: 15_000 }).toBe(1);
      const rejectBtn = a.page.getByTestId(`contact-pending-reject-${USER_B.pubkeyHex}`);
      await expect(rejectBtn).toBeVisible();
      await expect(rejectBtn).toHaveText('Reject');

      // Rejecting routes through the existing block flow: it opens the block
      // confirm modal (which still spells out the real consequences) rather
      // than acting immediately. Confirming blocks the contact.
      await rejectBtn.click();
      await expect(a.page.getByTestId('block-confirm-modal')).toBeVisible();
      await a.page.getByTestId('block-confirm-btn').click();
      await expect(a.page.getByTestId('block-confirm-modal')).not.toBeVisible();

      // Blocked: the pending row leaves the default list (blocked contacts are
      // hidden unless "show hidden" is toggled), the contact is durably
      // archived in storage, AND the pending-contact count clears — no
      // stranded contribution to the nav-pill total (AC-E2E-4 / AC-LIFE-4).
      await expect(a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`)).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(async () => readBadgeCount(a.page), { timeout: 15_000 }).toBe(0);
      const archived = await a.page.evaluate((hex) => {
        const raw = localStorage.getItem('lp_contacts_v1');
        const parsed = raw ? JSON.parse(raw) : {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = Object.values(parsed).find((c: any) => (c.pubkeyHex || '').toLowerCase() === hex.toLowerCase()) as any;
        return entry ? entry.archivedAt : null;
      }, USER_B.pubkeyHex);
      expect(archived).toBeTruthy();
    },
  );

  test(
    'a blocked contact has no openable detail page — a direct URL redirects to the list; the blocked row (under "show hidden") is not clickable and offers an inline Unblock (spec.md Design Decision 9)',
    async ({ browser }) => {
      const a = await bootIdentity(browser, USER_A, 'Alice-BlockedPending');
      const cardLink = await getShareCardLink(a.page);
      const payload = extractCardPayload(cardLink);

      const b = await bootIdentity(browser, USER_B, 'Bob-BlockedPending');
      await b.page.goto(`/add#c=${payload}`);
      await expect(b.page.getByTestId('contact-added-success')).toBeVisible({ timeout: 20_000 });

      await a.page.goto('/contacts');
      const admitted = await waitForAdmission(a.page, USER_B.pubkeyHex, 90_000);
      expect(admitted).toBe(true);

      // A blocks the still-pending B via the real Profile block action. On a
      // pending contact's profile the standalone Block button is replaced by
      // the Confirm + Reject pair (epic: pending-contact-profile-gate); Reject
      // is the block flow relabelled, opening the same block-confirm modal.
      await a.page.goto(`/profile?pubkey=${USER_B.pubkeyHex}`);
      await expect(a.page.getByTestId('profile-pending-reject')).toBeVisible({ timeout: 15_000 });
      await a.page.getByTestId('profile-pending-reject').click();
      await expect(a.page.getByTestId('block-confirm-modal')).toBeVisible();
      await a.page.getByTestId('block-confirm-btn').click();
      await expect(a.page.getByTestId('block-confirm-modal')).not.toBeVisible();

      // A direct /contacts?id=<blocked> URL does NOT open the detail page — it
      // redirects back to the list. No Blocked banner, no composer, ever
      // (superseding the block-contact epic's Blocked-banner detail UX; the
      // security property that no send affordance mounts is preserved).
      await a.page.goto(`/contacts?id=${USER_B.pubkeyHex}`);
      await a.page.waitForURL((url) => !url.searchParams.has('id'), { timeout: 20_000 });
      await expect(a.page.getByTestId('contacts-page')).toBeVisible({ timeout: 20_000 });
      await expect(a.page.getByTestId('contact-detail-page')).toHaveCount(0);
      await expect(a.page.getByTestId('contact-archived-alert')).toHaveCount(0);
      await expect(a.page.getByTestId('chat-input')).toHaveCount(0);

      // Reveal hidden contacts: the blocked row is present, NOT a link, and
      // offers an inline Unblock button — the sole unblock affordance now.
      await a.page.getByTestId('contacts-filter-show-hidden').click();
      const card = a.page.getByTestId(`contact-card-${USER_B.pubkeyHex}`);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.locator('a')).toHaveCount(0);
      const unblockBtn = a.page.getByTestId(`contact-unblock-${USER_B.pubkeyHex}`);
      await expect(unblockBtn).toBeVisible();

      // Unblocking inline (no modal) clears the blocked state in place.
      await unblockBtn.click();
      await expect(a.page.getByTestId('block-confirm-modal')).toHaveCount(0);
      await expect(unblockBtn).not.toBeVisible({ timeout: 15_000 });
    },
  );

  test(
    "a pending contact's PROFILE page mirrors the overview gate: Confirm + Reject replace the Block button, Send message is disabled, and confirming from the profile flips it to the normal layout in place (epic: pending-contact-profile-gate, AC-PEND-1..5)",
    async ({ browser }) => {
      // ── Set up A with a PENDING contact for B via the real pairing flow. ─
      const a = await bootIdentity(browser, USER_A, 'Alice-Pending-Profile');
      const cardLink = await getShareCardLink(a.page);
      const payload = extractCardPayload(cardLink);

      const b = await bootIdentity(browser, USER_B, 'Bob-Pending-Profile');
      await b.page.goto(`/add#c=${payload}`);
      await expect(b.page.getByTestId('contact-added-success')).toBeVisible({ timeout: 20_000 });

      await a.page.goto('/contacts');
      const admitted = await waitForAdmission(a.page, USER_B.pubkeyHex, 90_000);
      expect(admitted, 'A must auto-admit B as a PENDING contact').toBe(true);
      await a.page.reload();
      await expect(a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`)).toBeVisible({ timeout: 15_000 });

      // ── Open B's PROFILE (reachable via the row's view-profile icon; here
      // driven by the direct query-param URL the icon navigates to). ───────
      await a.page.goto(`/profile?pubkey=${USER_B.pubkeyHex}`);
      await expect(a.page.getByTestId('profile-page')).toBeVisible({ timeout: 20_000 });

      // AC-PEND-1: Confirm + Reject are shown (the same inline pair as the
      // overview). AC-PEND-4: the standalone Block button is REPLACED — it is
      // not rendered while pending.
      await expect(a.page.getByTestId('profile-pending-actions')).toBeVisible({ timeout: 15_000 });
      await expect(a.page.getByTestId('profile-pending-confirm')).toBeVisible();
      const rejectBtn = a.page.getByTestId('profile-pending-reject');
      await expect(rejectBtn).toBeVisible();
      await expect(rejectBtn).toHaveText('Reject');
      await expect(a.page.getByTestId('profile-archive')).toHaveCount(0);

      // AC-PEND-2: Send message is VISIBLE but DISABLED while pending.
      const sendDm = a.page.getByTestId('profile-send-dm');
      await expect(sendDm).toBeVisible();
      await expect(sendDm).toBeDisabled();

      // ── AC-PEND-5: confirm from the PROFILE. The profile re-derives in
      // place (no navigation): the pending actions disappear, the standalone
      // Block button appears, and Send message becomes enabled. ────────────
      await a.page.getByTestId('profile-pending-confirm').click();
      await expect(a.page.getByTestId('profile-pending-actions')).toHaveCount(0, { timeout: 15_000 });
      await expect(a.page.getByTestId('profile-archive')).toBeVisible({ timeout: 15_000 });
      await expect(a.page.getByTestId('profile-send-dm')).toBeEnabled();

      // The confirm durably cleared the pending state in storage.
      const stillPending = await a.page.evaluate((hex) => {
        const raw = localStorage.getItem('lp_contacts_v1');
        const parsed = raw ? JSON.parse(raw) : {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = Object.values(parsed).find((c: any) => (c.pubkeyHex || '').toLowerCase() === hex.toLowerCase()) as any;
        return entry ? Boolean(entry.pendingConfirmationSince) : null;
      }, USER_B.pubkeyHex);
      expect(stillPending).toBe(false);
    },
  );
});
