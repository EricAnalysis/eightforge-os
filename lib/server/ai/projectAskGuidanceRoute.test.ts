import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  askOperatorGuidanceMock, askProjectMock, readSourcesMock, getActorContextMock, getSupabaseAdminMock, eligibilityMock, reserveMock,
} = vi.hoisted(() => ({
  askOperatorGuidanceMock: vi.fn(),
  askProjectMock: vi.fn(),
  readSourcesMock: vi.fn(),
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  eligibilityMock: vi.fn(),
  reserveMock: vi.fn(),
}));

vi.mock('@/lib/server/forgewingGates', () => ({
  resolveForgewingWorkflowEligibility: eligibilityMock,
  reserveForgewingProviderCall: reserveMock,
}));
vi.mock('@/lib/server/ai/askProject', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai/askProject')>()),
  askOperatorGuidanceWithClaude: askOperatorGuidanceMock,
  askProjectWithClaude: askProjectMock,
}));
vi.mock('@/lib/server/projectIntelligenceRead', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/projectIntelligenceRead')>()),
  readProjectIntelligenceSources: readSourcesMock,
}));
vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: getActorContextMock }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: getSupabaseAdminMock }));

import { POST } from '@/app/api/projects/[id]/ask/route';
import { resolveDocumentPrecedence } from '@/lib/documentPrecedence';
import type { ProjectContextSources } from '@/lib/projectIntelligence/projectContext';

const ORIGINAL_ENV = { ...process.env };
const AT = '2026-10-01T00:00:00.000Z';
const CONTRACT = '11111111-1111-4111-8111-111111111111';
const SHEET = '22222222-2222-4222-8222-222222222222';
const FINDING = '33333333-3333-4333-8333-333333333333';
const SECRET_TITLE = 'Goodlettsville Price Sheet';

function sources(): ProjectContextSources {
  const documents = [
    { id: CONTRACT, title: 'Goodlettsville Debris Contract', documentType: 'contract' },
    { id: SHEET, title: SECRET_TITLE, documentType: 'price sheet' },
  ];
  return {
    project: { id: 'project-1', name: 'Goodlettsville', validationStatus: 'BLOCKED' },
    findings: {
      latestRunAt: AT,
      open: [{
        id: FINDING, severity: 'critical', category: 'financial_integrity', description: 'Rate schedule is required', blocksProject: true,
        lastRun: AT, timestamp: AT, ruleId: 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', subjectId: 'project-1', evidenceDocumentIds: [],
      }],
    },
    documents: documents.map((entry) => ({ ...entry, documentName: entry.title, processingStatus: 'decisioned', createdAt: AT, processedAt: AT })),
    precedence: {
      relationships: [],
      families: resolveDocumentPrecedence({
        documents: documents.map((entry) => ({ id: entry.id, project_id: 'project-1', title: entry.title, name: entry.title, document_type: entry.documentType, created_at: AT })),
        relationships: [],
      }),
    },
    facts: [],
  };
}

function modelOutput(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    answer: `The rates appear to already be in ${SECRET_TITLE}. You probably do not need another document.`,
    nextStepKind: 'link_existing_document',
    nextStepInstruction: `Check whether ${SECRET_TITLE} is linked to the contract.`,
    citations: ['B'],
    missingInformation: ['Whether it covers every billed item.'],
    confidence: 'high',
    ...overrides,
  });
}

function answered(raw: string, stopReason = 'end_turn') {
  return { raw, truncated: stopReason === 'max_tokens', refused: stopReason === 'refusal',
    observation: { returnedModel: 'claude-sonnet-4-6', providerRequestId: 'req-1', stopReason, inputTokens: 100, outputTokens: 50, latencyMs: 10 } };
}

function ask(body: Record<string, unknown> = {}) {
  return POST(new Request('http://localhost/api/projects/project-1/ask', {
    method: 'POST',
    body: JSON.stringify({ question: 'Do I need another document?', mode: 'operator_guidance', ...body }),
  }), { params: Promise.resolve({ id: 'project-1' }) });
}

let ledger: Record<string, unknown>[];
let logged: unknown[];

beforeEach(() => {
  ledger = [];
  logged = [];
  process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'sk-test', FORGEWING_PROJECT_ASK_GUIDANCE_ENABLED: '1' };
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.FORGEWING_PROJECT_ASK_MODEL;
  getActorContextMock.mockResolvedValue({ ok: true, actor: { actorId: 'user-1', organizationId: 'org-1', displayName: 'Op', role: 'member' } });
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'project-1', name: 'Goodlettsville', validation_status: 'BLOCKED', validation_summary_json: null }, error: null }),
    insert: vi.fn(async (row: Record<string, unknown>) => { ledger.push(row); return { error: null }; }),
  };
  getSupabaseAdminMock.mockReturnValue({ from: vi.fn(() => query) });
  readSourcesMock.mockResolvedValue({ status: 'ok', sources: sources() });
  eligibilityMock.mockResolvedValue({ eligible: true, entitlementEventId: 'e-1', dataPolicyEventIds: ['d-1'], dailyCap: 5 });
  reserveMock.mockResolvedValue({ status: 'reserved', reservationId: 'r-1', usedInWindow: 1 });
  vi.spyOn(console, 'info').mockImplementation((...args) => { logged.push(args); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  for (const mock of [askOperatorGuidanceMock, askProjectMock, readSourcesMock, getActorContextMock, getSupabaseAdminMock, eligibilityMock, reserveMock]) mock.mockReset();
});

describe('POST /api/projects/[id]/ask in operator_guidance mode', () => {
  it('plans ticket data from the words of the question, and only then', async () => {
    delete process.env.FORGEWING_PROJECT_ASK_GUIDANCE_ENABLED;
    await ask({ question: 'Why are these tickets flagged?' });
    expect(readSourcesMock.mock.calls[0]![0].plan.sections).toContain('transaction_context');
    readSourcesMock.mockClear();
    await ask({ question: 'Do I need another rate schedule?' });
    expect(readSourcesMock.mock.calls[0]![0].plan.sections).not.toContain('transaction_context');
  });

  it('answers from evidence with no provider, budget or gate when guidance is switched off', async () => {
    delete process.env.FORGEWING_PROJECT_ASK_GUIDANCE_ENABLED;
    const response = await ask();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recommendation.method).toBe('deterministic');
    expect(body.recommendation.recommendedNextStep.kind).toBe('link_existing_document');
    expect(body.model).toBeNull();
    expect(eligibilityMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
    expect(askOperatorGuidanceMock).not.toHaveBeenCalled();
    expect(ledger).toEqual([]);
  });

  it('still answers from evidence when the Ask gates are closed, where plain Ask refuses', async () => {
    eligibilityMock.mockResolvedValue({ eligible: false, reason: 'data_policy_not_approved' });
    const response = await ask();
    expect(response.status).toBe(200);
    expect((await response.json()).recommendation.method).toBe('deterministic');
    expect(reserveMock).not.toHaveBeenCalled();
    expect(askOperatorGuidanceMock).not.toHaveBeenCalled();

    const plain = await ask({ mode: undefined });
    expect(plain.status).toBe(403);
    expect(askProjectMock).not.toHaveBeenCalled();
  });

  it('runs on the project_ask workflow and content class, never case_investigation', async () => {
    askOperatorGuidanceMock.mockResolvedValue(answered(modelOutput()));
    await ask();
    expect(eligibilityMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workflow: 'project_ask', contentClasses: ['text_excerpts'] }));
    expect(reserveMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workflow: 'project_ask', dailyCap: 5, reservedBy: 'user-1' }));
    expect(JSON.stringify([eligibilityMock.mock.calls.map((call) => call[1]), reserveMock.mock.calls.map((call) => call[1]), ledger]))
      .not.toContain('case_investigation');
  });

  it('refuses an unqualified model before any budget or provider call, and still answers', async () => {
    process.env.FORGEWING_PROJECT_ASK_MODEL = 'claude-sonnet-5-5';
    const response = await ask();
    expect(response.status).toBe(200);
    expect((await response.json()).recommendation.method).toBe('deterministic');
    expect(reserveMock).not.toHaveBeenCalled();
    expect(askOperatorGuidanceMock).not.toHaveBeenCalled();
  });

  it('does not call the provider on a spent budget, and still answers', async () => {
    reserveMock.mockResolvedValue({ status: 'budget_exhausted', usedInWindow: 5 });
    const response = await ask();
    expect(response.status).toBe(200);
    expect((await response.json()).recommendation.method).toBe('deterministic');
    expect(askOperatorGuidanceMock).not.toHaveBeenCalled();
  });

  it('accepts a valid answer, citing resolved records, on the qualified model', async () => {
    askOperatorGuidanceMock.mockResolvedValue(answered(modelOutput()));
    const body = await (await ask()).json();
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.recommendation.method).toBe('model_reasoned');
    expect(body.recommendation.authority).toBe('non_authoritative');
    expect(body.recommendation.needsHumanReview).toBe(true);
    expect(body.recommendation.evidenceRefs.length).toBeGreaterThan(0);
    expect(askOperatorGuidanceMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-4-6', intent: 'need_document',
      allowedNextSteps: ['link_existing_document', 'review_existing_document', 'operator_judgment_required'],
    }));
    expect(ledger).toEqual([expect.objectContaining({ workflow: 'project_ask', outcome: 'succeeded', reservation_id: 'r-1' })]);
  });

  it.each([
    ['an invented number', { answer: `${SECRET_TITLE} has 412 rate rows.` }],
    ['a next step the evidence does not allow', { nextStepKind: 'upload_or_request_document' }],
    ['a citation that resolves to nothing', { citations: ['ZZ'] }],
    ['internal vocabulary', { answer: 'The contract-family traversal cannot reach the exhibit.' }],
    ['a claim of having acted', { answer: 'I have linked the schedule to the contract.' }],
    ['an unknown field', { secretWrite: true }],
  ])('drops %s and gives the deterministic answer instead', async (_name, overrides) => {
    askOperatorGuidanceMock.mockResolvedValue(answered(modelOutput(overrides)));
    const response = await ask();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recommendation.method).toBe('deterministic');
    expect(body.recommendation.recommendedNextStep.kind).toBe('link_existing_document');
    expect(body.model).toBeNull();
    expect(ledger).toEqual([expect.objectContaining({ workflow: 'project_ask', outcome: 'output_invalid' })]);
  });

  it('treats a truncated answer as no answer', async () => {
    askOperatorGuidanceMock.mockResolvedValue(answered(modelOutput(), 'max_tokens'));
    const body = await (await ask()).json();
    expect(body.recommendation.method).toBe('deterministic');
    expect(ledger).toEqual([expect.objectContaining({ outcome: 'output_truncated' })]);
  });

  it('survives a provider failure, recording it by class only', async () => {
    askOperatorGuidanceMock.mockRejectedValue(new Error(`timed out reading ${SECRET_TITLE}`));
    const response = await ask();
    expect(response.status).toBe(200);
    expect((await response.json()).recommendation.method).toBe('deterministic');
    expect(ledger).toEqual([expect.objectContaining({ outcome: 'provider_timeout' })]);
  });

  it('never returns the product signal, the assessment or call metadata to the operator', async () => {
    askOperatorGuidanceMock.mockResolvedValue(answered(modelOutput()));
    const body = await (await ask()).json();
    expect(Object.keys(body).sort()).toEqual(['model', 'recommendation']);
    const text = JSON.stringify(body);
    for (const internal of ['signal', 'relationship_precedence', 'reservation', 'digest', 'inputTokens']) {
      expect(text.toLowerCase()).not.toContain(internal.toLowerCase());
    }
  });

  it('logs telemetry with no question, title, project or organization', async () => {
    askOperatorGuidanceMock.mockResolvedValue(answered(modelOutput()));
    await ask();
    const [, record] = logged[0] as [string, Record<string, unknown>];
    expect(record).toMatchObject({
      intent: 'need_document', providerStatus: 'accepted', validationStatus: 'passed', model: 'claude-sonnet-4-6',
      evidenceState: 'source_present_relationship_unresolved', inputTokens: 100, outputTokens: 50,
      signalCategories: ['relationship_precedence'],
    });
    const text = JSON.stringify(record);
    for (const content of ['Goodlettsville', 'another document', 'org-1', 'project-1', SHEET]) expect(text).not.toContain(content);
  });

  it('refuses a focus finding that is not open on this project', async () => {
    readSourcesMock.mockResolvedValue({ status: 'focus_finding_not_found' });
    expect((await ask({ findingId: 'elsewhere' })).status).toBe(404);
    expect(askOperatorGuidanceMock).not.toHaveBeenCalled();
  });

  it('sends a question it cannot place back to plain Ask', async () => {
    const response = await ask({ question: 'What is the contract ceiling?' });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('intent_not_supported');
    expect(readSourcesMock).not.toHaveBeenCalled();
  });

  it('passes the actor organization, never one from the request', async () => {
    await ask({ organizationId: 'org-2' });
    expect(readSourcesMock).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
  });
});
