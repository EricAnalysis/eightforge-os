import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';

// Load test credentials from .env.test.local (never committed to git)
config({ path: '.env.test.local', override: false });

/**
 * EightForge Playwright configuration.
 *
 * Run all smoke tests:  npx playwright test
 * Run a single file:    npx playwright test tests/smoke.spec.ts
 * View report:          npx playwright show-report
 *
 * Authentication: the setup project refreshes tests/.auth/user.json and
 * authenticated browser projects reuse that storage state.
 */

export default defineConfig({
  testDir: '.',
  // This repository may contain nested assistant worktrees. They are not part
  // of this checkout's test suite and can resolve a second Playwright copy.
  testIgnore: ['**/.claude/**'],
  fullyParallel: false,      // run sequentially so auth setup completes first
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? 'github' : 'html',

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    /**
     * Setup project: logs in once and saves session to disk.
     * All other projects depend on this completing first.
     */
    {
      name: 'setup',
      testMatch: 'playwright/auth.setup.ts',
    },
    {
      name: 'chromium-smoke',
      use: {
        ...devices['Desktop Chrome'],
        // Reuse the authenticated session saved by the setup project.
        storageState: 'tests/.auth/user.json',
      },
      testMatch: 'tests/**/*.spec.ts',
      dependencies: ['setup'],
    },
  ],
});
