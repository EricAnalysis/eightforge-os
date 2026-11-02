import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { askMock, getActorContextMock, getSupabaseAdminMock, eligibilityMock, reserveMock, createMock, getClaudeClientMock } = vi.hoisted(() => ({
  askMock: vi.fn(),
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  eligibilityMock: vi.fn(),
  reserveMock: vi.fn(),
  createMock: vi.fn(),
  getClaudeClientMock: vi.fn(),
}));

vi.mock('@/lib/server/forgewingGates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/forgewingGates')>()),
  resolveForgewingWorkflowEligibility: eligibilityMock,
  reserveForgewingProviderCall: reserveMock,
}));
vi.mock('@/lib/server/ai/claudeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai/claudeClient')>()),
  getClaudeClient: getClaudeClientMock,
}));
vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: getActorContextMock }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: getSupabaseAdminMock }));
vi.mock('@/lib/server/forgewingProviderTelemetry', () => ({ recordForgewingProviderCallObservation: vi.fn(async () => true) }));

import { POST } from '@/app/api/projects/[id]/ask/route';
import { askOperatorGuidanceWithClaude, OPERATOR_GUIDANCE_MAX_OUTPUT_TOKENS, OPERATOR_GUIDANCE_OUTPUT_JSON_SCHEMA, OPERATOR_GUIDANCE_SYSTEM_PROMPT } from '@/lib/server/ai/askProject';

import { GUIDANCE_QUALIFICATION_MODEL } from '@/scripts/evaluation/operator-guidance/contract';
import { QUALIFICATION_CASES } from '@/scripts/evaluation/operator-guidance/corpus';
import { createFixtureDatabase, materializeCase, QUALIFICATION_ORGANIZATION_ID } from '@/scripts/evaluation/operator-guidance/harness';

/**
 * The qualification is only worth anything if it tests what production would send.
 * Every case goes through the real Ask route with its real read seam and its real
 * adapter, stopping at a stand-in provider client, and the bytes must equal the bytes
 * the qualification harness would send.
 */

const ORIGINAL_ENV = { ...process.env };

function providerReply() {
  return { content: [{ type: 'text', text: 'not json' }], model: GUIDANCE_QUALIFICATION_MODEL, stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 }, _request_id: 'req-stub' };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'stub-not-a-key', FORGEWING_PROJECT_ASK_GUIDANCE_ENABLED: '1' };
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.FORGEWING_PROJECT_ASK_MODEL;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  getActorContextMock.mockResolvedValue({ ok: true, actor: { actorId: 'user-1', organizationId: QUALIFICATION_ORGANIZATION_ID, displayName: 'Op', role: 'member' } });
  eligibilityMock.mockResolvedValue({ eligible: true, entitlementEventId: 'e-1', dataPolicyEventIds: ['d-1'], dailyCap: 5 });
  reserveMock.mockResolvedValue({ status: 'reserved', reservationId: 'r-1', usedInWindow: 1 });
  createMock.mockReset();
  createMock.mockResolvedValue(providerReply());
  getClaudeClientMock.mockReturnValue({ messages: { create: createMock } });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  askMock.mockReset();
});

describe('the Project Ask route sends what the qualification tests', () => {
  it.each(QUALIFICATION_CASES.map((item) => [item.caseId, item] as const))('%s', async (_caseId, item) => {
    const built = await materializeCase(item);
    const projectOrg = { ...built.projectRow, organization_id: QUALIFICATION_ORGANIZATION_ID };
    getSupabaseAdminMock.mockReturnValue(createFixtureDatabase({ ...built.tables, projects: [projectOrg] }).admin);

    const response = await POST(new Request(`http://localhost/api/projects/${built.projectId}/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: item.question, mode: 'operator_guidance', ...(built.focusFindingId ? { findingId: built.focusFindingId } : {}) }),
    }), { params: Promise.resolve({ id: built.projectId }) });
    expect(response.status).toBe(200);
    const payload = await response.json() as { recommendation: unknown };

    // The route reached the provider exactly once, with the harness's exact request.
    expect(createMock).toHaveBeenCalledTimes(1);
    const [routeBody, routeOptions] = createMock.mock.calls[0]!;
    createMock.mockClear();
    await askOperatorGuidanceWithClaude({ ...built.request, model: GUIDANCE_QUALIFICATION_MODEL });
    const [harnessBody, harnessOptions] = createMock.mock.calls[0]!;
    expect(harnessBody).toEqual(routeBody);
    expect(harnessOptions).toEqual(routeOptions);

    expect(routeBody).toMatchObject({ model: GUIDANCE_QUALIFICATION_MODEL, temperature: 0, max_tokens: OPERATOR_GUIDANCE_MAX_OUTPUT_TOKENS, system: OPERATOR_GUIDANCE_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: OPERATOR_GUIDANCE_OUTPUT_JSON_SCHEMA } } });
    expect(routeOptions).toEqual({ timeout: 45_000, maxRetries: 0 });

    // A rejected answer gives the operator the same floor the qualification froze.
    expect(payload.recommendation).toEqual(JSON.parse(JSON.stringify(built.floor)));
  });
});
