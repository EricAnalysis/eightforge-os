import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getClaudeClientMock } = vi.hoisted(() => ({ getClaudeClientMock: vi.fn() }));
vi.mock('@/lib/server/ai/claudeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai/claudeClient')>()),
  getClaudeClient: getClaudeClientMock,
}));

import { hashCanonical } from '@/lib/extraction/domain/hash';

import {
  assertExactCohort, costUsd, GUIDANCE_BARS, GUIDANCE_QUALIFICATION_MODEL, GUIDANCE_WITHDRAWN_FREEZE_FILE, hardViolations, reservedCallUsd, type GuidanceRunRecord,
} from '@/scripts/evaluation/operator-guidance/contract';
import { HELDOUT_CASES } from '@/scripts/evaluation/operator-guidance/corpus';
import { materializeCase, type MaterializedCase } from '@/scripts/evaluation/operator-guidance/harness';
import { HELDOUT_LABELS } from '@/scripts/evaluation/operator-guidance/labels';
import { caseEvidenceFor } from '@/scripts/evaluation/operator-guidance/regression';
import {
  authenticateFreezeBody, authenticateFreezeForRun, executeGuidanceRun, labelVerificationProblem, regradeSealedRun, verifySealedRun, type FrozenGuidance, type GuidanceAsk,
} from '@/scripts/evaluation/operator-guidance/runner';

/**
 * The paid run's whole path with a stand-in provider, writing to a temporary folder:
 * directory creation, spend accumulation, per-call persistence, terminal scoring and the
 * seal. `fetch` refuses and the real client is never asked for, so nothing leaves this
 * machine. Its results say nothing about any model.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const built = new Map<string, MaterializedCase>();
let frozen: FrozenGuidance;
let dir: string;

function signed(body: Record<string, unknown>): FrozenGuidance {
  return { ...body, freezeSha256: hashCanonical(body) } as FrozenGuidance;
}

/** Every citation, a plain answer, and the first offered step. */
function answer(request: Parameters<GuidanceAsk>[0], text = 'The cited records show where this stands.') {
  const citations = (request.context as { cite: Record<string, string> }[]).flatMap((section) => Object.keys(section.cite)).slice(0, 16);
  return JSON.stringify({ answer: text, nextStepKind: request.allowedNextSteps[0], nextStepInstruction: 'Review the cited records.', citations, missingInformation: ['Still open.'], confidence: 'medium' });
}

const reply = (raw: string, usage: Partial<{ inputTokens: number | null; outputTokens: number | null; returnedModel: string | null }> = {}) => ({
  raw, truncated: false, refused: false,
  observation: { returnedModel: GUIDANCE_QUALIFICATION_MODEL, providerRequestId: 'req-stub', stopReason: 'end_turn', inputTokens: 2_000, outputTokens: 400, latencyMs: 5, ...usage },
});

beforeAll(async () => {
  for (const item of HELDOUT_CASES) built.set(item.caseId, await materializeCase(item));
  frozen = signed({ contract: 'rehearsal', labelSet: { digest: 'x' },
    requests: HELDOUT_CASES.map((item) => ({ caseId: item.caseId, bodySha256: sha256(JSON.stringify(built.get(item.caseId)!.request)) })) });
}, 120_000);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'guidance-run-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', () => { throw new Error('NETWORK_REFUSED'); });
  getClaudeClientMock.mockReset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const out = () => path.join(dir, 'run');

describe('rehearsal of the run path, stand-in provider only', () => {
  it('makes exactly 24 calls, persists as it goes, scores and seals, with no provider', async () => {
    let calls = 0;
    const ask: GuidanceAsk = async (request) => {
      calls += 1;
      const persisted = calls > 1 ? JSON.parse(readFileSync(path.join(out(), 'records.json'), 'utf8')).records.length : 0;
      expect(persisted).toBe(calls - 1);
      expect(request.model).toBe(GUIDANCE_QUALIFICATION_MODEL);
      return reply(calls % 4 === 0 ? answer(request, 'It lists 987654 items and is attached_to the contract.') : answer(request));
    };
    const result = await executeGuidanceRun({ out: out(), frozen, ask });
    expect(calls).toBe(24);
    expect(getClaudeClientMock).not.toHaveBeenCalled();
    expect(result.records.map((record) => record.caseId)).toEqual(HELDOUT_CASES.map((item) => item.caseId));
    expect(result.card).toMatchObject({ verdict: 'PENDING_HUMAN_REVIEW', calls: 24, accepted: 18, fallback: 6, violations: [] });
    expect(result.card.allRejectionReasons).toEqual({ unsupported_number: 6, internal_vocabulary: 6 });
    expect(result.card.fallbackReasons).toEqual({ unsupported_number: 6 });
    expect(readdirSync(out()).sort()).toEqual(['SHA256SUMS.txt', 'freeze.json', 'human-review-packet.json', 'records.json', 'run-health.json', 'scorecard.json', 'started.json']);
    verifySealedRun(out());
    await expect(regradeSealedRun(out(), frozen)).resolves.toMatchObject({ verdict: 'PENDING_HUMAN_REVIEW', accepted: 18 });
  }, 120_000);

  it('fails as incomplete, and spends nothing more, once a whole reservation no longer fits', async () => {
    let calls = 0;
    const ask: GuidanceAsk = async (request) => { calls += 1; return reply(answer(request), { inputTokens: 3_000, outputTokens: 2_400 }); };
    const result = await executeGuidanceRun({ out: out(), frozen, ask });
    expect(calls).toBeLessThan(24);
    expect(result.spentUsd).toBeLessThanOrEqual(GUIDANCE_BARS.spendCeilingUsd);
    expect(result.card.verdict).toBe('FAIL_INCOMPLETE_RUN');
    expect(result.records.filter((record) => record.status === 'not_called').every((record) => record.rejectionReason === 'spend_ceiling')).toBe(true);
  }, 120_000);

  it('charges a failed call its whole reservation, and stops within the ceiling', async () => {
    let calls = 0;
    const ask: GuidanceAsk = async () => { calls += 1; throw new TypeError('boom'); };
    const result = await executeGuidanceRun({ out: out(), frozen, ask });
    const first = result.records[0]!;
    expect(first.costUsd).toBe(reservedCallUsd(built.get(first.caseId)!.request));
    expect(result.spentUsd).toBeLessThanOrEqual(GUIDANCE_BARS.spendCeilingUsd);
    expect(calls).toBeLessThan(24);
  }, 120_000);

  it('charges the whole reservation when usage is not reported', async () => {
    const ask: GuidanceAsk = async (request) => reply(answer(request), { inputTokens: null });
    const result = await executeGuidanceRun({ out: out(), frozen, ask });
    const first = result.records[0]!;
    expect(first.costUsd).toBe(reservedCallUsd(built.get(first.caseId)!.request));
  }, 120_000);

  it('halts as soon as one call costs more than was reserved for it', async () => {
    let calls = 0;
    const ask: GuidanceAsk = async (request) => { calls += 1; return reply(answer(request), { inputTokens: 100_000, outputTokens: 2_400 }); };
    const result = await executeGuidanceRun({ out: out(), frozen, ask });
    expect(calls).toBe(1);
    expect(result.records.slice(1).every((record) => record.status === 'not_called' && record.rejectionReason === 'spend_reservation_exceeded')).toBe(true);
    expect(result.card.verdict).toBe('FAIL_INCOMPLETE_RUN');
  }, 120_000);

  it('fails hard when an answer does not say which model gave it', async () => {
    const ask: GuidanceAsk = async (request) => reply(answer(request), { returnedModel: null });
    const result = await executeGuidanceRun({ out: out(), frozen, ask });
    expect(result.card.verdict).toBe('FAIL_HARD_CORRECTNESS');
    expect(result.card.violations.every((entry) => entry.codes.includes('wrong_model'))).toBe(true);
  }, 120_000);
});

describe('the spend reservation', () => {
  it('holds back a token per byte, the overhead and the full output, and fits one call under the ceiling', () => {
    const request = built.get('heldout-flagged-02')!.request;
    const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    expect(reservedCallUsd(request)).toBeGreaterThan(costUsd(bytes, 2_400));
    expect(reservedCallUsd(request)).toBeLessThan(0.15);
    expect(GUIDANCE_BARS).toMatchObject({ reservedTokensPerUtf8Byte: 1, reservedOverheadTokens: 2_000, spendCeilingUsd: 1 });
  });
});

describe('the freeze is authenticated, whole', () => {
  it('accepts its own body', () => {
    expect(() => authenticateFreezeBody(signed({ a: 1 }))).not.toThrow();
    expect(() => authenticateFreezeBody({ ...signed({ a: 1 }), implementationCommit: 'abc', status: 'final' })).not.toThrow();
  });

  it('refuses a body edited under its original digest', () => {
    const tampered = { ...signed({ a: 1, bars: { spendCeilingUsd: 1 } }), bars: { spendCeilingUsd: 100 } };
    expect(() => authenticateFreezeBody(tampered)).toThrow('FREEZE_NOT_AUTHENTIC');
    expect(() => authenticateFreezeForRun(tampered, signed({ a: 1, bars: { spendCeilingUsd: 1 } }))).toThrow('FREEZE_NOT_AUTHENTIC');
  });

  it('refuses an authentic freeze of anything but what this checkout would send', () => {
    expect(() => authenticateFreezeForRun(signed({ a: 1 }), signed({ a: 2 }))).toThrow('FREEZE_DIFFERS');
  });

  it('refuses the withdrawn freeze against this checkout', () => {
    const withdrawn = JSON.parse(readFileSync(GUIDANCE_WITHDRAWN_FREEZE_FILE, 'utf8')) as Record<string, unknown>;
    expect(() => authenticateFreezeForRun(withdrawn, signed({ a: 1 }))).toThrow('FREEZE_DIFFERS');
  });
});

describe('a final freeze needs independently verified labels', () => {
  const record = (value: object) => { const file = path.join(dir, 'verification.json'); writeFileSync(file, JSON.stringify(value)); return file; };

  it('refuses without a record, or with one for other labels', () => {
    expect(labelVerificationProblem('labels', path.join(dir, 'absent.json'))).toContain('no independent label verification');
    expect(labelVerificationProblem('labels', record({ status: 'verified', labelSetDigest: 'other', verifiedBy: 'Someone', independentOfAuthor: true }))).toContain('other labels');
    expect(labelVerificationProblem('labels', record({ status: 'pending', labelSetDigest: 'labels', verifiedBy: 'Someone', independentOfAuthor: true }))).toContain('pending');
    expect(labelVerificationProblem('labels', record({ status: 'verified', labelSetDigest: 'labels', verifiedBy: '', independentOfAuthor: true }))).toContain('independent verifier');
    expect(labelVerificationProblem('labels', record({ status: 'verified', labelSetDigest: 'labels', verifiedBy: 'Someone', independentOfAuthor: false }))).toContain('independent verifier');
  });

  it('accepts a record naming an independent verifier of exactly these labels', () => {
    expect(labelVerificationProblem('labels', record({ status: 'verified', labelSetDigest: 'labels', verifiedBy: 'Someone', independentOfAuthor: true }))).toBeNull();
  });

  it('no verification is recorded yet', () => {
    expect(existsSync('scripts/evaluation/artifacts/operator-guidance-v3/label-verification.json')).toBe(false);
  });
});

describe('only the exact cohort can be scored', () => {
  const recordFor = (caseId: string, overrides: Partial<GuidanceRunRecord> = {}): GuidanceRunRecord => ({
    caseId, status: 'accepted', rejectionReason: null, rawOutput: '{}', stopReason: 'end_turn', returnedModel: GUIDANCE_QUALIFICATION_MODEL, providerRequestId: 'req',
    inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, allowedNextSteps: [], requestBodySha256: frozen.requests.find((entry) => entry.caseId === caseId)!.bodySha256,
    floor: built.get(caseId)!.floor, shown: built.get(caseId)!.floor, ...overrides,
  });
  const honest = () => HELDOUT_CASES.map((item) => recordFor(item.caseId));

  it('accepts one record for each case, sent as frozen', () => {
    expect(() => assertExactCohort(honest(), frozen.requests)).not.toThrow();
  });

  it('refuses 24 copies of one clean record', () => {
    const copies = HELDOUT_CASES.map(() => recordFor('heldout-missing-01'));
    expect(() => assertExactCohort(copies, frozen.requests)).toThrow('COHORT_INVALID');
  });

  it('refuses a missing case, an extra case and a request that was not the frozen one', () => {
    expect(() => assertExactCohort(honest().slice(1), frozen.requests)).toThrow('COHORT_INVALID');
    expect(() => assertExactCohort([...honest(), recordFor('heldout-missing-01')], frozen.requests)).toThrow('COHORT_INVALID');
    const swapped = honest();
    swapped[0] = { ...swapped[0]!, requestBodySha256: 'another request' };
    expect(() => assertExactCohort(swapped, frozen.requests)).toThrow('COHORT_INVALID');
  });

  it('a regrade refuses evidence edited after sealing', async () => {
    const ask: GuidanceAsk = async (request) => reply(answer(request));
    await executeGuidanceRun({ out: out(), frozen, ask });
    const file = path.join(out(), 'scorecard.json');
    writeFileSync(file, `${readFileSync(file, 'utf8')} `);
    expect(() => verifySealedRun(out())).toThrow('RUN_NOT_SEALED');
    await expect(regradeSealedRun(out(), frozen)).rejects.toThrow('RUN_NOT_SEALED');
  }, 120_000);

  it('a regrade refuses a file added after sealing', async () => {
    const ask: GuidanceAsk = async (request) => reply(answer(request));
    await executeGuidanceRun({ out: out(), frozen, ask });
    writeFileSync(path.join(out(), 'extra.json'), '{}');
    expect(() => verifySealedRun(out())).toThrow('RUN_NOT_SEALED');
  }, 120_000);
});

describe('an answer must name the frozen model', () => {
  const score = (returnedModel: string | null) => hardViolations(
    { caseId: 'heldout-missing-01', status: 'accepted', rejectionReason: null, rawOutput: '{}', stopReason: 'end_turn', returnedModel, providerRequestId: 'req', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0,
      allowedNextSteps: built.get('heldout-missing-01')!.request.allowedNextSteps, requestBodySha256: 'x', floor: built.get('heldout-missing-01')!.floor, shown: built.get('heldout-missing-01')!.floor },
    HELDOUT_LABELS.find((label) => label.caseId === 'heldout-missing-01')!, caseEvidenceFor(built.get('heldout-missing-01')!),
  );

  it('fails closed on an unknown or another model', () => {
    expect(score(null)).toContain('wrong_model');
    expect(score('claude-sonnet-5-5')).toContain('wrong_model');
    expect(score(GUIDANCE_QUALIFICATION_MODEL)).not.toContain('wrong_model');
  });
});
