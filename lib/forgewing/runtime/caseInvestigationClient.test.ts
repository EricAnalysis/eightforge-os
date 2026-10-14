import { describe, expect, it, vi } from 'vitest';

import {
  buildCaseInvestigationMessagesRequest,
  CASE_INVESTIGATION_OUTPUT_JSON_SCHEMA,
  createClaudeCaseInvestigationProvider,
} from '@/lib/forgewing/runtime/caseInvestigationClient';

const REQUEST = { system: 'sys', context: [{ kind: 'validator_findings' }], offeredActionKinds: ['open_document'] };

describe('case investigation Claude adapter (P3b)', () => {
  it('builds a bounded, deterministic structured-output request', () => {
    const built = buildCaseInvestigationMessagesRequest('claude-sonnet-4-6', REQUEST);
    expect(built.body).toMatchObject({ model: 'claude-sonnet-4-6', temperature: 0, max_tokens: 1_500, system: 'sys' });
    expect(built.options).toEqual({ timeout: 15_000, maxRetries: 0 });
    expect(JSON.parse(built.body.messages[0]!.content)).toEqual({
      offered_action_kinds: ['open_document'], context: [{ kind: 'validator_findings' }] });
    expect(CASE_INVESTIGATION_OUTPUT_JSON_SCHEMA.required).toEqual(['diagnosis', 'rankedActionKinds', 'rationale', 'evidenceRefs']);
    expect(() => buildCaseInvestigationMessagesRequest(' ', REQUEST)).toThrow('provider_model_missing');
  });

  it('returns the text, and treats truncation and refusal as provider failures', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"a":1}' }], stop_reason: 'end_turn' })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"a"' }], stop_reason: 'max_tokens' })
      .mockResolvedValueOnce({ content: [], stop_reason: 'refusal' });
    const provider = createClaudeCaseInvestigationProvider({ model: 'claude-sonnet-4-6',
      client: () => ({ messages: { create } }) as never });
    expect(provider.providerModel).toBe('claude-sonnet-4-6');
    await expect(provider.investigate(REQUEST)).resolves.toBe('{"a":1}');
    await expect(provider.investigate(REQUEST)).rejects.toMatchObject({ message: 'provider_truncated_output' });
    await expect(provider.investigate(REQUEST)).rejects.toBeInstanceOf(Error);
    expect(create.mock.calls[0]![1]).toMatchObject({ timeout: 15_000, maxRetries: 0 });
  });
});
