import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/ai/claudeClient', () => ({ getClaudeClient: () => ({ messages: { create } }) }));

import { callClaudeForWorkflowAssessment } from '@/lib/forgewing/runtime/client';
import { createObservedWorkflowAssessmentProvider } from '@/lib/forgewing/runtime/observedWorkflowAssessmentClient';
import { parseWorkflowAssessmentModelOutput } from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';
import { getForgewingWorkflowAssessmentRuntimeConfig } from '@/lib/forgewing/runtime/modelConfig';

const REQUEST = { model: 'claude-sonnet-4-6', timeoutMs: 15_000, maxOutputTokens: 4_000, inputJson: '{"task":"workflow_assessment"}' };
const message = (stop = 'end_turn') => ({
  id: 'msg_1', _request_id: 'req_1', model: 'claude-sonnet-4-6', stop_reason: stop,
  usage: { input_tokens: 3000, output_tokens: 900 }, content: [{ type: 'text', text: '{"ok":true}' }],
});

afterEach(() => {
  create.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('D2/D4 Workflow Assessment capacity on the observed provider', () => {
  it('sends the configured 26,000-token cap and 600 s timeout', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_ENABLED', '1');
    vi.stubEnv('FORGEWING_MODEL', 'claude-sonnet-4-6');
    const config = getForgewingWorkflowAssessmentRuntimeConfig();
    expect(config).toMatchObject({ timeoutMs: 600_000, maxOutputTokens: 26_000 });
    create.mockResolvedValue(message());
    await createObservedWorkflowAssessmentProvider(vi.fn())({ model: config.model, timeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens, inputJson: '{}' });
    const [body, options] = create.mock.calls[0]!;
    expect(body).toMatchObject({ max_tokens: 26_000, output_config: { format: { type: 'json_schema' } } });
    expect(options).toMatchObject({ timeout: 600_000, maxRetries: 0 });
  });

  it('aborts at exactly the configured timeout with an explicit provider_timeout', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    create.mockImplementation((_body: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    const pending = createObservedWorkflowAssessmentProvider(vi.fn())({ ...REQUEST, timeoutMs: 600_000, maxOutputTokens: 26_000 });
    const settled = expect(pending).rejects.toThrow('provider_timeout');
    await vi.advanceTimersByTimeAsync(599_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(signal?.aborted).toBe(true);
  });
});

describe('observed Workflow Assessment provider (S7)', () => {
  it('sends exactly the production request and returns the same output', async () => {
    const assessment = {
      summary: 'Human review of a workflow.', documents: [],
      workflowSteps: [{ stepId: 's1', sourceQuestions: ['workflowDescription'],
        description: 'Review the workflow.', classification: 'HUMAN', rationale: 'Human judgment.',
        requiredInputs: [], evidenceRequirements: [], proposedOutput: 'Reviewed workflow.',
        dependencies: [], failureConsequence: 'Decision remains open.', unresolvedAssumptions: [],
        determinismBasis: null, determinismGaps: [], determinismSupport: [] }],
      extractionRequirements: [], deterministicRuleProposals: [], evidenceRelationships: [],
      verificationRuleProposals: [], forgewingRecoveryTasks: [],
      humanDecisionPoints: [{ decisionId: 'd1', stepId: 's1',
        description: 'Review the workflow.', whyHumanControlled: 'Human judgment.' }],
      advisorySteps: [], failureConsequences: [], limitations: [],
    };
    create.mockResolvedValue({ ...message(), content: [{ type: 'text',
      text: JSON.stringify({ assessmentJson: JSON.stringify(assessment) }) }] });
    const production = await callClaudeForWorkflowAssessment(REQUEST);
    const observer = vi.fn();
    const observed = await createObservedWorkflowAssessmentProvider(observer)(REQUEST);

    expect(observed).toBe(production);
    expect(parseWorkflowAssessmentModelOutput(production)).toEqual(assessment);
    expect(parseWorkflowAssessmentModelOutput(observed)).toEqual(assessment);
    expect(create).toHaveBeenCalledTimes(2);
    const [productionBody, productionOptions] = create.mock.calls[0]!;
    const [observedBody, observedOptions] = create.mock.calls[1]!;
    expect(observedBody).toEqual(productionBody);
    const strip = (options: Record<string, unknown>) => ({ ...options, signal: undefined });
    expect(strip(observedOptions)).toEqual(strip(productionOptions));
    expect(observedBody).toMatchObject({ temperature: 0, max_tokens: 4_000 });
    expect(observedOptions).toMatchObject({ timeout: 15_000, maxRetries: 0 });
  });

  it('reports metadata only, and still detects truncation', async () => {
    create.mockResolvedValue(message('max_tokens'));
    const observer = vi.fn();
    await expect(createObservedWorkflowAssessmentProvider(observer)(REQUEST))
      .rejects.toMatchObject({ message: 'provider_truncated_output' });
    const [observation] = observer.mock.calls[0]!;
    expect(observation).toMatchObject({ requestId: 'req_1', returnedModel: 'claude-sonnet-4-6',
      stopReason: 'max_tokens', inputTokens: 3000, outputTokens: 900 });
    expect(JSON.stringify(observation)).not.toContain('"ok":true');
  });

  it('leaves the qualification-frozen client.ts untouched', () => {
    // Pinned whole by the Sonnet 5.5 qualification contract (phase17Sonnet55Run.test.ts).
    const digest = createHash('sha256')
      .update(readFileSync('lib/forgewing/runtime/client.ts', 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    expect(digest).toBe('a2d673c29a4cfa3917557602953e00231f6f2f2056093271f68ebec5088387de');
  });
});
