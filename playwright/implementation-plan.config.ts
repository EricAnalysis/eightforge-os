import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';

config({ path: '.env.local' });

// Isolated browser verification: synthetic session and intercepted data only.
// Never run the repository's real-account auth setup for this display-only test.
export default defineConfig({
  testDir: '.',
  testMatch: 'implementation-plan.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  outputDir: '../output/playwright/implementation-plan-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3100',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
