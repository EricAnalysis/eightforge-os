/**
 * smoke.spec.ts – EightForge top-5 smoke tests
 *
 * These tests run against a live Next.js dev server.
 * All tests except T1 use the authenticated session saved by global-setup.ts.
 *
 * Run: npx playwright test tests/smoke.spec.ts --project=chromium-smoke
 */

import { test, expect } from '@playwright/test';

// ─── T1: Auth wall ────────────────────────────────────────────────────────────
// A fresh (unauthenticated) browser context must be redirected to /login.
// This test intentionally bypasses the shared storageState.

test('T1: unauthenticated /platform redirects to /login', async ({ browser }) => {
  // browser.newContext() inside a project that has storageState configured will
  // inherit that state unless you explicitly clear it.  Pass empty storageState
  // and the baseURL so this context is truly unauthenticated.
  const ctx = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();

  await page.goto('/platform');

  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

  await ctx.close();
});

// ─── T2: Login → dashboard ────────────────────────────────────────────────────
// After supplying valid credentials the dashboard should load with the
// "Operations overview" heading and at least one summary card visible.

test('T2: login with valid credentials lands on dashboard', async ({ browser }) => {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL!;
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD!;

  // Fresh context — explicitly empty storageState so the test logs in from scratch
  // rather than reusing any inherited project-level session.
  const ctx = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();

  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');

  await expect(page).toHaveURL('/platform', { timeout: 15_000 });
  await expect(page.locator('h2:has-text("Operations overview")')).toBeVisible();

  // Use exact text match to avoid colliding with "My open decisions".
  // The dashboard has both; `getByText` with exact:true matches only the first card.
  await expect(page.getByText('Open decisions', { exact: true }).first()).toBeVisible();

  await ctx.close();
});

// ─── T3: Documents list renders without error ─────────────────────────────────
// The documents page should show the list container (or empty state) —
// not a red error banner and not an infinite spinner.

test('T3: documents page renders without error banner', async ({ page }) => {
  await page.goto('/platform/documents');

  // "Document list" label is always rendered (even while data is loading).
  // Wait for it first so we know the component mounted.
  await page.waitForSelector('text=Document list', { timeout: 10_000 });

  // Then wait for the Loading… spinner to disappear — this means the data
  // fetch (or empty state) has resolved.  Up to 15 s for the Supabase round-trip.
  await page.locator('text=Loading…').waitFor({ state: 'hidden', timeout: 15_000 });

  // No error banner should be present
  await expect(page.locator('text=Failed to load documents')).not.toBeVisible();

  // Either the table or the empty-state message should be visible
  const hasRows = await page.locator('table').isVisible();
  const hasEmpty = await page.locator('text=No documents yet').isVisible();
  expect(hasRows || hasEmpty).toBe(true);
});

// ─── T4: Decision status inline update ───────────────────────────────────────
// If decisions exist, changing the inline status select should succeed
// without showing an "Update failed" error message.
// If no decisions exist the test is skipped gracefully.

test('T4: inline decision status update succeeds', async ({ page }) => {
  await page.goto('/platform/decisions');

  // Wait for the list to resolve
  await page.waitForSelector('section', { timeout: 10_000 });

  const selects = page.locator('select[aria-label^="Update status"]');
  const count = await selects.count();

  if (count === 0) {
    test.skip(); // No decisions to test — skip rather than fail
    return;
  }

  const firstSelect = selects.first();
  const current = await firstSelect.inputValue();

  // Choose a different status to force an actual update
  const options = ['open', 'in_review', 'resolved', 'suppressed'];
  const next = options.find((o) => o !== current) ?? 'open';

  await firstSelect.selectOption(next);

  // Give the API a moment to respond
  await page.waitForTimeout(1500);

  // No inline error should be shown
  await expect(page.locator('text=Update failed').first()).not.toBeVisible();

  // The select should reflect the new value
  await expect(firstSelect).toHaveValue(next);
});

// ─── T5: Upload modal opens and closes ────────────────────────────────────────
// Clicking "Upload Document" should open the modal; pressing Cancel or
// clicking the backdrop should close it without leaving UI in broken state.

test('T5: upload modal open and cancel', async ({ page }) => {
  await page.goto('/platform/documents');

  // Wait for the upload button to be ready (org must resolve first)
  const uploadBtn = page.locator('button:has-text("Upload Document")');
  await expect(uploadBtn).toBeVisible({ timeout: 10_000 });
  await uploadBtn.click();

  // Modal title should appear (second "Upload Document" — the one in the modal header)
  const modalTitle = page.locator('span:has-text("Upload Document")');
  await expect(modalTitle).toBeVisible({ timeout: 5_000 });

  // The title input field should be visible
  await expect(page.locator('input[placeholder="e.g. Q1 Compliance Report"]')).toBeVisible();

  // Click Cancel
  await page.locator('button:has-text("Cancel")').click();

  // Modal should be gone
  await expect(page.locator('input[placeholder="e.g. Q1 Compliance Report"]')).not.toBeVisible();
});
