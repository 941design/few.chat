import { test, expect } from '@playwright/test';

// The imprint renders from a per-language Mustache template
// (src/content/imprint.*.md) fed the single-sourced IMPRINT constant. These
// checks pin the injected legal facts and the "drop empty fields" behavior.
test.describe('Imprint page', () => {
  test('renders the injected legal facts', async ({ page }) => {
    await page.goto('/imprint');
    const imprint = page.getByTestId('imprint-page');
    await expect(imprint.getByRole('heading', { name: 'Imprint', level: 1 })).toBeVisible();
    await expect(imprint.getByRole('heading', { name: /Information pursuant to § 5 DDG/i })).toBeVisible();
    await expect(imprint).toContainText('rotheric GmbH');
    await expect(imprint).toContainText('Scheibenstr. 6a');
    await expect(imprint).toContainText('HRB 6782');
    // Email is rendered as a real mailto link from IMPRINT.email.
    await expect(imprint.getByRole('link', { name: 'markus@rotheric.com' })).toHaveAttribute(
      'href',
      'mailto:markus@rotheric.com',
    );
    // VAT ID is populated (§27a UStG), so its section renders with the number.
    await expect(imprint.getByRole('heading', { name: /VAT ID/i })).toBeVisible();
    await expect(imprint).toContainText('DE463560219');
  });

  test('omits empty optional sections (phone)', async ({ page }) => {
    await page.goto('/imprint');
    const imprint = page.getByTestId('imprint-page');
    // IMPRINT.phone is empty, so its section must not render. (VAT is populated
    // — its presence is asserted by "renders the injected legal facts" above.)
    await expect(imprint).not.toContainText(/Phone:/i);
  });
});
