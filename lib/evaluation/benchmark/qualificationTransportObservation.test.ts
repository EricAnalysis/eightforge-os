import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { createQualificationTransportObservation, qualificationUsageForScoring } from './qualificationTransportObservation';
import { QUALIFICATION_CONTRACT_V3, qualificationSemanticsDigest, validateQualificationRecordsV3 } from './qualificationContractV3';
import { QUALIFICATION_CONTRACT_V4, assertQualificationContractV4, qualificationSourceDigest, validateQualificationRecordsV4 } from './qualificationContractV4';
import { parseCorpusPins } from '@/lib/evaluation/pinnedEvaluationCapture';

describe('additive qualification transport observation', () => {
  it('forwards identical fetch arguments and response without consuming its body', async () => {
    const response = new Response(JSON.stringify({ model: 'claude-sonnet-5-5', usage: { input_tokens: 2, output_tokens: 3 } }), { headers: { 'request-id': 'test-id' } });
    const original = vi.fn<typeof fetch>(async () => response);
    const observation = createQualificationTransportObservation(original);
    const body = { model: 'claude-sonnet-5-5', max_tokens: 500 };
    const signal = new AbortController().signal;
    const options = { method: 'POST', body: JSON.stringify(body), signal };
    const result = await observation.run(body, signal, async () => {
      const returned = await observation.fetch('https://example.test', options);
      expect(returned).toBe(response); expect(returned.bodyUsed).toBe(false);
      return returned.json();
    });
    expect(original.mock.calls[0]![1]).toBe(options);
    expect(result.model).toBe('claude-sonnet-5-5');
    expect(observation.events.map(e => e.stage)).toEqual(['fetch_start', 'response_headers', 'sdk_settled']);
    expect(observation.events[0]!.requestBodySha256).toBe(sha256Hex(JSON.stringify(body)));
    expect(observation.accounting()[0]!.usage).toEqual({ input_tokens: 2, output_tokens: 3 });
  });
  it('preserves fetch rejection and sanitizes diagnostics while usage remains unknown', async () => {
    const error = Object.assign(new Error('secret prompt and credentials'), { code: 'ECONNRESET' });
    const observation = createQualificationTransportObservation(vi.fn<typeof fetch>(async () => { throw error; }));
    await expect(observation.run({}, new AbortController().signal, () => observation.fetch('https://example.test'))).rejects.toBe(error);
    expect(JSON.stringify(observation.events)).not.toContain('secret');
    expect(observation.events.map(e => e.stage)).toEqual(['fetch_start', 'fetch_error', 'sdk_settled']);
    expect(observation.accounting()[0]).toMatchObject({ usage: null, costUsd: null, costStatus: 'unknown_usage', settlement: 'rejected' });
  });
  it('separates header arrival from delayed body settlement without crediting a late response', async () => {
    let finish!: () => void;
    const response = new Response(new ReadableStream({ start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode('{"model":"claude-sonnet-5-5","usage":{"input_tokens":10,"output_tokens":20}}')); controller.close(); }; } }));
    const observation = createQualificationTransportObservation(vi.fn<typeof fetch>(async () => response));
    const controller = new AbortController();
    const pending = observation.run({}, controller.signal, async () => (await observation.fetch('https://example.test', { signal: controller.signal })).json());
    await vi.waitFor(() => expect(observation.events.some(e => e.stage === 'response_headers')).toBe(true));
    controller.abort();
    expect(observation.accounting()[0]!.settlement).toBe('pending');
    finish(); const late = await pending; await observation.drain();
    expect(observation.events.at(-1)).toMatchObject({ stage: 'sdk_settled', afterAbort: true });
    // Observer never provides a replacement scorer or deadline result.
    expect(observation.accounting({ inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10 })[0]).toMatchObject({
      usage: { input_tokens: 10, output_tokens: 20 }, costUsd: 0.00022, costStatus: 'observed_unscored_late_usage', afterAbort: true,
    });
    let nextCaseUsage = { inputTokens: 3, outputTokens: 4 };
    const lateScoredUsage = qualificationUsageForScoring(late, controller.signal);
    if (lateScoredUsage) nextCaseUsage = lateScoredUsage;
    expect(nextCaseUsage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(qualificationUsageForScoring({ usage: { input_tokens: 5, output_tokens: 6 } }, new AbortController().signal)).toEqual({ inputTokens: 5, outputTokens: 6 });
  });
  it('observes abort and retains exact original error and signal', async () => {
    const controller = new AbortController();
    const error = new DOMException('aborted', 'AbortError');
    const original = vi.fn<typeof fetch>((_input, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(error), { once: true })));
    const observation = createQualificationTransportObservation(original);
    const pending = observation.run({}, controller.signal, () => observation.fetch('https://example.test', { signal: controller.signal }));
    controller.abort(); await expect(pending).rejects.toBe(error); await observation.drain();
    expect(original.mock.calls[0]![1]!.signal).toBe(controller.signal);
    expect(observation.events.map(e => e.stage)).toEqual(['fetch_start', 'request_abort', 'fetch_abort', 'fetch_error', 'sdk_settled']);
  });
  it('binds unchanged v3 scorer/request sources and semantics with distinct observational identity', () => {
    expect(qualificationSemanticsDigest(QUALIFICATION_CONTRACT_V4)).toBe(qualificationSemanticsDigest(QUALIFICATION_CONTRACT_V3));
    expect(validateQualificationRecordsV4).toBe(validateQualificationRecordsV3);
    expect(hashCanonical(QUALIFICATION_CONTRACT_V4)).not.toBe(hashCanonical(QUALIFICATION_CONTRACT_V3));
    expect(() => assertQualificationContractV4({ ...QUALIFICATION_CONTRACT_V4, pins: parseCorpusPins(QUALIFICATION_CONTRACT_V4.corpus),
      sourceSha256: Object.fromEntries(Object.keys(QUALIFICATION_CONTRACT_V4.sourceSha256).map(file => [file, qualificationSourceDigest(readFileSync(file, 'utf8'))])) })).not.toThrow();
    const runner = readFileSync('scripts/evaluation/b461/runQualificationV4.ts', 'utf8');
    expect(runner).toContain("from '@/lib/evaluation/benchmark/valueReadingBenchmarkRunV3'");
    expect(runner).toContain("from '@/lib/forgewing/runtime/valueReadingClientV3'");
    expect(runner).toContain('transport!.run(body');
    expect(QUALIFICATION_CONTRACT_V4.execution).toEqual(QUALIFICATION_CONTRACT_V3.execution);
    expect(QUALIFICATION_CONTRACT_V4.sourceSha256['lib/forgewing/runtime/valueReadingClientV3.ts']).toBe(QUALIFICATION_CONTRACT_V3.sourceSha256['lib/forgewing/runtime/valueReadingClientV3.ts']);
  });
});
