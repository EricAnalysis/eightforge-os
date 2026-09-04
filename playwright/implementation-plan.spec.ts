import { expect, test, type Page } from '@playwright/test';

const pin = {
  assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 3,
  reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 7,
};
const actorId = '33333333-3333-4333-8333-333333333333';
const provenance = {
  ...pin, sourceSubmissionId: '44444444-4444-4444-8444-444444444444',
  stepReviewId: '55555555-5555-4555-8555-555555555555', reviewerActorId: actorId,
  reviewerNotes: '  Keep the exact reviewer note.\n',
};
const plan = {
  domain: 'eightforge.implementation-plan', schemaVersion: 1,
  authority: 'non_authoritative', executable: false, grantsExecutionAuthority: false,
  source: { pin, effectiveReviewedSpecificationDigestSha256: 'a'.repeat(64) },
  plannedSteps: [{
    stepId: 'included-advisory', originalClassification: 'ADVISORY',
    effectiveClassification: 'ADVISORY', disposition: 'accepted',
    specification: { description: '  Exact advisory specification.\n' },
    specificationSource: { mode: 'accepted_as_proposed', sourceField: 'workflow_assessments.assessment',
      details: [{ collection: 'advisorySteps', identityField: 'advisoryId', detailId: 'advisory-detail' }] },
    provenance, implementationReadiness: { state: 'specification_complete' },
  }],
  rejectedSteps: [{
    stepId: 'excluded-advisory', originalClassification: 'ADVISORY', disposition: 'rejected',
    effectiveClassification: null, effectiveSpecification: null, specificationSource: null,
    provenance: { ...provenance, stepReviewId: '66666666-6666-4666-8666-666666666666' },
  }],
  digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1', value: 'b'.repeat(64) },
};
const query = new URLSearchParams({ assessmentVersion: '3', reviewId: pin.reviewId, reviewVersion: '7' });
const reviewPath = `/platform/workflows/reviews/${pin.assessmentId}`;
const planPath = `${reviewPath}/implementation-plan?${query}`;

async function session(page: Page) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) throw new Error('Build/runtime NEXT_PUBLIC_SUPABASE_URL required for intercepted auth test');
  const user = { id: actorId, aud: 'authenticated', role: 'authenticated', email: 'operator@example.test',
    app_metadata: {}, user_metadata: {}, created_at: '2026-09-04T00:00:00Z' };
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: actorId, aud: 'authenticated', role: 'authenticated', exp: expiry })}.synthetic-signature`;
  const storageKey = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: storageKey, value: { access_token: accessToken, refresh_token: 'synthetic-refresh',
      expires_at: expiry, expires_in: 3600, token_type: 'bearer', user },
  });
  const unexpected: string[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Existing app typography requests Google Fonts. Stub the stylesheet so
    // browser verification remains offline; do not allow any external traffic.
    if (url.hostname === 'fonts.googleapis.com' && url.pathname === '/css2') {
      await route.fulfill({ contentType: 'text/css', body: '' }); return;
    }
    if (url.pathname === '/auth/v1/user') {
      await route.fulfill({ json: user }); return;
    }
    if (url.pathname === '/rest/v1/user_profiles') {
      await route.fulfill({ json: { organization_id: 'fixture-org', role: 'operator',
        organizations: { id: 'fixture-org', name: 'Read-only verification' } } }); return;
    }
    if (['localhost', '127.0.0.1'].includes(url.hostname) && !url.pathname.startsWith('/api/')) {
      await route.continue(); return;
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    await route.abort();
  });
  return { unexpected, accessToken };
}

test('recorded review navigates to a pinned display with loading, exclusions, identity and back navigation', async ({ page }) => {
  const { unexpected, accessToken } = await session(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/internal/workflow-assessments/*/review', (route) => route.fulfill({ json: { ok: true, packet: {
    ...pin, createdAt: '2026-09-04T00:00:00Z', authority: 'non_authoritative', requiresHumanReview: true,
    intake: {}, assessment: { summary: 'Recorded fixture workflow', workflowSteps: [] },
    existingReview: { reviewId: pin.reviewId, reviewVersion: pin.reviewVersion,
      overallDisposition: 'changes_required', createdAt: '2026-09-04T00:00:00Z', stepReviews: [] },
  } } }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/internal/workflow-assessments/*/implementation-plan?*', async (route) => {
    expect(route.request().method()).toBe('GET');
    expect(route.request().postData()).toBeNull();
    expect(route.request().headers().authorization).toBe(`Bearer ${accessToken}`);
    expect(new URL(route.request().url()).searchParams.toString()).toBe(query.toString());
    await gate;
    await route.fulfill({ json: { ok: true, plan } });
  });
  await page.goto(reviewPath);
  const link = page.getByRole('link', { name: 'View implementation plan' });
  await expect(link).toHaveAttribute('href', planPath);
  await link.click();
  await expect(page.getByText(/Loading implementation plan/)).toBeVisible();
  release();
  const surface = page.getByTestId('implementation-plan-surface');
  await expect(surface.getByRole('heading', { name: /^included-advisory/ })).toBeVisible();
  await expect(surface.getByText('excluded-advisory', { exact: true })).toBeVisible();
  await expect(surface.getByText('Specification complete does not authorize execution', { exact: false })).toBeVisible();
  await expect(surface.getByText('specification_complete', { exact: true })).toBeVisible();
  await expect(surface.getByText(/Rejected steps.*excluded from this plan/)).toBeVisible();
  await surface.getByText('Audit provenance', { exact: true }).first().click();
  await expect(surface.getByText(provenance.stepReviewId, { exact: true })).toBeVisible();
  await surface.getByText('Identity digest details', { exact: true }).click();
  await expect(surface.getByText(plan.digest.value, { exact: true })).toBeVisible();
  await expect(surface.getByText(plan.source.effectiveReviewedSpecificationDigestSha256, { exact: true })).toBeVisible();
  const mutation = /^(Run|Execute|Deploy|Activate|Publish|Generate Codex Prompt|Create Rule|Create Task|Apply|Implement)$/i;
  await expect(surface.getByRole('button', { name: mutation })).toHaveCount(0);
  await expect(surface.getByRole('link', { name: mutation })).toHaveCount(0);
  await surface.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'output/playwright/implementation-plan-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(surface.getByRole('heading', { name: /^included-advisory/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/playwright/implementation-plan-mobile.png', fullPage: true });
  await page.goBack();
  await expect(link).toBeVisible();
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test('historical errors retry the same pin, mismatches refuse display, and all-rejected remains inspectable', async ({ page }) => {
  const { unexpected } = await session(page);
  let response: unknown = { ok: false, error: 'proposal_not_composable' };
  let status = 422;
  const requested: string[] = [];
  await page.route('**/api/internal/workflow-assessments/*/implementation-plan?*', async (route) => {
    requested.push(route.request().url());
    await route.fulfill({ status, json: response });
  });
  await page.goto(planPath);
  const surface = page.getByTestId('implementation-plan-surface');
  await expect(surface.getByText(/historical|incompatible/i).first()).toBeVisible();
  status = 200;
  response = { ok: true, plan: { ...plan,
    source: { ...plan.source, pin: { ...pin, reviewVersion: 8 } },
    plannedSteps: plan.plannedSteps.map((step) => ({ ...step, provenance: { ...step.provenance, reviewVersion: 8 } })),
    rejectedSteps: plan.rejectedSteps.map((step) => ({ ...step, provenance: { ...step.provenance, reviewVersion: 8 } })),
  } };
  await surface.getByRole('button', { name: /retry/i }).click();
  await expect(surface.getByText(/incompatible/i).first()).toBeVisible();
  await expect(surface.getByRole('heading', { name: /^included-advisory/ })).toHaveCount(0);
  response = { ok: true, plan: { ...plan, plannedSteps: [] } };
  await surface.getByRole('button', { name: /retry/i }).click();
  await expect(surface.getByText(/all steps were rejected/i)).toBeVisible();
  await expect(surface.getByText('excluded-advisory', { exact: true })).toBeVisible();
  expect(new Set(requested).size).toBe(1);
  expect(requested).toHaveLength(3);
  expect(unexpected).toEqual([]);
});
