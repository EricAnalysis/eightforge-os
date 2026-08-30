import { describe, expect, it, vi } from 'vitest';

import {
  beginWorkflowIntakeSubmission,
  buildWorkflowIntakeRequestBody,
  endWorkflowIntakeSubmission,
  submitWorkflowIntake,
  WORKFLOW_INTAKE_ENDPOINT,
} from '@/components/landing/WorkflowIntakeDialog';

const ANSWERS = [
  'Reviewing contractor invoices against rate schedules.',
  'Invoices, rate schedules, approved work orders.',
  'A reviewer compares billed rates to the contract rate.',
  '40 packages each week, averaging 12 documents each.',
  'Mismatches are escalated to the project manager.',
  'Final approval of any payment adjustment.',
];

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('workflow intake request body', () => {
  it('sends exactly the six intake fields in the dialog order', () => {
    const body = buildWorkflowIntakeRequestBody(ANSWERS);
    expect(Object.keys(body)).toEqual([
      'workflowDescription', 'documentsInvolved', 'manualChecks',
      'frequencyAndVolume', 'exceptions', 'humanDecisions',
    ]);
    expect(body.workflowDescription).toBe(ANSWERS[0]);
    expect(body.humanDecisions).toBe(ANSWERS[5]);
  });

  it('never sends a caller-controlled identity or organization', () => {
    const body = buildWorkflowIntakeRequestBody(ANSWERS) as Record<string, unknown>;
    for (const forbidden of ['id', 'submissionId', 'organizationId', 'organization_id', 'schemaVersion']) {
      expect(forbidden in body).toBe(false);
    }
    expect(Object.keys(body)).toHaveLength(6);
  });

  it('posts JSON to the intake endpoint with the exact expected body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { submissionId: 'sub-1' }));
    await submitWorkflowIntake(ANSWERS, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(WORKFLOW_INTAKE_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      workflowDescription: ANSWERS[0],
      documentsInvolved: ANSWERS[1],
      manualChecks: ANSWERS[2],
      frequencyAndVolume: ANSWERS[3],
      exceptions: ANSWERS[4],
      humanDecisions: ANSWERS[5],
    });
  });
});

describe('workflow intake submission outcomes', () => {
  it('acknowledges a successful submission', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { submissionId: 'sub-1' }));
    await expect(submitWorkflowIntake(ANSWERS, fetchImpl as unknown as typeof fetch))
      .resolves.toEqual({ status: 'submitted' });
  });

  it('does not report success for a rejected or unavailable response', async () => {
    for (const status of [400, 403]) {
      const fetchImpl = vi.fn(async () => jsonResponse(status, { error: 'exceptions is required' }));
      await expect(submitWorkflowIntake(ANSWERS, fetchImpl as unknown as typeof fetch))
        .resolves.toEqual({ status: 'rejected' });
    }
    for (const status of [500, 503, 502]) {
      const fetchImpl = vi.fn(async () => jsonResponse(status, { error: 'relation denied' }));
      await expect(submitWorkflowIntake(ANSWERS, fetchImpl as unknown as typeof fetch))
        .resolves.toEqual({ status: 'unavailable' });
    }
  });

  it('treats a network failure as unavailable rather than success', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    await expect(submitWorkflowIntake(ANSWERS, fetchImpl as unknown as typeof fetch))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('never surfaces server-supplied error detail to the caller', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {
      error: 'relation "workflow_intake_submissions" permission denied',
    }));
    const result = await submitWorkflowIntake(ANSWERS, fetchImpl as unknown as typeof fetch);
    expect(JSON.stringify(result)).not.toContain('permission denied');
    expect(JSON.stringify(result)).not.toContain('workflow_intake_submissions');
    expect(Object.keys(result)).toEqual(['status']);
  });
});

describe('workflow intake single-flight guard', () => {
  it('rejects a second submission while the first is in flight', () => {
    const lock = { current: false };
    expect(beginWorkflowIntakeSubmission(lock)).toBe(true);
    expect(beginWorkflowIntakeSubmission(lock)).toBe(false);
    endWorkflowIntakeSubmission(lock);
    expect(beginWorkflowIntakeSubmission(lock)).toBe(true);
  });

  it('issues one request for a double click and one more after it settles', async () => {
    const lock = { current: false };
    const fetchImpl = vi.fn(async () => jsonResponse(201, { submissionId: 'sub-1' }));
    const click = async () => {
      if (!beginWorkflowIntakeSubmission(lock)) return;
      try {
        await submitWorkflowIntake(ANSWERS, fetchImpl as unknown as typeof fetch);
      } finally {
        endWorkflowIntakeSubmission(lock);
      }
    };

    await Promise.all([click(), click()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await click();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('workflow intake stays a persistence-only path', () => {
  it('has no provider, assessment, notification, or read behavior in the client module', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('components/landing/WorkflowIntakeDialog.tsx', 'utf8'));

    for (const forbidden of [
      'anthropic', 'openai', 'claude', 'forgewing/', 'WorkflowDefinition',
      'WorkflowAssessment', 'sendMail', 'slack', 'webhook',
    ]) {
      expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // POST is the only verb the dialog uses: there is no read path to call.
    expect(source).not.toMatch(/method:\s*'(GET|PUT|PATCH|DELETE)'/);
    expect(source.match(/method:\s*'POST'/g)).toHaveLength(1);
  });
});
