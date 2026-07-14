import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';

export const E2E_AUTH_FILE = path.resolve(process.cwd(), 'tests/.auth/user.json');
export const E2E_TEST_EMAIL = process.env.E2E_TEST_USER_EMAIL ?? 'e2e-verifier@eightforge.test';

function password(): string {
  const value = process.env.E2E_TEST_USER_PASSWORD;
  if (!value) throw new Error('E2E_TEST_USER_PASSWORD is required. Run npm run seed:test-user after setting it.');
  return value;
}

export async function signIn(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="email"]').fill(E2E_TEST_EMAIL);
  await page.locator('input[type="password"]').fill(password());
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/platform(?:\/dashboard)?/, { timeout: 30_000 });
  await expect(page.locator('main')).toBeVisible({ timeout: 30_000 });
}

async function hasUsableSession(browser: Browser): Promise<boolean> {
  if (!existsSync(E2E_AUTH_FILE)) return false;

  const context = await browser.newContext({ storageState: E2E_AUTH_FILE });
  const page = await context.newPage();
  try {
    await page.goto('/platform/dashboard', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await expect(page.locator('main')).toBeVisible({ timeout: 30_000 });
    return !/\/login(?:\?|$)/.test(page.url());
  } catch {
    return false;
  } finally {
    await context.close();
  }
}

export async function refreshStorageState(browser: Browser): Promise<void> {
  await mkdir(path.dirname(E2E_AUTH_FILE), { recursive: true });
  if (await hasUsableSession(browser)) return;

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page);
    await rm(E2E_AUTH_FILE, { force: true });
    await context.storageState({ path: E2E_AUTH_FILE });
  } finally {
    await context.close();
  }
}

export async function reauthenticateIfRedirected(page: Page): Promise<boolean> {
  if (!/\/login(?:\?|$)/.test(page.url())) return false;

  await signIn(page);
  await mkdir(path.dirname(E2E_AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: E2E_AUTH_FILE });
  return true;
}
