import { test, expect } from '@playwright/test';

/**
 * The imprint footer link shows on every page EXCEPT the two open-chat pages —
 * the direct-message thread (`/contacts?id=…`) and the group chat
 * (`/groups?id=…`), where the message composer owns the bottom of the viewport.
 *
 * Non-relay spec (fast bucket): the footer's visibility is a pure function of
 * the route + `id` query param (see `shouldHideImprintFooter` in Layout.tsx),
 * independent of whether the addressed contact/group actually resolves — so a
 * synthetic `id` exercises the chat-page branch without needing a real peer,
 * relay, or signed-in identity. Real-chat coverage (a resolved DM thread that
 * also renders the contact avatar) lives in dm-block-contact.spec.ts.
 */
test.describe('Imprint footer visibility', () => {
  test('shows the footer on non-chat pages (home + both list views)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('footer-imprint-link')).toBeVisible();

    await page.goto('/contacts');
    await expect(page.getByTestId('footer-imprint-link')).toBeVisible();

    await page.goto('/groups');
    await expect(page.getByTestId('footer-imprint-link')).toBeVisible();
  });

  test('hides the footer on the DM chat page (/contacts?id=…)', async ({ page }) => {
    await page.goto('/contacts?id=00000000000000000000000000000000000000000000000000000000deadbeef');
    // The contact detail view renders (not-found for this synthetic id); the
    // footer must be absent from the DOM regardless of that inner state.
    await expect(page.getByTestId('footer-imprint-link')).toHaveCount(0);
  });

  test('hides the footer on the group chat page (/groups?id=…)', async ({ page }) => {
    await page.goto('/groups?id=00000000000000000000000000000000000000000000000000000000deadbeef');
    await expect(page.getByTestId('footer-imprint-link')).toHaveCount(0);
  });
});
