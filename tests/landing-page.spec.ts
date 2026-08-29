import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(60_000);

const viewports = [
  { name: 'desktop', width: 1680, height: 940 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

for (const viewport of viewports) {
  test(`public landing page matches the approved ${viewport.name} hierarchy`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Turn document-heavy work into operational outcomes.',
    );
    await expect(page.getByText('Operational Systems Platform', { exact: true })).toBeVisible();
    await expect(page.getByTestId('operating-model-visual')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/platform');
    await expect(page.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/platform/documents');
    await expect(page.getByRole('link', { name: 'Decisions' })).toHaveAttribute('href', '/platform/decisions');

    const cta = page.getByRole('button', { name: 'Describe Your Workflow' });
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByLabel('What document-review workflow costs your team the most time?'),
    ).toBeVisible();
    await expect(page.getByText('This preview stays in your browser.', { exact: false })).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );

    await page.getByRole('button', { name: 'Close workflow assessment' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.screenshot({
      path: `output/playwright/landing-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
