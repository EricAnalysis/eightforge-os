import { expect, test } from '@playwright/test';

test('reviewer can select exact tokens, navigate, resume, and reject stale state', async ({ page }) => {
  await page.goto('/evaluation/forgewing/a3-linkage');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await expect(page.getByText('A3 exact label linkage review')).toBeVisible();
  await expect(page.getByText('Label 1 / 6')).toBeVisible();
  const tokens = page.locator('[data-testid^="token-"]');
  await expect(tokens).toHaveCount(5);
  await expect(page.locator('[data-testid^="bbox-"]')).toHaveCount(5);

  const first = tokens.nth(0);
  const firstTestId = await first.getAttribute('data-testid');
  const observationId = firstTestId!.slice('token-'.length);
  const bbox = page.getByTestId(`bbox-${observationId}`);

  await first.hover();
  await expect(bbox).toHaveAttribute('stroke-opacity', '1');
  await first.click();
  await expect(first).toHaveAttribute('data-selected', 'true');
  await expect(bbox).toHaveAttribute('data-selected', 'true');
  await bbox.click();
  await expect(first).toHaveAttribute('data-selected', 'false');

  await tokens.nth(0).click();
  await tokens.nth(1).click();
  await expect(page.getByText('Selected tokens:').locator('strong')).toHaveText('2');
  await page.getByRole('button', { name: 'LINKED', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Label 2 / 6')).toBeVisible();
  await expect(page.getByText('1 / 6')).toBeVisible();

  await page.reload();
  await expect(page.getByText('Label 2 / 6')).toBeVisible();
  await page.evaluate(() => {
    const key = 'eightforge:a3-linkage-review:v1';
    const saved = JSON.parse(window.localStorage.getItem(key)!);
    saved.freezeIdentity.extractionSnapshotId = 'stale-snapshot';
    window.localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.getByText(/REVIEW SESSION INVALID/)).toBeVisible();
  await expect(page.getByText('Label 1 / 6')).toBeVisible();
});
