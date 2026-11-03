import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  classifyGuidanceCallFailure,
  GUIDANCE_FAILURE_CLASSES,
  guidanceStatusForFailure,
} from '@/scripts/evaluation/operator-guidance/failureClass';

const V1 = 'scripts/evaluation/artifacts/operator-guidance-v1';
const V2 = 'scripts/evaluation/artifacts/operator-guidance-v2';
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

describe('the v1 attempt is void, and its evidence is intact', () => {
  const record = json(path.join(V1, 'VOID.json'));

  it('is classified void, and not as a model fail', () => {
    expect(record.classification).toBe('OPERATOR GUIDANCE V1 = VOID / PRE-PROVIDER FAILURE');
    expect(record.isModelQualificationFail).toBe(false);
    expect(record.contract).toBe('operator_guidance_qualification_v1');
    expect(record.successor).toBe('operator_guidance_qualification_v2');
    expect(record.freezeSha256).toBe(json(path.join(V1, 'freeze.json')).freezeSha256);
  });

  it('names every evidence file by the digest it was found with', () => {
    const files = readdirSync(path.join(V1, 'run')).sort();
    expect(files).toEqual(['SHA256SUMS.txt', 'freeze.json', 'records.json', 'scorecard.json', 'started.json']);
    expect(Object.keys(record.evidence.sha256).sort()).toEqual(files);
    for (const file of files) expect(sha256(readFileSync(path.join(V1, 'run', file))), file).toBe(record.evidence.sha256[file]);
  });

  it('agrees with the run\'s own sums', () => {
    const sums = readFileSync(path.join(V1, 'run/SHA256SUMS.txt'), 'utf8').trim().split('\n').map((line) => line.split(/\s+/u));
    expect(sums).toHaveLength(4);
    for (const [digest, file] of sums) expect(record.evidence.sha256[file!], file).toBe(digest);
  });

  it('holds what the void record says: 24 attempts, no model answer', () => {
    const { records } = json(path.join(V1, 'run/records.json')) as { records: Array<Record<string, unknown>> };
    expect(records).toHaveLength(record.counts.attempted);
    expect(records.filter((entry) => entry.rawOutput != null)).toEqual([]);
    expect(records.filter((entry) => entry.providerRequestId != null)).toEqual([]);
    expect(records.filter((entry) => entry.inputTokens != null || entry.outputTokens != null)).toEqual([]);
    expect(new Set(records.map((entry) => entry.status))).toEqual(new Set(['provider_failed']));
  });

  it('holds no credential', () => {
    for (const file of readdirSync(path.join(V1, 'run'))) expect(readFileSync(path.join(V1, 'run', file), 'utf8')).not.toMatch(/sk-ant|x-api-key|ANTHROPIC_API_KEY/u);
  });
});

describe('v2 was the same benchmark', () => {
  const v1 = json(path.join(V1, 'freeze.json'));
  const v2 = json(path.join(V2, 'freeze.json'));

  it('has its own identity', () => {
    expect(v2.contract).toBe('operator_guidance_qualification_v2');
    expect(v2.freezeSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(v2.freezeSha256).not.toBe(v1.freezeSha256);
    expect(v2.supersedes).toMatchObject({ contract: 'operator_guidance_qualification_v1', freezeSha256: v1.freezeSha256 });
  });

  it.each(['barsDigest', 'bars', 'census', 'fixtures', 'labelSet', 'perFixture', 'perIntent', 'pricing', 'request', 'requests'])('carries %s forward unchanged', (key) => {
    expect(v2[key]).toEqual(v1[key]);
  });

  it('moved only pins that cannot reach the 24 requests, and left the validators and adapter alone', () => {
    expect(v2.parityWithV1.pinsChanged).toEqual([
      'app/api/projects/[id]/ask/route.ts',
      'lib/projectIntelligence/contextPlan.ts',
      'lib/projectIntelligence/operatorRecommendation.ts',
      'lib/projectIntelligence/projectContext.ts',
      'lib/server/projectIntelligenceRead.ts',
      'scripts/evaluation/operator-guidance/contract.ts',
    ]);
    for (const file of ['lib/server/ai/askProject.ts', 'lib/server/ai/operatorGuidance.ts', 'lib/server/caseInvestigationRunner.ts', 'lib/server/ai/claudeSampling.ts', 'lib/server/ai/claudeRequestOptions.ts', 'scripts/evaluation/operator-guidance/labels.ts', 'scripts/evaluation/operator-guidance/corpus.ts', 'scripts/evaluation/operator-guidance/harness.ts']) {
      expect(v2.parityWithV1.pinsUnchanged, file).toContain(file);
    }
  });

  it('refuses a second evidence directory, so the one-run rule cannot be stepped around', () => {
    const script = readFileSync('scripts/evaluation/operator-guidance/qualify.ts', 'utf8');
    expect(script).toContain("this contract's single run writes only to");
    expect(script).toContain('this contract\'s run directory is already used');
    expect(script).toContain('PARITY_FAILED');
  });
});

describe('the v2 run failed, and its evidence is intact', () => {
  const record = json(path.join(V2, 'RESULT.json'));
  const run = path.join(V2, 'run');

  it('used its one run directory', () => {
    expect(existsSync(run)).toBe(true);
  });

  it('is a real failure, with the verdict the scorecard gave', () => {
    const card = json(path.join(run, 'scorecard.json'));
    expect(record.classification).toBe('OPERATOR GUIDANCE V2 = FAIL_HARD_CORRECTNESS');
    expect(record.status).toBe('failed');
    expect(record.isVoid).toBe(false);
    expect(record.diagnosis.doesNotChangeVerdict).toBe(true);
    expect(card.verdict).toBe('FAIL_HARD_CORRECTNESS');
    expect(record.counts).toMatchObject({ calls: card.calls, accepted: card.accepted, casesWithHardViolations: card.violations.length });
    expect(record.spendUsd).toBe(card.spendUsd);
    expect(record.diagnosis.hardBarHits.map((hit: { caseId: string }) => hit.caseId).sort()).toEqual(card.violations.map((hit: { caseId: string }) => hit.caseId).sort());
  });

  it('ran from the frozen identity', () => {
    const frozen = json(path.join(V2, 'freeze.json'));
    expect(record.contract).toBe(frozen.contract);
    expect(record.freezeSha256).toBe(frozen.freezeSha256);
    expect(json(path.join(run, 'freeze.json')).freezeSha256).toBe(frozen.freezeSha256);
    expect(json(path.join(run, 'started.json')).freezeSha256).toBe(frozen.freezeSha256);
    expect(json(path.join(run, 'records.json')).freezeSha256).toBe(frozen.freezeSha256);
  });

  it('names every evidence file by the digest it was found with', () => {
    const files = readdirSync(run).sort();
    expect(files).toEqual(['SHA256SUMS.txt', 'freeze.json', 'records.json', 'run-health.json', 'scorecard.json', 'started.json']);
    expect(Object.keys(record.evidence.sha256).sort()).toEqual(files);
    for (const file of files) expect(sha256(readFileSync(path.join(run, file))), file).toBe(record.evidence.sha256[file]);
  });

  it('agrees with the run\'s own sums', () => {
    const sums = readFileSync(path.join(run, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').map((line) => line.split(/\s+/u));
    expect(sums).toHaveLength(5);
    for (const [digest, file] of sums) expect(record.evidence.sha256[file!], file).toBe(digest);
  });

  it('holds what the record says: 24 answers from the frozen model, 14 accepted', () => {
    const { records } = json(path.join(run, 'records.json')) as { records: Array<Record<string, unknown>> };
    expect(records).toHaveLength(record.counts.calls);
    expect(records.filter((entry) => entry.rawOutput == null)).toEqual([]);
    expect(new Set(records.map((entry) => entry.returnedModel))).toEqual(new Set([record.model]));
    expect(records.filter((entry) => entry.status === 'accepted')).toHaveLength(record.counts.accepted);
    expect(records.filter((entry) => entry.status === 'rejected')).toHaveLength(record.counts.rejected);
  });

  it('holds no credential', () => {
    for (const file of readdirSync(run)) expect(readFileSync(path.join(run, file), 'utf8')).not.toMatch(/sk-ant|x-api-key|ANTHROPIC_API_KEY/u);
  });
});

describe('classifying a failed call', () => {
  const SECRET = 'sk-ant-secret and the customer text of a request';
  const provider = (status: number, type: string, message = SECRET, requestId: string | null = 'req_123') =>
    APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers(requestId ? { 'request-id': requestId } : {}));

  it.each([
    [402, 'billing_error', 'provider_billing'],
    [401, 'authentication_error', 'provider_authentication'],
    [403, 'permission_error', 'provider_permission'],
    [404, 'not_found_error', 'provider_model_not_found'],
    [429, 'rate_limit_error', 'provider_rate_limited'],
    [400, 'invalid_request_error', 'provider_invalid_request'],
    [413, 'request_too_large', 'provider_invalid_request'],
    [500, 'api_error', 'provider_unavailable'],
    [529, 'overloaded_error', 'provider_unavailable'],
  ])('%i %s is %s, with the request id and without the message', (status, type, expected) => {
    const failure = classifyGuidanceCallFailure(provider(status, type));
    expect(failure).toEqual({ failureClass: expected, reachedProvider: true, httpStatus: status, providerErrorType: type, providerRequestId: 'req_123' });
    expect(JSON.stringify(failure)).not.toContain('secret');
  });

  it('reads a low balance that came back as a 400 as billing, keeping none of its text', () => {
    const failure = classifyGuidanceCallFailure(provider(400, 'invalid_request_error', 'Your credit balance is too low to access the API.'));
    expect(failure.failureClass).toBe('provider_billing');
    expect(JSON.stringify(failure)).not.toMatch(/credit|balance/iu);
  });

  it('does not repeat an error type the provider did not publish', () => {
    expect(classifyGuidanceCallFailure(provider(400, SECRET)).providerErrorType).toBeNull();
    expect(classifyGuidanceCallFailure(provider(400, 'invalid_request_error', SECRET, 'not a request id!')).providerRequestId).toBeNull();
  });

  it('tells a call that never arrived from one the provider refused', () => {
    expect(classifyGuidanceCallFailure(new APIConnectionError({ message: SECRET }))).toEqual({ failureClass: 'pre_provider_connection', reachedProvider: false, httpStatus: null, providerErrorType: null, providerRequestId: null });
    expect(classifyGuidanceCallFailure(new Error('Claude is not configured: ANTHROPIC_API_KEY is missing on the server.')).failureClass).toBe('pre_provider_credential');
  });

  it('names a timeout', () => {
    for (const error of [new APIConnectionTimeoutError(), new APIUserAbortError(), provider(408, 'timeout_error'), Object.assign(new Error('x'), { name: 'AbortError' })]) {
      const failure = classifyGuidanceCallFailure(error);
      expect(failure.failureClass).toBe('timeout');
      expect(guidanceStatusForFailure(failure)).toBe('provider_timeout');
    }
  });

  it('calls anything else a local failure, whatever its text', () => {
    for (const error of [new TypeError(SECRET), new Error(SECRET), SECRET, null]) {
      const failure = classifyGuidanceCallFailure(error);
      expect(failure.failureClass).toBe('local_error');
      expect(guidanceStatusForFailure(failure)).toBe('provider_failed');
      expect(JSON.stringify(failure)).not.toContain('secret');
    }
  });

  it('only ever returns a declared class', () => {
    const errors = [provider(418, 'x'), provider(400, 'y'), new Error('z'), new APIConnectionError({})];
    for (const error of errors) expect(GUIDANCE_FAILURE_CLASSES).toContain(classifyGuidanceCallFailure(error).failureClass);
  });

  it('keeps the SDK out of the run script, which still has one provider path', () => {
    const script = readFileSync('scripts/evaluation/operator-guidance/qualify.ts', 'utf8');
    expect(script).not.toMatch(/@anthropic-ai\/sdk|\.message\b.*writeJson/u);
    expect(script.match(/askOperatorGuidanceWithClaude\(/gu)).toHaveLength(1);
    expect(script).not.toContain('error.message');
  });
});
