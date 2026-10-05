/** Run: npx vite-node --config vitest.config.ts scripts/evaluation/b44/run.ts */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { handle, impacts, PROJECT, reset, trace } from './fixture';

const fixtureRoot = path.resolve('scripts/evaluation/b44');
const repositoryRoot = path.resolve('.');
const output = path.join(os.tmpdir(), `eightforge-b44-browser-${Date.now()}`);
await mkdir(output, { recursive: true });
console.log(`B4.4 browser artifacts: ${output}`);
const server = await createServer({ configFile: false, root: fixtureRoot,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: [
    { find: 'next/link', replacement: path.join(fixtureRoot, 'link.tsx') },
    { find: '@/lib/supabaseClient', replacement: path.join(fixtureRoot, 'supabaseClient.ts') },
    { find: '@/components/recovery/SourceEvidencePage', replacement: path.join(fixtureRoot, 'sourceEvidencePage.tsx') },
    { find: '@', replacement: repositoryRoot },
  ] },
  server: { host: '127.0.0.1', port: 43144, strictPort: true, fs: { allow: [repositoryRoot] } },
  plugins: [{ name: 'local-fixture-api', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/api/')) return next();
      try {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const result = await handle(req.method ?? 'GET', req.url, raw ? JSON.parse(raw) : {});
        res.statusCode = result.status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result.body));
      } catch (error) {
        console.error(error); res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: String(error) }));
      }
    });
  } }],
});
await server.listen();
const windowsChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const chromeExecutable = process.env.B44_CHROME_EXECUTABLE || (existsSync(windowsChrome) ? windowsChrome : undefined);
const browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(90000);
page.setDefaultNavigationTimeout(90000);
const browserErrors: string[] = [];
page.on('pageerror', (error) => browserErrors.push(error.message));
const proofs: Record<string, unknown>[] = [];
const origin = `http://127.0.0.1:43144`;
const writes = () => trace.filter((call) => call.method === 'POST' && call.url.endsWith('/region-assertions'));
async function open() { await page.goto(origin); await expect(page.getByTestId('resolution-workspace')).toBeVisible(); }
async function ask() {
  await page.getByRole('button', { name: 'Ask Forgewing to read this region', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use suggestion', exact: true })).toBeVisible();
  await expect(page.getByTestId('forgewing-value-reading').getByText('$8.75', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'description', exact: true })).toHaveValue('');
}
async function snapshot(name: string) {
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  proofs.push({ name, calls: structuredClone(trace), impacts: structuredClone(impacts) });
}
try {
  for (const edited of [false, true]) {
    reset(); await open(); await ask();
    const originalCase = await page.locator('button[aria-current="true"]').getAttribute('data-case-id');
    const beforeUse = structuredClone(trace);
    await page.getByRole('button', { name: 'Use suggestion', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'description', exact: true })).toHaveValue('Hauling');
    await expect(page.getByRole('textbox', { name: 'unit', exact: true })).toHaveValue('TON');
    await expect(page.getByRole('textbox', { name: 'rate', exact: true })).toHaveValue('8.75');
    await expect(page.getByRole('textbox', { name: 'category', exact: true })).toHaveValue('hauling');
    expect(trace).toEqual(beforeUse); expect(writes()).toHaveLength(0);
    if (edited) await page.getByRole('textbox', { name: 'rate', exact: true }).fill('9.25');
    await page.getByRole('button', { name: 'Preview impact', exact: true }).click();
    await expect(page.getByTestId('resolution-impact-available')).toBeVisible();
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toMatchObject({ status: 'available', caseId: originalCase, actionKind: 'enter_reviewed_value' });
    expect(writes()).toHaveLength(0);
    await snapshot(edited ? 'modified-draft-impact' : 'selected-draft-impact');
    await page.getByRole('textbox', { name: 'reason', exact: true }).fill('Read the synthetic source region and verified every field.');
    await page.getByRole('button', { name: 'Save & next', exact: true }).click();
    await expect(page.getByText('Nothing to resolve.', { exact: true })).toBeVisible();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.body).toMatchObject({ forgewingProposalId: expect.stringMatching(/^forgewing-proposal-value-reading-/),
      value: { description: 'Hauling', unit_type: 'TON', rate_amount: edited ? 9.25 : 8.75, category: 'hauling' } });
    await page.goto(`${origin}/reviewed`);
    await expect(page.getByRole('heading', { name: 'Human-reviewed values', exact: true })).toBeVisible();
    await expect(page.getByText(`Human-reviewed: Hauling · TON · $${edited ? '9.25' : '8.75'} · assertion fixture-assertion`, { exact: true }).first()).toBeVisible();
    await snapshot(edited ? 'modified-reviewed-visible' : 'reviewed-visible');
  }

  for (const disposition of ['Reject', 'Defer']) {
    reset(); await open(); await ask();
    const originalCase = await page.locator('button[aria-current="true"]').getAttribute('data-case-id');
    await page.getByRole('button', { name: 'Use suggestion', exact: true }).click();
    await page.getByRole('textbox', { name: 'visual reading rationale', exact: true }).fill('Synthetic review rationale.');
    await page.getByRole('button', { name: `${disposition} reading`, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Use suggestion', exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'description', exact: true })).toHaveValue('');
    expect(await page.locator('button[aria-current="true"]').getAttribute('data-case-id')).toBe(originalCase);
    expect(writes()).toHaveLength(0);
    await snapshot(`${disposition.toLowerCase()}-remains-unresolved`);
  }

  reset({ staleReview: true }); await open(); await ask();
  await page.getByRole('button', { name: 'Use suggestion', exact: true }).click();
  await page.getByRole('textbox', { name: 'visual reading rationale', exact: true }).fill('Stale reading fixture.');
  await page.getByRole('button', { name: 'Reject reading', exact: true }).click();
  await expect(page.getByText(/The case has been refreshed; review it again/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'description', exact: true })).toHaveValue('');
  expect(writes()).toHaveLength(0); await snapshot('stale-refresh-clears-draft');
  for (const [field, value] of Object.entries({ description: 'Manual after stale', unit: 'TON', rate: '7', category: 'hauling', reason: 'Reviewed current source after stale refresh' })) {
    await page.getByRole('textbox', { name: field, exact: true }).fill(value);
  }
  await page.getByRole('button', { name: 'Save & next', exact: true }).click();
  await expect(page.getByText('Nothing to resolve.', { exact: true })).toBeVisible();
  expect(writes()[0]!.body).not.toHaveProperty('forgewingProposalId'); await snapshot('stale-followup-manual-has-no-citation');

  for (const outcome of ['unreadable', 'provider_failed', 'budget_exhausted'] as const) {
    reset({ outcome }); await open();
    await page.getByRole('button', { name: 'Ask Forgewing to read this region', exact: true }).click();
    await expect(page.getByTestId('value-reading-outcome')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use suggestion', exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'description', exact: true })).toHaveValue('');
    expect(writes()).toHaveLength(0); await snapshot(outcome);
  }

  reset({ forgewing: false }); await open();
  await expect(page.getByTestId('forgewing-value-reading')).toHaveCount(0);
  await expect(page.getByText(/Forgewing/)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'description', exact: true })).toHaveValue('');
  for (const [field, value] of Object.entries({ description: 'Manual hauling', unit: 'TON', rate: '7', category: 'hauling', reason: 'Manual source review' })) {
    await page.getByRole('textbox', { name: field, exact: true }).fill(value);
  }
  await page.getByRole('button', { name: 'Save & next', exact: true }).click();
  await expect(page.getByText('Nothing to resolve.', { exact: true })).toBeVisible();
  expect(writes()[0]!.body).not.toHaveProperty('forgewingProposalId'); await snapshot('core-manual-entry');
  expect(browserErrors).toEqual([]);
  const report = { status: 'passed', fixtureTransportOnly: true, validator: 'Actual previewResolutionImpact with default validateInMemory; no injected Validator or impact counts',
    persistenceLimit: 'Local in-memory assertion transport uses actual parse/prepare/chain checks and resolution. B3 SQL origin derivation and database persistence require the separate SQL gate.',
    providerCalls: 0, databaseCalls: 0, browserErrors, project: PROJECT, proofs };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'passed', scenarios: proofs.length, artifacts: output }));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', error: String(error), fixtureTransportOnly: true,
    browserErrors, proofs, currentTrace: trace, currentImpacts: impacts }, null, 2));
  console.error(`B4.4 browser failure artifacts: ${output}`);
  throw error;
} finally { await browser.close(); await server.close(); }
