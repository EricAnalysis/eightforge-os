import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/lib/extraction/domain/hash';
import { buildValueReadingMessagesRequestV2 } from '@/lib/forgewing/runtime/valueReadingClientV2';
import { buildValueReadingMessagesRequestV3, createClaudeValueReadingProviderV3 } from '@/lib/forgewing/runtime/valueReadingClientV3';
import { VALUE_READING_EXECUTION, type ValueReadingProviderRequest } from '@/lib/valueReadingContract';
import { QUALIFICATION_CONTRACT_V2, qualificationSemanticsDigest } from './qualificationContractV2';
import { QUALIFICATION_CONTRACT_V3, assertQualificationContractV3, qualificationSourceDigest } from './qualificationContractV3';

const bytes = new Uint8Array([137, 80, 78, 71, 1]);
const request: ValueReadingProviderRequest = {
  requestDigestSha256: 'd'.repeat(64), renderDigestSha256: sha256Hex(bytes),
  model: 'claude-sonnet-5-5', timeoutMs: VALUE_READING_EXECUTION.timeoutMs,
  maxOutputTokens: 500,
  promptTemplateId: VALUE_READING_EXECUTION.promptTemplateId,
  promptTemplateVersion: VALUE_READING_EXECUTION.promptTemplateVersion,
  outputSchemaVersion: VALUE_READING_EXECUTION.outputSchemaVersion,
  image: { mediaType: 'image/png', bytes }, textExcerpts: null,
};

describe('B4.6.1 additive request efficiency contract', () => {
  it('records the approved 500-token cap and upfront thinking identity', () => {
    const old = buildValueReadingMessagesRequestV2({ ...request, maxOutputTokens: 300 }, 'PROMPT');
    const next = buildValueReadingMessagesRequestV3(request, 'PROMPT');
    const { thinking, max_tokens, ...unchanged } = next.body;
    const { max_tokens: oldCap, ...oldUnchanged } = old.body;
    expect(oldCap).toBe(300);
    expect(max_tokens).toBe(500);
    expect(thinking).toEqual({ type: 'between_tools' });
    expect(unchanged).toEqual(oldUnchanged);
    expect(next.options).toEqual(old.options);
    expect(next.body.max_tokens).toBe(500);
    expect(next.body).not.toHaveProperty('temperature');
    expect(sha256Hex(JSON.stringify(next.body))).not.toBe(sha256Hex(JSON.stringify(old.body)));
  });

  it('preserves every frozen qualification semantic and authenticates new sources', () => {
    expect(qualificationSemanticsDigest({ ...QUALIFICATION_CONTRACT_V3, execution: { ...QUALIFICATION_CONTRACT_V3.execution, maxOutputTokens: QUALIFICATION_CONTRACT_V2.execution.maxOutputTokens } })).toBe(qualificationSemanticsDigest(QUALIFICATION_CONTRACT_V2));
    expect(QUALIFICATION_CONTRACT_V3.execution).toEqual({ ...QUALIFICATION_CONTRACT_V2.execution, maxOutputTokens: 500 });
    expect(QUALIFICATION_CONTRACT_V3.thinking).toEqual({ type: 'between_tools' });
    expect(() => assertQualificationContractV3({ ...QUALIFICATION_CONTRACT_V3,
      pins: QUALIFICATION_CONTRACT_V3.corpus,
      sourceSha256: Object.fromEntries(Object.keys(QUALIFICATION_CONTRACT_V3.sourceSha256)
        .map(file => [file, qualificationSourceDigest(readFileSync(file, 'utf8'))])),
    })).not.toThrow();
  });

  it('retains the entire failed provider envelope without treating truncation as success', async () => {
    const message = { model: 'claude-sonnet-5-5', id: 'test-only', stop_reason: 'max_tokens',
      content: [{ type: 'thinking', thinking: '', signature: 'test' }, { type: 'text', text: '{"reading":' }],
      usage: { input_tokens: 123, output_tokens: 300 } };
    const create = vi.fn(async () => message);
    const observe = vi.fn();
    const provider = createClaudeValueReadingProviderV3({ model: request.model, prompt: 'PROMPT',
      client: () => ({ messages: { create } }), observe });
    await expect(provider.read(request, new AbortController().signal)).rejects.toThrow('provider_truncated_output');
    expect(create).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ message,
      requestDigestSha256: request.requestDigestSha256, renderDigestSha256: request.renderDigestSha256,
      requestBodySha256: sha256Hex(JSON.stringify(buildValueReadingMessagesRequestV3(request, 'PROMPT').body)) }));
  });

  it('fails closed for a foreign model or changed cap before any provider call', () => {
    expect(() => buildValueReadingMessagesRequestV3({ ...request, model: 'claude-sonnet-4-6' }, 'PROMPT')).toThrow('model_mismatch');
    expect(() => buildValueReadingMessagesRequestV3({ ...request, maxOutputTokens: 301 }, 'PROMPT')).toThrow('output_cap_mismatch');
  });
});
