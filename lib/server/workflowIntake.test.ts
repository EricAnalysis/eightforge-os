import { describe, expect, it, vi } from 'vitest';

import { handleWorkflowIntakeRequest } from '@/app/api/workflow-intake/route';
import {
  persistWorkflowIntakeSubmission,
  validateWorkflowIntakeSubmission,
  WORKFLOW_INTAKE_MAX_ANSWER_LENGTH,
  WORKFLOW_INTAKE_SCHEMA_VERSION,
  WORKFLOW_INTAKE_TABLE,
  type WorkflowIntakeAnswers,
} from '@/lib/server/workflowIntake';

function answers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowDescription: 'Reviewing contractor invoices against rate schedules.',
    documentsInvolved: 'Invoices, rate schedules, approved work orders.',
    manualChecks: 'A reviewer compares billed rates to the contract rate.',
    frequencyAndVolume: '40 packages each week, averaging 12 documents each.',
    exceptions: 'Mismatches are escalated to the project manager.',
    humanDecisions: 'Final approval of any payment adjustment.',
    ...overrides,
  };
}

function request(body: unknown): Request {
  return new Request('https://example.test/api/workflow-intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const human = async () => ({ isBot: false });

describe('workflow intake validation', () => {
  it('accepts a complete submission and trims every answer', () => {
    const result = validateWorkflowIntakeSubmission(
      answers({ workflowDescription: '  Reviewing invoices.  ' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answers.workflowDescription).toBe('Reviewing invoices.');
      expect(Object.keys(result.answers)).toHaveLength(6);
    }
  });

  it('rejects every missing, blank, non-string, and oversized answer', () => {
    const fields = [
      'workflowDescription', 'documentsInvolved', 'manualChecks',
      'frequencyAndVolume', 'exceptions', 'humanDecisions',
    ] as const;
    for (const field of fields) {
      const missing = answers();
      delete missing[field];
      expect(validateWorkflowIntakeSubmission(missing)).toMatchObject({ ok: false });
      expect(validateWorkflowIntakeSubmission(answers({ [field]: '   ' })))
        .toMatchObject({ ok: false });
      expect(validateWorkflowIntakeSubmission(answers({ [field]: 42 })))
        .toMatchObject({ ok: false });
      expect(validateWorkflowIntakeSubmission(
        answers({ [field]: 'x'.repeat(WORKFLOW_INTAKE_MAX_ANSWER_LENGTH + 1) }),
      )).toMatchObject({ ok: false });
    }
  });

  it('rejects a non-object body and any unexpected field', () => {
    expect(validateWorkflowIntakeSubmission(null)).toMatchObject({ ok: false });
    expect(validateWorkflowIntakeSubmission([])).toMatchObject({ ok: false });
    expect(validateWorkflowIntakeSubmission('text')).toMatchObject({ ok: false });
    // A caller must not be able to smuggle a column the browser does not own.
    expect(validateWorkflowIntakeSubmission(answers({ organizationId: 'org-1' })))
      .toMatchObject({ ok: false });
    expect(validateWorkflowIntakeSubmission(answers({ id: 'chosen-id' })))
      .toMatchObject({ ok: false });
  });
});

describe('workflow intake persistence', () => {
  function fakeAdmin() {
    const insert = vi.fn(async (_row: Record<string, unknown>) => ({ error: null }));
    const from = vi.fn(() => ({ insert }));
    return { admin: { from } as never, from, insert };
  }

  const validAnswers = (validateWorkflowIntakeSubmission(answers()) as {
    ok: true; answers: WorkflowIntakeAnswers;
  }).answers;

  it('appends a server-generated identity and never an organization', async () => {
    const { admin, from, insert } = fakeAdmin();
    const result = await persistWorkflowIntakeSubmission(validAnswers, { admin });

    expect(result).toMatchObject({ status: 'persisted' });
    expect(from).toHaveBeenCalledWith(WORKFLOW_INTAKE_TABLE);
    const row = insert.mock.calls[0]![0];
    expect(row.schema_version).toBe(WORKFLOW_INTAKE_SCHEMA_VERSION);
    expect(row.workflow_description).toBe(validAnswers.workflowDescription);
    expect(row.human_decisions).toBe(validAnswers.humanDecisions);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect('organization_id' in row).toBe(false);
    if (result.status === 'persisted') expect(result.submissionId).toBe(row.id);
  });

  it('reports missing configuration instead of throwing', async () => {
    await expect(persistWorkflowIntakeSubmission(validAnswers, { admin: null }))
      .resolves.toEqual({ status: 'not_configured' });
  });

  it('surfaces an insert failure as a contained result', async () => {
    const insert = vi.fn(async () => ({ error: { message: 'permission denied' } }));
    const admin = { from: vi.fn(() => ({ insert })) } as never;
    await expect(persistWorkflowIntakeSubmission(validAnswers, { admin }))
      .resolves.toMatchObject({ status: 'failed', reason: 'permission denied' });
  });
});

describe('workflow intake route', () => {
  it('acknowledges a human submission with only a submission id', async () => {
    const persist = vi.fn(async () => ({ status: 'persisted' as const, submissionId: 'sub-1' }));
    const response = await handleWorkflowIntakeRequest(request(answers()), {
      verify: human, persist,
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ submissionId: 'sub-1' });
  });

  it('denies a detected bot before parsing or persisting', async () => {
    const persist = vi.fn();
    const response = await handleWorkflowIntakeRequest(request(answers()), {
      verify: async () => ({ isBot: true }), persist,
    });
    expect(response.status).toBe(403);
    expect(persist).not.toHaveBeenCalled();
  });

  it('fails closed when bot classification itself throws', async () => {
    const persist = vi.fn();
    const response = await handleWorkflowIntakeRequest(request(answers()), {
      verify: async () => { throw new Error('botid unavailable'); }, persist,
    });
    expect(response.status).toBe(403);
    expect(persist).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and invalid payloads without persisting', async () => {
    const persist = vi.fn();
    const malformed = await handleWorkflowIntakeRequest(request('{not json'), {
      verify: human, persist,
    });
    expect(malformed.status).toBe(400);

    const incomplete = await handleWorkflowIntakeRequest(
      request(answers({ exceptions: '' })), { verify: human, persist },
    );
    expect(incomplete.status).toBe(400);
    expect(persist).not.toHaveBeenCalled();
  });

  it('returns a generic failure without leaking the database reason', async () => {
    const response = await handleWorkflowIntakeRequest(request(answers()), {
      verify: human,
      persist: async () => ({ status: 'failed' as const, reason: 'relation "secret" denied' }),
    });
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Could not record submission');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('reports unconfigured storage as 503', async () => {
    const response = await handleWorkflowIntakeRequest(request(answers()), {
      verify: human, persist: async () => ({ status: 'not_configured' as const }),
    });
    expect(response.status).toBe(503);
  });
});
