import { test as setup } from '@playwright/test';
import { refreshStorageState } from './e2eAuth';

setup('refresh the durable E2E browser session', async ({ browser }) => {
  await refreshStorageState(browser);
});
