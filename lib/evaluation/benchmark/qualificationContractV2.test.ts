import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { parseCorpusPins } from '@/lib/evaluation/pinnedEvaluationCapture';
import {
  buildValueReadingMessagesRequest,
} from '@/lib/forgewing/runtime/valueReadingClient';
import {
  buildValueReadingMessagesRequestV2,
} from '@/lib/forgewing/runtime/valueReadingClientV2';
import { VALUE_READING_EXECUTION, type ValueReadingProviderRequest }
  from '@/lib/valueReadingContract';
import { QUALIFICATION_CONTRACT, validateQualificationRecords }
  from './qualificationContract';
import {
  QUALIFICATION_CONTRACT_V2,
  assertQualificationContractV2,
  qualificationSourceDigest,
  qualificationSemanticsDigest,
  validateQualificationRecordsV2,
} from './qualificationContractV2';
import type { ValueReadingBenchmarkRecord } from './valueReadingBenchmark';

const bytes = new Uint8Array([137, 80, 78, 71, 1]);
const render = sha256Hex(bytes);
const request: ValueReadingProviderRequest = {
  requestDigestSha256: 'd'.repeat(64),
  renderDigestSha256: render,
  model: QUALIFICATION_CONTRACT_V2.model,
  timeoutMs: VALUE_READING_EXECUTION.timeoutMs,
  maxOutputTokens: VALUE_READING_EXECUTION.maxOutputTokens,
  promptTemplateId: VALUE_READING_EXECUTION.promptTemplateId,
  promptTemplateVersion: VALUE_READING_EXECUTION.promptTemplateVersion,
  outputSchemaVersion: VALUE_READING_EXECUTION.outputSchemaVersion,
  image: { mediaType: 'image/png', bytes },
  textExcerpts: null,
};
const expected = [{ pageKey: 'dn-p107', rowKey: 'r-0001',
  evidenceClass: 'dense_scanned_ocr_priced_schedule' as const }];

function record(model: string): ValueReadingBenchmarkRecord {
  return { ...expected[0]!, outcome: 'correct', fields: { description: true, unit: true, category: null, rate: true },
    rateError: null, boundTo: null, inventions: [], semantic: null, providerCalled: true,
    failureReason: null, renderMs: 1, providerMs: 1, totalMs: 2, inputTokens: 1, outputTokens: 1, usd: 0.001,
    renderDigestSha256: render, reuseEligible: true, outputDigestSha256: 'b'.repeat(64),
    requestDigestSha256: sha256Hex(JSON.stringify(['b46', expected[0]!.pageKey, expected[0]!.rowKey, render,
      model, VALUE_READING_EXECUTION.promptTemplateId, VALUE_READING_EXECUTION.promptTemplateVersion,
      VALUE_READING_EXECUTION.outputSchemaVersion])) };
}

describe('additive B4.6.1 Sonnet 5.5 qualification contract', () => {
  it('preserves every frozen semantic identity while changing model, sampling and framework identity', () => {
    expect(QUALIFICATION_CONTRACT.version).toBe('b461-qualification-contract-v1');
    expect(QUALIFICATION_CONTRACT.model).toBe('claude-sonnet-4-6');
    expect(QUALIFICATION_CONTRACT_V2).toMatchObject({
      version: 'b461-qualification-contract-v2',
      model: 'claude-sonnet-5-5',
      sampling: { temperature: 'omitted' },
    });
    expect(qualificationSemanticsDigest(QUALIFICATION_CONTRACT_V2))
      .toBe(qualificationSemanticsDigest(QUALIFICATION_CONTRACT));
    expect(hashCanonical(QUALIFICATION_CONTRACT_V2)).not.toBe(hashCanonical(QUALIFICATION_CONTRACT));
  });

  it('binds the additive runner and client source identities without changing v1 pins', () => {
    const observed = {
      scorer: QUALIFICATION_CONTRACT_V2.scorer,
      taxonomy: QUALIFICATION_CONTRACT_V2.taxonomy,
      binding: QUALIFICATION_CONTRACT_V2.binding,
      tasks: QUALIFICATION_CONTRACT_V2.tasks,
      execution: QUALIFICATION_CONTRACT_V2.execution,
      activationBar: QUALIFICATION_CONTRACT_V2.activationBar,
      promptSha256: QUALIFICATION_CONTRACT_V2.promptSha256,
      pins: parseCorpusPins(QUALIFICATION_CONTRACT_V2.corpus),
      sourceSha256: Object.fromEntries(Object.keys(QUALIFICATION_CONTRACT_V2.sourceSha256)
        .map((file) => [file, qualificationSourceDigest(readFileSync(file, 'utf8'))])),
    };
    expect(() => assertQualificationContractV2(observed)).not.toThrow();
    expect(QUALIFICATION_CONTRACT.sourceSha256).not.toHaveProperty('lib/forgewing/runtime/valueReadingClientV2.ts');
    expect(QUALIFICATION_CONTRACT.sourceSha256).not.toHaveProperty('scripts/evaluation/b461/runQualificationV2.ts');
  });

  it('keeps the v1 request at temperature 0 and omits temperature entirely from v2', () => {
    const v1 = buildValueReadingMessagesRequest({ ...request, model: QUALIFICATION_CONTRACT.model }, 'PROMPT');
    const v2 = buildValueReadingMessagesRequestV2(request, 'PROMPT');
    expect(v1.body.temperature).toBe(0);
    expect(Object.keys(v1.body)).toContain('temperature');
    expect(Object.prototype.hasOwnProperty.call(v2.body, 'temperature')).toBe(false);
    expect(Object.keys(v2.body).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(v2.body.model).toBe('claude-sonnet-5-5');
    expect(v2.options).toEqual({ timeout: VALUE_READING_EXECUTION.timeoutMs, maxRetries: 0 });
  });

  it('keeps v1 and v2 request identities mutually exclusive', () => {
    expect(() => validateQualificationRecords([record(QUALIFICATION_CONTRACT.model)], expected)).not.toThrow();
    expect(() => validateQualificationRecordsV2([record(QUALIFICATION_CONTRACT_V2.model)], expected)).not.toThrow();
    expect(() => validateQualificationRecords([record(QUALIFICATION_CONTRACT_V2.model)], expected)).toThrow('request identity');
    expect(() => validateQualificationRecordsV2([record(QUALIFICATION_CONTRACT.model)], expected)).toThrow('request identity');
  });

  it('preserves every frozen v1 canonical source identity', () => {
    const expectedHashes: Record<string, string> = {
      'lib/evaluation/benchmark/qualificationContract.ts': '74e3a1547aef8e8ddfbf0aa3bd6270732acc7d36f262855e015c6eda6c8be632',
      'lib/forgewing/runtime/valueReadingClient.ts': 'd1a40e0a229871b53e0024929d73f58be4dc0a7818eb31c575f63862797db098',
      'scripts/evaluation/b461/runQualification.ts': 'b64b34dd9c7fb23b5c638fd69339154e8b7d09f81cf58bb39a26e690f12bb770',
    };
    for (const [file, expectedHash] of Object.entries(expectedHashes)) {
      expect(createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex'), file).toBe(expectedHash);
    }
  });

  it('preserves the authoritative DN p107 historical baseline without reinterpretation', () => {
    expect({ correctness: '20/20', inventions: 0, wrongBindings: 0,
      medianLatencyMs: 3196.1921, thresholdMs: QUALIFICATION_CONTRACT_V2.activationBar.maxP50TotalLatencyMs,
      historicalResult: 'FAIL' }).toEqual({ correctness: '20/20', inventions: 0, wrongBindings: 0,
      medianLatencyMs: 3196.1921, thresholdMs: 3000, historicalResult: 'FAIL' });
  });
});
