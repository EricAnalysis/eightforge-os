import { describe, expect, it, vi } from 'vitest';

import { handleWorkflowIntakeRequest } from '@/app/api/workflow-intake/route';
import { loadWorkflowIntakeSubmission } from '@/lib/server/workflowIntakeRead';
import {
  persistWorkflowIntakeSubmission,
  validateWorkflowIntakeSubmission,
  WORKFLOW_INTAKE_MAX_ANSWER_LENGTH,
  type WorkflowIntakeAnswers,
} from '@/lib/server/workflowIntake';

function answers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowDescription: 'Reviewing contractor invoices against rate schedules.',
    informationOrSystems: 'Invoices, rate schedules, approved work orders.',
    manualChecks: 'A reviewer compares billed rates to the contract rate.',
    frequencyAndVolume: '40 packages each week, averaging 12 documents each.',
    exceptions: 'Mismatches are escalated to the project manager.',
    humanDecisions: 'Final approval of any payment adjustment.',
    successOutcome: 'Every invoice is checked and exceptions receive human review.',
    ...overrides,
  };
}

function request(body: unknown): Request {
  return new Request('https://example.test/api/workflow-intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify({ ...(body as object), draftId: DRAFT }),
  });
}

const ACTOR = { actorId: '22222222-2222-4222-8222-222222222222', organizationId: '33333333-3333-4333-8333-333333333333', displayName: null, role: 'member', email: null };
const DRAFT = '11111111-1111-4111-8111-111111111111';
const authenticated = async () => ({ ok: true as const, actor: ACTOR });
const human = async () => ({ isBot: false });

describe('workflow intake validation', () => {
  it('accepts a workflow involving systems and data without documents', () => {
    const result = validateWorkflowIntakeSubmission(answers({
      workflowDescription: 'Compare CRM and scheduling statuses every morning.',
      informationOrSystems: 'CRM database, scheduling SaaS, API, and manager queue.',
      manualChecks: 'Compare customer status and assigned appointment.',
      humanDecisions: 'Managers resolve ambiguous statuses.',
      successOutcome: 'The correct system is updated and ambiguous cases are reviewed.',
    }));
    expect(result.ok).toBe(true);
  });
  it('accepts a complete submission and trims every answer', () => {
    const result = validateWorkflowIntakeSubmission(
      answers({ workflowDescription: '  Reviewing invoices.  ' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answers.workflowDescription).toBe('Reviewing invoices.');
      expect(Object.keys(result.answers)).toHaveLength(7);
    }
  });

  it('rejects every missing, blank, non-string, and oversized answer', () => {
    const fields = [
      'workflowDescription', 'informationOrSystems', 'manualChecks',
      'frequencyAndVolume', 'exceptions', 'humanDecisions', 'successOutcome',
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
  const validAnswers = (validateWorkflowIntakeSubmission(answers()) as { ok: true; answers: WorkflowIntakeAnswers }).answers;
  it('submits a known draft using server-owned actor and organization', async () => {
    const rpc = vi.fn(async () => ({ data: DRAFT, error: null }));
    const result = await persistWorkflowIntakeSubmission(validAnswers, ACTOR, DRAFT, { admin: { rpc } as never });
    expect(result).toEqual({ status: 'persisted', submissionId: DRAFT });
    expect(rpc).toHaveBeenCalledWith('submit_workflow_assessment_draft', {
      p_draft_id: DRAFT, p_actor_id: ACTOR.actorId, p_organization_id: ACTOR.organizationId, p_answers: validAnswers,
    });
  });
  it('reports missing configuration instead of throwing', async () => {
    await expect(persistWorkflowIntakeSubmission(validAnswers, ACTOR, DRAFT, { admin: null })).resolves.toEqual({ status: 'not_configured' });
  });
  it('contains ownership or database rejection', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'draft not owned' } }));
    await expect(persistWorkflowIntakeSubmission(validAnswers, ACTOR, DRAFT, { admin: { rpc } as never })).resolves.toMatchObject({ status: 'failed' });
  });
});

describe('versioned immutable intake reads', () => {
  const historical = {
    id: 'historical', schema_version: 'workflow_intake_v1',
    workflow_description: 'Review invoices.', documents_involved: 'Invoices and contracts.',
    manual_checks: 'Compare rates.', frequency_and_volume: 'Weekly.',
    exceptions: 'Escalate.', human_decisions: 'Approve payment.',
    information_or_systems: null, success_outcome: null,
  };
  function adminFor(row: unknown) {
    return { rpc: vi.fn(async () => ({ data: [row], error: null })) } as never;
  }
  it('retains exact v1 answers and identity without adding or inferring v2 answers', async () => {
    const original = JSON.stringify(historical);
    const loaded = await loadWorkflowIntakeSubmission('historical', adminFor(historical));
    expect(loaded?.submissionSchemaVersion).toBe('workflow_intake_v1');
    expect(loaded?.answers).toEqual({
      workflowDescription: 'Review invoices.', documentsInvolved: 'Invoices and contracts.',
      manualChecks: 'Compare rates.', frequencyAndVolume: 'Weekly.',
      exceptions: 'Escalate.', humanDecisions: 'Approve payment.',
    });
    expect(JSON.stringify(historical)).toBe(original);
    expect(Object.isFrozen(loaded?.answers)).toBe(true);
  });
  it('reads all seven v2 answers without relabeling the historical document field', async () => {
    const loaded = await loadWorkflowIntakeSubmission('historical', adminFor({
      ...historical, schema_version: 'workflow_intake_v2', documents_involved: null,
      information_or_systems: 'CRM and scheduling API.', success_outcome: 'Statuses agree.',
    }));
    expect(loaded?.submissionSchemaVersion).toBe('workflow_intake_v2');
    expect(loaded?.answers).toMatchObject({ informationOrSystems: 'CRM and scheduling API.', successOutcome: 'Statuses agree.' });
    expect(loaded?.answers).not.toHaveProperty('documentsInvolved');
    expect(Object.keys(loaded!.answers)).toHaveLength(7);
  });
  it('fails closed for unknown versions or incomplete v2 records', async () => {
    expect(await loadWorkflowIntakeSubmission('historical', adminFor({ ...historical, schema_version: 'workflow_intake_v3' }))).toBeNull();
    expect(await loadWorkflowIntakeSubmission('historical', adminFor({ ...historical, schema_version: 'workflow_intake_v2' }))).toBeNull();
  });
  it('filters owned source reads and preserves the pinned attachment manifest', async () => {
    const manifest = [{ attachmentId: 'file-a', sourceSha256: 'a'.repeat(64) }];
    const source = { ...historical, organization_id: ACTOR.organizationId,
      submitted_by_actor_id: ACTOR.actorId, attachment_manifest: manifest };
    expect(await loadWorkflowIntakeSubmission('historical', adminFor(source), 'foreign-org')).toBeNull();
    const loaded = await loadWorkflowIntakeSubmission('historical', adminFor(source), ACTOR.organizationId);
    expect(loaded).toMatchObject({ organizationId: ACTOR.organizationId, submittedByActorId: ACTOR.actorId,
      attachmentManifest: manifest });
    expect(await loadWorkflowIntakeSubmission('historical', adminFor(historical), ACTOR.organizationId)).toBeNull();
  });
});

describe('workflow intake route', () => {
  it('rejects unauthenticated creation before bot checks or persistence', async () => {
    const verify = vi.fn(); const persist = vi.fn();
    const response = await handleWorkflowIntakeRequest(request(answers()), {
      actor: async () => ({ ok: false as const, status: 401, error: 'Unauthorized' }), verify, persist,
    });
    expect(response.status).toBe(401);
    expect(verify).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
  it('rejects client organization and actor authority', async () => {
    const persist = vi.fn();
    for (const injected of [{ organizationId: 'foreign' }, { organization_id: 'foreign' }, { actorId: 'foreign' }]) {
      const response = await handleWorkflowIntakeRequest(request(answers(injected)), { actor: authenticated, verify: human, persist });
      expect(response.status).toBe(400);
    }
    expect(persist).not.toHaveBeenCalled();
  });
  it('acknowledges a human submission with only a submission id', async () => {
    const persist = vi.fn(async () => ({ status: 'persisted' as const, submissionId: 'sub-1' }));
    const response = await handleWorkflowIntakeRequest(request(answers()), {
      actor: authenticated, verify: human, persist,
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ submissionId: 'sub-1' });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ successOutcome: expect.any(String) }), ACTOR, DRAFT);
  });

  it('denies a detected bot before parsing or persisting', async () => {
    const persist = vi.fn();
    const response = await handleWorkflowIntakeRequest(request(answers()), {
      actor: authenticated, verify: async () => ({ isBot: true }), persist,
    });
    expect(response.status).toBe(403);
    expect(persist).not.toHaveBeenCalled();
  });

  it('fails closed when bot classification itself throws', async () => {
    const persist = vi.fn();
    const response = await handleWorkflowIntakeRequest(request(answers()), {
      actor: authenticated, verify: async () => { throw new Error('botid unavailable'); }, persist,
    });
    expect(response.status).toBe(403);
    expect(persist).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and invalid payloads without persisting', async () => {
    const persist = vi.fn();
    const malformed = await handleWorkflowIntakeRequest(request('{not json'), {
      actor: authenticated, verify: human, persist,
    });
    expect(malformed.status).toBe(400);

    const incomplete = await handleWorkflowIntakeRequest(
      request(answers({ exceptions: '' })), { actor: authenticated, verify: human, persist },
    );
    expect(incomplete.status).toBe(400);
    expect(persist).not.toHaveBeenCalled();
  });

  it('returns a generic failure without leaking the database reason', async () => {
    const response = await handleWorkflowIntakeRequest(request(answers()), {
      actor: authenticated, verify: human,
      persist: async () => ({ status: 'failed' as const, reason: 'relation "secret" denied' }),
    });
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Could not record submission');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('reports unconfigured storage as 503', async () => {
    const response = await handleWorkflowIntakeRequest(request(answers()), {
      actor: authenticated, verify: human, persist: async () => ({ status: 'not_configured' as const }),
    });
    expect(response.status).toBe(503);
  });
});
