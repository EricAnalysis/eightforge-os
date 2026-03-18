/**
 * global-setup.ts
 *
 * Logs in once and saves the authenticated browser state to
 * tests/.auth/user.json so smoke tests can reuse it without
 * re-authenticating for every test file.
 *
 * Required env vars:
 *   PLAYWRIGHT_TEST_EMAIL    – a real EightForge account email
 *   PLAYWRIGHT_TEST_PASSWORD – its password
 *
 * Usage: set these vars in .env.test.local (never commit them).
 */

import { test as setup, expect } from '@playwright/test';
import path from 'path';

const AUTH_FILE = path.join(__dirname, '.auth/user.json');

setup('authenticate', async ({ page }) => {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'PLAYWRIGHT_TEST_EMAIL and PLAYWRIGHT_TEST_PASSWORD must be set.\n' +
      'Add them to .env.test.local (never commit this file).',
    );
  }

  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');

  // Wait until the dashboard is visible
  await expect(page).toHaveURL('/platform', { timeout: 15_000 });
  await expect(page.locator('text=Operations overview')).toBeVisible();

  // Persist session to disk
  await page.context().storageState({ path: AUTH_FILE });
});
