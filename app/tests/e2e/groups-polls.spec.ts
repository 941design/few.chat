import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function bootUserWithProfile(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    if (!localStorage.getItem('lp_userProfile_v1')) {
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    }
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname });
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  // Re-seed identity + profile AFTER clearAppState, before reload. The
  // addInitScript above seeds the profile only `if (!lp_userProfile_v1)`, which
  // races with ProfileContext's hydrate-and-persist: if the first page's
  // ProfileContext effect runs after clearAppState wiped the profile, it
  // persists an empty-nickname default ({nickname:'', avatar:<random>}) that
  // then survives the reload guard. Alice would then broadcast a blank nickname
  // to the group, so B renders her npub instead of "Alice" in the poll
  // announcement. Writing the profile explicitly here guarantees a non-empty
  // nickname when the reloaded ProfileContext hydrates.
  await page.evaluate(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname });
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

async function createGroupAndOpen(page: Page, groupName: string): Promise<void> {
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('create-group-btn').click();
  await expect(page.getByTestId('create-group-modal-content')).toBeVisible();
  await page.getByTestId('create-group-name-input').fill(groupName);
  await page.getByTestId('create-group-submit-btn').click();
  await expect(page.getByText(groupName)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
  await dismissErrorOverlay(page);
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

async function inviteAndJoin(
  inviterPage: Page,
  inviteeNpub: string,
  inviteePage: Page,
  groupName: string,
): Promise<void> {
  // Walled Garden v2 pull-only flow: warm-up + clear so invitee's queue holds
  // only the fresh invite after Alice publishes.
  await inviteePage.goto('/groups/');
  await inviteePage.waitForTimeout(10_000);
  await inviteePage.evaluate(() => {
    localStorage.removeItem('lp_pendingInvitations_v1');
  });

  await dismissErrorOverlay(inviterPage);
  await inviteContactViaPicker(inviterPage, inviteeNpub);
  await expect(inviterPage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
  await inviterPage.keyboard.press('Escape');

  // Invitee receives Welcome as pending invitation and must explicitly accept.
  await inviteePage.waitForTimeout(5_000);
  await inviteePage.goto('/groups/');
  await expect(inviteePage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
  await expect(inviteePage.locator('[data-testid^="pending-invitation-row-"]').last()).toBeVisible({ timeout: 30_000 });
  await inviteePage.locator('[data-testid^="accept-invitation-"]').last().click();
  await expect(inviteePage.getByText(groupName)).toBeVisible({ timeout: 90_000 });

  // Wait for profile exchange to complete
  await inviteePage.waitForTimeout(10_000);
}

async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// Test Suite 1: Poll creation and UI
// ---------------------------------------------------------------------------

test.describe.serial('Poll creation and panel UI', () => {
  let ctxA: BrowserContext;
  let pgA: Page;
  const GROUP_NAME = 'Poll UI Test';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
  });

  test('A creates group and sees poll panel', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);
    // Poll panel should be visible by default
    await expect(pgA.getByTestId('poll-panel')).toBeVisible({ timeout: 10_000 });
    // Should show empty state
    await expect(pgA.getByText('No polls yet')).toBeVisible();
    // "Poll" button should exist
    await expect(pgA.getByTestId('create-poll-btn')).toBeVisible();
  });

  test('Create poll modal opens and validates input', async () => {
    await pgA.getByTestId('create-poll-btn').click();
    await expect(pgA.getByTestId('create-poll-modal')).toBeVisible();

    // Submit disabled without title
    await expect(pgA.getByTestId('create-poll-submit-btn')).toBeDisabled();

    // Fill title only — still disabled (need 2 non-empty options)
    await pgA.getByTestId('poll-title-input').fill('Favorite topic?');
    await expect(pgA.getByTestId('create-poll-submit-btn')).toBeDisabled();

    // Fill one option — still disabled
    await pgA.getByTestId('poll-option-input-0').fill('Functions');
    await expect(pgA.getByTestId('create-poll-submit-btn')).toBeDisabled();

    // Fill second option — now enabled
    await pgA.getByTestId('poll-option-input-1').fill('Arrays');
    await expect(pgA.getByTestId('create-poll-submit-btn')).toBeEnabled();
  });

  test('Add and remove options in create poll modal', async () => {
    // Add a third option
    await pgA.getByTestId('poll-add-option-btn').click();
    await expect(pgA.getByTestId('poll-option-input-2')).toBeVisible();
    await pgA.getByTestId('poll-option-input-2').fill('Loops');

    // Remove icon should be visible for 3 options
    await expect(pgA.getByTestId('poll-remove-option-2')).toBeVisible();

    // Remove the third option
    await pgA.getByTestId('poll-remove-option-2').click();
    await expect(pgA.getByTestId('poll-option-input-2')).not.toBeVisible();
  });

  test('A creates a single-choice poll', async () => {
    // Single choice should be the default
    await expect(pgA.getByTestId('poll-type-single')).toBeChecked();

    // Submit the poll
    await pgA.getByTestId('create-poll-submit-btn').click();

    // Modal should close
    await expect(pgA.getByTestId('create-poll-modal')).not.toBeVisible({ timeout: 10_000 });

    // Poll should appear in the panel
    const panel = pgA.getByTestId('poll-panel');
    await expect(panel.getByText('Favorite topic?')).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText('No polls yet')).not.toBeVisible();

    // Panel header should show count
    await expect(panel.getByRole('heading', { name: 'Polls (1)' })).toBeVisible();
  });

  test('Poll card shows correct structure', async () => {
    // Should show poll details
    const panel = pgA.getByTestId('poll-panel');
    await expect(panel.getByText('Favorite topic?')).toBeVisible();
    await expect(panel.getByText('Single choice')).toBeVisible();
    await expect(panel.getByText('by Alice')).toBeVisible();
    await expect(panel.getByText('Functions')).toBeVisible();
    await expect(panel.getByText('Arrays')).toBeVisible();
    await expect(panel.getByText('0 votes')).toBeVisible();
  });

  test('Chat shows poll announcement', async () => {
    // Chat should have a poll announcement (sent via ChatStoreContext, visible optimistically)
    await expect(pgA.getByTestId('poll-chat-announcement')).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByText('Alice started a poll')).toBeVisible();
    await expect(
      pgA.getByTestId('poll-chat-announcement').getByText('Favorite topic?'),
    ).toBeVisible();
  });

  test('A votes on own poll', async () => {
    const panel = pgA.getByTestId('poll-panel');

    // Select "Functions" by clicking the label text
    const pollCard = panel.locator('[data-testid^="poll-card-"]').first();
    await pollCard.getByText('Functions').click();

    // Click Vote
    await pollCard.getByText('Vote', { exact: true }).click();

    // Should show "Voted" indicator
    await expect(pollCard.getByText('Voted')).toBeVisible({ timeout: 10_000 });
    await expect(pollCard.getByText('1 vote')).toBeVisible();
  });

  test('A re-votes with different option', async () => {
    const panel = pgA.getByTestId('poll-panel');
    const pollCard = panel.locator('[data-testid^="poll-card-"]').first();

    // Change to "Arrays" by clicking the label text
    await pollCard.getByText('Arrays').click();

    // Button should say "Update Vote" since already voted
    await pollCard.getByText('Update Vote').click();

    // Still shows 1 vote (same voter, re-voted)
    await expect(pollCard.getByText('Voted')).toBeVisible({ timeout: 10_000 });
    await expect(pollCard.getByText('1 vote')).toBeVisible();
  });

  test('Creator sees Close Poll button', async () => {
    const panel = pgA.getByTestId('poll-panel');
    const pollCard = panel.locator('[data-testid^="poll-card-"]').first();
    await expect(pollCard.getByText('Close Poll')).toBeVisible();
  });

  test('A closes poll with confirmation', async () => {
    const panel = pgA.getByTestId('poll-panel');
    const pollCard = panel.locator('[data-testid^="poll-card-"]').first();

    // Click Close Poll
    await pollCard.getByText('Close Poll').click();

    // Confirmation should appear
    await expect(pollCard.getByText('Close this poll?')).toBeVisible();

    // Confirm close
    await pollCard.getByText('Confirm').click();

    // After close, poll moves to collapsed "closed" section — expand it
    await expect(pgA.getByTestId('poll-toggle-closed')).toBeVisible({ timeout: 30_000 });
    await pgA.getByTestId('poll-toggle-closed').click();

    // Should transition to results display
    await expect(
      panel.locator('[data-testid^="poll-results-card-"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // Results should show vote tally
    await expect(panel.getByText('1 voter')).toBeVisible();
  });

  test('Chat shows poll results', async () => {
    // Chat should have a results message
    await expect(pgA.getByTestId('poll-chat-results')).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByText('Alice closed the poll')).toBeVisible();
  });

  test('Closed polls appear in collapsible section', async () => {
    const panel = pgA.getByTestId('poll-panel');

    // Should show toggle for closed polls
    await expect(pgA.getByTestId('poll-toggle-closed')).toBeVisible();

    // Closed poll results should be visible since section starts open after close
    // Toggle to hide closed polls
    await pgA.getByTestId('poll-toggle-closed').click();

    // Toggle to show again
    await pgA.getByTestId('poll-toggle-closed').click();
    await expect(
      panel.locator('[data-testid^="poll-results-card-"]').first(),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Test Suite 2: Multiple-choice poll
// ---------------------------------------------------------------------------

test.describe.serial('Multiple-choice poll', () => {
  let ctxA: BrowserContext;
  let pgA: Page;
  const GROUP_NAME = 'Multi-Choice Poll';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
  });

  test('Setup: create group', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);
  });

  test('A creates a multiple-choice poll', async () => {
    await pgA.getByTestId('create-poll-btn').click();
    await expect(pgA.getByTestId('create-poll-modal')).toBeVisible();

    await pgA.getByTestId('poll-title-input').fill('Select all that apply');
    await pgA.getByTestId('poll-option-input-0').fill('Option A');
    await pgA.getByTestId('poll-option-input-1').fill('Option B');
    await pgA.getByTestId('poll-add-option-btn').click();
    await pgA.getByTestId('poll-option-input-2').fill('Option C');

    // Switch to multiple choice
    await pgA.getByTestId('poll-type-multi').click();
    await expect(pgA.getByTestId('poll-type-multi')).toBeChecked();

    await pgA.getByTestId('create-poll-submit-btn').click();
    await expect(pgA.getByTestId('create-poll-modal')).not.toBeVisible({ timeout: 10_000 });

    // Poll should appear in the panel
    const panel = pgA.getByTestId('poll-panel');
    await expect(panel.getByText('Select all that apply')).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText('Multiple choice')).toBeVisible();
  });

  test('Multiple-choice poll shows checkboxes', async () => {
    const panel = pgA.getByTestId('poll-panel');
    const pollCard = panel.locator('[data-testid^="poll-card-"]').first();

    // Should have checkboxes instead of radio buttons
    const checkboxes = pollCard.locator('input[type="checkbox"]');
    await expect(checkboxes).toHaveCount(3);
  });

  test('A votes for multiple options', async () => {
    const panel = pgA.getByTestId('poll-panel');
    const pollCard = panel.locator('[data-testid^="poll-card-"]').first();

    // Select options A and C by clicking their labels
    await pollCard.getByText('Option A').click();
    await pollCard.getByText('Option C').click();

    await pollCard.getByText('Vote', { exact: true }).click();

    await expect(pollCard.getByText('Voted')).toBeVisible({ timeout: 30_000 });
    await expect(pollCard.getByText('1 vote')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Test Suite 3: Cross-user poll interaction (A creates, B votes, A closes)
// ---------------------------------------------------------------------------

test.describe.serial('Cross-user poll lifecycle', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  const GROUP_NAME = 'Poll Cross-User';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pgB } = await bootUserWithProfile(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('Setup: A creates group and invites B', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);
    await pgB.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_NAME);
  });

  test('A creates a poll', async () => {
    // Ensure A is on group detail
    await openGroupDetail(pgA, GROUP_NAME);
    await expect(pgA.getByTestId('poll-panel')).toBeVisible({ timeout: 10_000 });

    await pgA.getByTestId('create-poll-btn').click();
    await expect(pgA.getByTestId('create-poll-modal')).toBeVisible();

    await pgA.getByTestId('poll-title-input').fill('When should we meet?');
    await pgA.getByTestId('poll-option-input-0').fill('Monday');
    await pgA.getByTestId('poll-option-input-1').fill('Wednesday');
    await pgA.getByTestId('poll-add-option-btn').click();
    await pgA.getByTestId('poll-option-input-2').fill('Friday');

    await pgA.getByTestId('create-poll-submit-btn').click();
    await expect(pgA.getByTestId('create-poll-modal')).not.toBeVisible({ timeout: 10_000 });

    await expect(pgA.getByTestId('poll-panel').getByText('When should we meet?')).toBeVisible({ timeout: 10_000 });
  });

  test('B sees the poll in their panel', async () => {
    // B opens the group detail
    await openGroupDetail(pgB, GROUP_NAME);
    const panelB = pgB.getByTestId('poll-panel');
    await expect(panelB).toBeVisible({ timeout: 10_000 });

    // B should see A's poll (via MLS message — may need to wait for delivery)
    await expect(panelB.getByText('When should we meet?')).toBeVisible({ timeout: 60_000 });
    await expect(panelB.getByText('Monday')).toBeVisible();
    await expect(panelB.getByText('Wednesday')).toBeVisible();
    await expect(panelB.getByText('Friday')).toBeVisible();
  });

  test('B sees poll announcement in chat', async () => {
    await expect(pgB.getByTestId('poll-chat-announcement')).toBeVisible({ timeout: 10_000 });
    await expect(pgB.getByText('Alice started a poll')).toBeVisible();
  });

  test('B does NOT see Close Poll button (non-creator)', async () => {
    const panel = pgB.getByTestId('poll-panel');
    const pollCard = panel.locator('[data-testid^="poll-card-"]').first();
    await expect(pollCard.getByText('Close Poll')).not.toBeVisible();
  });

  test('B votes on the poll', async () => {
    const panel = pgB.getByTestId('poll-panel');
    const pollCard = panel.locator('[data-testid^="poll-card-"]').first();

    // B selects Wednesday by clicking the label text
    await pollCard.getByText('Wednesday').click();
    await pollCard.getByText('Vote', { exact: true }).click();

    await expect(pollCard.getByText('Voted')).toBeVisible({ timeout: 10_000 });
  });

  test('A sees vote count increase', async () => {
    // A should see the vote count update (their own vote not yet cast, but B's arrives)
    const panel = pgA.getByTestId('poll-panel');
    const pollCard = panel.locator('[data-testid^="poll-card-"]').first();

    // B's vote should arrive via MLS subscription
    await expect(pollCard.getByText('1 vote')).toBeVisible({ timeout: 30_000 });
  });

  test('A votes and then closes the poll', async () => {
    const panel = pgA.getByTestId('poll-panel');
    const pollCard = panel.locator('[data-testid^="poll-card-"]').first();

    // A votes for Monday by clicking label text
    await pollCard.getByText('Monday').click();
    await pollCard.getByText('Vote', { exact: true }).click();
    await expect(pollCard.getByText('Voted')).toBeVisible({ timeout: 10_000 });

    // Now close the poll
    await pollCard.getByText('Close Poll').click();
    await expect(pollCard.getByText('Close this poll?')).toBeVisible();
    await pollCard.getByText('Confirm').click();

    // After close, poll moves to collapsed "closed" section — expand it
    await expect(pgA.getByTestId('poll-toggle-closed')).toBeVisible({ timeout: 30_000 });
    await pgA.getByTestId('poll-toggle-closed').click();

    // Should show results
    await expect(
      panel.locator('[data-testid^="poll-results-card-"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText('2 voters')).toBeVisible();
  });

  test('A sees results in chat', async () => {
    await expect(pgA.getByTestId('poll-chat-results')).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByText('Alice closed the poll')).toBeVisible();
  });

  test('B sees closed poll with results', async () => {
    // B should receive the close message — wait for the closed toggle to appear
    await expect(pgB.getByTestId('poll-toggle-closed')).toBeVisible({ timeout: 60_000 });
    await pgB.getByTestId('poll-toggle-closed').click();

    // Results card should be visible in the expanded closed section
    await expect(
      pgB.getByTestId('poll-panel').locator('[data-testid^="poll-results-card-"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(pgB.getByTestId('poll-panel').getByText('2 voters')).toBeVisible();
  });

  test('B sees results in chat', async () => {
    await expect(pgB.getByTestId('poll-chat-results')).toBeVisible({ timeout: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// Test Suite 4: Concurrent polls
// ---------------------------------------------------------------------------

test.describe.serial('Multiple concurrent polls', () => {
  let ctxA: BrowserContext;
  let pgA: Page;
  const GROUP_NAME = 'Concurrent Polls';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
  });

  test('Setup: create group', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);
  });

  test('A creates two polls', async () => {
    // First poll
    await pgA.getByTestId('create-poll-btn').click();
    await pgA.getByTestId('poll-title-input').fill('First poll');
    await pgA.getByTestId('poll-option-input-0').fill('Yes');
    await pgA.getByTestId('poll-option-input-1').fill('No');
    await pgA.getByTestId('create-poll-submit-btn').click();
    await expect(pgA.getByTestId('create-poll-modal')).not.toBeVisible({ timeout: 10_000 });
    await expect(pgA.getByTestId('poll-panel').getByText('First poll')).toBeVisible({ timeout: 10_000 });

    // Second poll
    await pgA.getByTestId('create-poll-btn').click();
    await expect(pgA.getByTestId('create-poll-modal')).toBeVisible();
    await pgA.getByTestId('poll-title-input').fill('Second poll');
    await pgA.getByTestId('poll-option-input-0').fill('Agree');
    await pgA.getByTestId('poll-option-input-1').fill('Disagree');
    await pgA.getByTestId('create-poll-submit-btn').click();
    await expect(pgA.getByTestId('create-poll-modal')).not.toBeVisible({ timeout: 10_000 });
    await expect(pgA.getByTestId('poll-panel').getByText('Second poll')).toBeVisible({ timeout: 10_000 });
  });

  test('Panel shows count of 2 active polls', async () => {
    await expect(pgA.getByRole('heading', { name: 'Polls (2)' })).toBeVisible({ timeout: 10_000 });
  });

  test('Both polls appear in panel (newest first)', async () => {
    const panel = pgA.getByTestId('poll-panel');
    const pollCards = panel.locator('[data-testid^="poll-card-"]');
    await expect(pollCards).toHaveCount(2);

    // Newest first: "Second poll" should be first
    const firstCard = pollCards.first();
    await expect(firstCard.getByText('Second poll')).toBeVisible();
  });

  test('Closing one poll keeps other active', async () => {
    const panel = pgA.getByTestId('poll-panel');
    // Close the first card (Second poll, since it's newest-first)
    const firstCard = panel.locator('[data-testid^="poll-card-"]').first();
    await firstCard.getByText('Close Poll').click();
    await firstCard.getByText('Confirm').click();

    // Should have 1 active poll and 1 closed
    await expect(pgA.getByRole('heading', { name: 'Polls (1)' })).toBeVisible({ timeout: 10_000 });
    await expect(panel.locator('[data-testid^="poll-card-"]')).toHaveCount(1);
    await expect(pgA.getByTestId('poll-toggle-closed')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Test Suite 5: Zero-vote close
// ---------------------------------------------------------------------------

test.describe.serial('Close poll with zero votes', () => {
  let ctxA: BrowserContext;
  let pgA: Page;
  const GROUP_NAME = 'Zero Vote Poll';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
  });

  test('A creates and immediately closes a poll', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);

    // Create poll
    await pgA.getByTestId('create-poll-btn').click();
    await pgA.getByTestId('poll-title-input').fill('Empty poll');
    await pgA.getByTestId('poll-option-input-0').fill('Alpha');
    await pgA.getByTestId('poll-option-input-1').fill('Beta');
    await pgA.getByTestId('create-poll-submit-btn').click();
    await expect(pgA.getByTestId('create-poll-modal')).not.toBeVisible({ timeout: 10_000 });

    // Wait for poll to appear before closing
    const panel = pgA.getByTestId('poll-panel');
    const pollCard = panel.locator('[data-testid^="poll-card-"]').first();
    await expect(pollCard).toBeVisible({ timeout: 10_000 });

    // Close immediately (no votes)
    await pollCard.getByText('Close Poll').click();
    await pollCard.getByText('Confirm').click();

    // After close, the poll moves to the closed section — expand it
    await expect(pgA.getByTestId('poll-toggle-closed')).toBeVisible({ timeout: 30_000 });
    await pgA.getByTestId('poll-toggle-closed').click();

    // Results should show 0 voters
    await expect(
      panel.locator('[data-testid^="poll-results-card-"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText('0 voters')).toBeVisible();
  });

  test('Chat shows 0-vote results', async () => {
    await expect(pgA.getByTestId('poll-chat-results')).toBeVisible({ timeout: 30_000 });
    const resultsBox = pgA.getByTestId('poll-chat-results');
    await expect(resultsBox.getByText('0 votes')).toBeVisible();
  });
});
