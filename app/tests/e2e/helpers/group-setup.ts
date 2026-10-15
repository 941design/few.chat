/**
 * Reusable MLS group setup helper for walled-garden tests.
 *
 * Creates a shared MLS group between two users (inviter + invitee) so that
 * the walled-garden gate allows DMs between them.
 *
 * Usage:
 *   await createGroupAndInvite(alicePage, USER_B.npub, bobPage, 'Test Group');
 *
 * After this call:
 *   - Alice has a group visible in her groups list.
 *   - Bob has received the Welcome and the group appears in his list.
 *   - isAllowedDmSender(bob, alice.groups, alice.pubkey) === true.
 */

import { Page, expect } from '@playwright/test';
import { nip19 } from 'nostr-tools';
import { dismissErrorOverlay } from './dismiss-error-overlay';

/** Decode a bech32 npub to its hex pubkey. */
function npubToHex(npub: string): string {
  return npub.startsWith('npub') ? (nip19.decode(npub).data as string) : npub;
}

/**
 * Drive the app's REAL add-contact path (epic: invite-group-member-from-
 * contacts, S3 — AC-E2E-1/AC-E2E-2/AC-E2E-3) so a contact seeded this way is
 * indistinguishable from one a user added by hand: `page.goto('/add#c=' +
 * npub)`, the exact bare-npub payload `parseContactCard` accepts
 * (contactCard.ts's npub-branch), which drives `resolveAddDeepLink` ->
 * `processContactInput` -> `addContactByNpub` and lands on
 * `/contacts?id=<hex>&added=1`.
 *
 * Idempotent by design: re-seeding an npub that is already a (non-blocked)
 * contact makes `add.tsx` `router.replace` to `/contacts?id=<hex>&exists=1`
 * (commit 26d1606) instead of the fresh-add `/contacts?id=<hex>&added=1`.
 * The first renders `contact-already-exists-info`, the second
 * `contact-added-success`; both mean the contact is present afterward, so both
 * are treated as success here — but only when bound to THIS npub's hex (the
 * URL's `id`), so unrelated navigation never passes. This lets
 * `inviteContactViaPicker` be called more than once for the same invitee
 * (AC-E2E-8's re-invite) without a special case. The `add-page-error` alert
 * (invalid npub, self, blocked contact) is deliberately NOT a success: a
 * blocked contact cannot be invited, so seeding it must fail loudly.
 *
 * Every spec that merely needs a seeded contact goes through this helper (or
 * `inviteContactViaPicker`, which calls it), rather than duplicating the
 * navigation inline; only specs that test the `/add#c=` deep link itself
 * (contact-card-deeplink, dm-pairing-readd-lands-on-dm, add-welcome) navigate
 * there directly. No production code is bypassed: this is the same
 * `page.goto` a real user's deep-link tap would trigger.
 */
export async function seedContact(page: Page, npub: string): Promise<void> {
  const hex = npubToHex(npub);
  await page.goto('/add#c=' + npub);
  await expect(
    page.getByTestId('contact-added-success').or(page.getByTestId('contact-already-exists-info')),
  ).toBeVisible({ timeout: 30_000 });
  // Bind the outcome to this contact: either landing carries `id=<hex>` and
  // exactly one of `added=1` / `exists=1`.
  await expect(page).toHaveURL(
    new RegExp(`/contacts/?\\?id=${hex}&(added|exists)=1(&|$)`),
  );
  await dismissErrorOverlay(page);
}

/**
 * The shared "ensure the invitee is a contact, then invite via the picker"
 * helper (epic: invite-group-member-from-contacts, S3 — AC-E2E-1). Replaces
 * every e2e spec's former direct fill of the now-removed npub free-text
 * input, now that `InviteMemberModal` only exposes a contact picker
 * (a scrollable list of clickable rows, `invite-contact-list`).
 *
 * Precondition: `inviterPage` is currently ON the target group's detail page
 * (`group-detail-page` visible, i.e. at `/groups?id=<groupId>`), with the
 * invite modal NOT open yet — this helper opens it itself. `inviteeNpub` is
 * a bech32 npub (not hex).
 *
 * Steps: (1) seed the invitee as a contact via `seedContact` — this
 * navigates the page away to `/add` and on to `/contacts`; (2) navigate back
 * to the group-detail URL captured before step 1; (3) open
 * `InviteMemberModal` and wait for the seeded contact's row to be attached
 * to `invite-contact-list` before interacting with it (never clicks into a
 * stale/empty picker); (4) click the row and click `invite-submit-btn`.
 *
 * Deliberately does NOT assert the outcome (`invite-success` / `invite-
 * error`) — that stays the caller's responsibility, exactly as it already
 * varies per spec (a 60s success wait in the happy-path specs, an
 * `invite-error` assertion in the KeyPackage-less error case).
 */
export async function inviteContactViaPicker(inviterPage: Page, inviteeNpub: string): Promise<void> {
  const groupDetailUrl = inviterPage.url();
  const inviteeHex = npubToHex(inviteeNpub);

  await seedContact(inviterPage, inviteeNpub);

  // Seeding navigated away from the group detail page — return to it and
  // re-open the invite modal.
  await inviterPage.goto(groupDetailUrl);
  await expect(inviterPage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
  await dismissErrorOverlay(inviterPage);

  await inviterPage.getByTestId('invite-member-btn').click();
  await expect(inviterPage.getByTestId('invite-member-modal-content')).toBeVisible();

  const list = inviterPage.getByTestId('invite-contact-list');
  await expect(list).toBeVisible({ timeout: 10_000 });
  // Wait for the just-seeded contact's row to actually be present before
  // clicking it — avoids racing listContacts()'s localStorage read against
  // a stale render (VQ-S3-006).
  const row = inviterPage.getByTestId(`invite-contact-row-${inviteeHex}`);
  await expect(row).toBeAttached({ timeout: 30_000 });
  await row.click();
  await inviterPage.getByTestId('invite-submit-btn').click();
}

/**
 * Accept the pending invitation for `groupName` on `page` and wait until the
 * join has GENUINELY completed.
 *
 * Why this exists: the former inline pattern (`accept-invitation-*` click →
 * `expect(getByText(groupName)).toBeVisible()`) was vacuous — the still-pending
 * InvitationCard already renders the group name (decoded pre-join from the
 * Welcome), so the wait passed immediately while the MLS join was still in
 * flight, and the caller's next `page.goto('/groups/')` / group-card click
 * raced it (bug: groups-e2e-suite-flaky-under-shared).
 *
 * Precondition: `page` is on `/groups/` (the caller navigates, so specs that
 * assert on the pending section/row first keep doing so).
 *
 * Steps:
 *  1. Wait for an `invitation-card-*` whose name element reads exactly
 *     `groupName` (scoped — never a positional `.first()`/`.last()` over all
 *     invitations); if several share the name, the newest (last) is taken.
 *  2. Snapshot how many joined `group-card-*` with that exact name already
 *     exist, then click THAT card's `accept-invitation-*` button.
 *  3. Wait until one more joined `group-card-*` with that name exists than
 *     before (only `reloadGroups()` after a successful `joinGroupFromWelcome`
 *     produces it), and until the clicked invitation card is gone (it is
 *     removed from the queue on success AND on MLS failure, so the group-card
 *     wait is the discriminating one).
 *
 * A join that never completes (MLS failure, accept no-op) fails at step 3.
 */
export async function acceptInvitationAndWaitJoined(
  page: Page,
  groupName: string,
  opts: { timeout?: number } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 90_000;
  const exactName = page.getByText(groupName, { exact: true });

  const invitation = page
    .locator('[data-testid^="invitation-card-"]', { has: exactName })
    .last();
  await expect(invitation).toBeVisible({ timeout });
  const invitationTestId = await invitation.getAttribute('data-testid');
  if (!invitationTestId) throw new Error('invitation card without data-testid');

  // NB: the `group-card-` prefix also matches each card's child
  // `group-card-preview-<id>`; the exact-name `has` filter excludes it, so a
  // raw prefix count would report 2 per group.
  const joinedCards = page.locator('[data-testid^="group-card-"]', { has: exactName });
  const joinedBefore = await joinedCards.count();

  await page.getByTestId(invitationTestId).locator('[data-testid^="accept-invitation-"]').click();

  await expect(joinedCards).toHaveCount(joinedBefore + 1, { timeout });
  await expect(joinedCards.last()).toBeVisible();
  await expect(page.getByTestId(invitationTestId)).toHaveCount(0, { timeout });
}

/**
 * Create a group named `name` on `page` through the real create-group modal,
 * and wait until its joined `group-card-*` is listed.
 *
 * Precondition: `page` is on the `/groups/` list view.
 *
 * Why the readiness gate: `create-group-btn` renders before MarmotContext is
 * `ready`, but `createGroup` returns null while the MLS client is still
 * initialising (MarmotContext `if (!client ...) return null`) — the modal then
 * shows `create-group-error` and nothing retries. `groups-empty-state` /
 * `groups-list` render only once `ready`, so gating on them closes that race
 * (bug: groups-e2e-suite-flaky-under-shared, groups-pending-invite-live-idle).
 *
 * A `create-group-error` fails loudly here instead of surfacing later as a
 * "group name not visible" timeout.
 */
export async function createGroup(
  page: Page,
  name: string,
  opts: { timeout?: number } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 30_000;
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 30_000 });

  const exactName = page.getByText(name, { exact: true });
  const joinedCards = page.locator('[data-testid^="group-card-"]', { has: exactName });
  const before = await joinedCards.count();

  await page.getByTestId('create-group-btn').click();
  const modal = page.getByTestId('create-group-modal-content');
  await expect(modal).toBeVisible();
  await page.getByTestId('create-group-name-input').fill(name);
  await page.getByTestId('create-group-submit-btn').click();

  const createError = page.getByTestId('create-group-error');
  await expect(joinedCards.nth(before).or(createError)).toBeVisible({ timeout });
  if (await createError.isVisible()) {
    throw new Error(`create-group-error shown while creating "${name}": ${await createError.innerText()}`);
  }
  await expect(joinedCards).toHaveCount(before + 1);
  await expect(modal).not.toBeVisible({ timeout: 10_000 });
  await dismissErrorOverlay(page);
}

/**
 * Alice creates a named group, invites Bob by npub, and waits for Bob to join.
 *
 * Bob navigates to /groups/ BEFORE Alice's flow so that stale gift wraps from
 * previous test runs arrive and are processed (their eventIds get marked as seen
 * by the production fix in welcomeSubscription). We then clear only the pending
 * invitations queue (not the seen-set), so when Alice's fresh invite arrives it
 * is the sole entry in the queue.
 *
 * @param alicePage    Page logged in as Alice
 * @param inviteeNpub  Bob's npub (bech32 public key)
 * @param bobPage      Page logged in as Bob
 * @param groupName    Display name for the new group
 */
export async function createGroupAndInvite(
  alicePage: Page,
  inviteeNpub: string,
  bobPage: Page,
  groupName: string,
): Promise<void> {
  // Step 1: Bob navigates to /groups/ early so the welcome subscription is live.
  // Stale relay gift wraps arrive and are processed here; their eventIds are
  // recorded in the seen-set by the production fix.
  await bobPage.goto('/groups/');
  await expect(
    bobPage.getByTestId('groups-empty-state').or(bobPage.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 30_000 });

  // Step 2: Wait for stale relay events to arrive and be marked as seen.
  await bobPage.waitForTimeout(10_000);

  // Step 3: Clear only the pending invitations queue — NOT the seen-set.
  // Stale eventIds remain marked so they cannot re-appear as new invitations.
  await bobPage.evaluate(() => {
    localStorage.removeItem('lp_pendingInvitations_v1');
  });

  // Step 4+5: Alice navigates to the groups page and creates the group
  // (createGroup gates on MarmotContext readiness first).
  await alicePage.goto('/groups/');
  await createGroup(alicePage, groupName);
  // Give the group state time to stabilise before inviting.
  await alicePage.waitForTimeout(3_000);

  // Step 6: Open the group detail and invite Bob — seeded as a contact via
  // the production add-contact path, then invited through the picker
  // (epic: invite-group-member-from-contacts, S3).
  await alicePage.locator('[data-testid^="group-card-"]', { hasText: groupName }).click();
  await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

  await inviteContactViaPicker(alicePage, inviteeNpub);

  // Step 7: Wait for invite-success before timing relay delivery.
  await expect(alicePage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
  await dismissErrorOverlay(alicePage);

  // Step 8: Give the relay a few seconds to deliver Alice's fresh gift wrap to
  // Bob's already-running subscription. The eventId is NOT in the seen-set so
  // it will be enqueued as the only pending invitation.
  await bobPage.waitForTimeout(5_000);

  // Step 9: Bob is already on /groups/ — wait for the pending invitations section.
  // Under pull-only invitations (Walled Garden v2), Bob must explicitly Accept
  // the pending invitation before the group appears in his list.
  await expect(bobPage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 30_000 });

  // Step 10: Accept Alice's invitation for THIS group and wait for the real
  // joined group-card (not the pending card, which already shows the name).
  await acceptInvitationAndWaitJoined(bobPage, groupName);

  // Decode inviteeNpub to hex so the IDB poll can compare memberPubkeys
  // (IDB stores hex pubkeys, not bech32).
  const inviteeHex = inviteeNpub.startsWith('npub')
    ? (nip19.decode(inviteeNpub).data as string)
    : inviteeNpub;

  // Wait for Alice's MarmotContext to have persisted the invitee into memberPubkeys.
  // Groups are stored in IndexedDB ('few-groups-meta' / 'groups').
  // The gate in DirectMessageNotificationsWatcher reads groupsRef.current which
  // is only accurate once MarmotContext has called setGroups with the updated
  // memberPubkeys — i.e. after reloadGroups() completes following Welcome processing.
  // Polling IDB directly gives us the ground-truth signal that the Welcome ratchet
  // has been processed and persisted on Alice's side.
  await alicePage.waitForFunction(
    (inviteePubHex: string) => {
      return new Promise<boolean>((resolve) => {
        const req = indexedDB.open('few-groups-meta');
        req.onerror = () => resolve(false);
        req.onsuccess = () => {
          const db = req.result;
          let tx: IDBTransaction;
          try {
            tx = db.transaction('groups', 'readonly');
          } catch {
            db.close();
            resolve(false);
            return;
          }
          const store = tx.objectStore('groups');
          const allKeys = store.getAllKeys();
          allKeys.onsuccess = () => {
            const keys = allKeys.result as IDBValidKey[];
            if (keys.length === 0) { db.close(); resolve(false); return; }
            let checked = 0;
            let found = false;
            keys.forEach((k) => {
              const getReq = store.get(k);
              getReq.onsuccess = () => {
                const group = getReq.result as { memberPubkeys?: string[] } | undefined;
                if (group?.memberPubkeys?.includes(inviteePubHex)) found = true;
                checked++;
                if (checked === keys.length) { db.close(); resolve(found); }
              };
              getReq.onerror = () => {
                checked++;
                if (checked === keys.length) { db.close(); resolve(found); }
              };
            });
          };
          allKeys.onerror = () => { db.close(); resolve(false); };
        };
      });
    },
    inviteeHex,
    { timeout: 60_000, polling: 1_000 },
  );

  // Extra settle time for both MarmotContext instances to update their groups state
  await bobPage.waitForTimeout(2_000);
}
