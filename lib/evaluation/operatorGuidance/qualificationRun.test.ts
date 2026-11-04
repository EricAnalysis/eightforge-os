import { execFileSync, spawnSync } from 'node:child_process';
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
  assertExactCohort, costUsd, GUIDANCE_BARS, GUIDANCE_CANDIDATE_FREEZE_FILE, GUIDANCE_QUALIFICATION_MODEL, GUIDANCE_RUN_DIR, GUIDANCE_WITHDRAWN_FREEZE_FILE, hardViolations, reservedCallUsd, type GuidanceRunRecord,
} from '@/scripts/evaluation/operator-guidance/contract';
import { HELDOUT_CASES } from '@/scripts/evaluation/operator-guidance/corpus';
import { materializeCase, type MaterializedCase } from '@/scripts/evaluation/operator-guidance/harness';
import { HELDOUT_LABELS } from '@/scripts/evaluation/operator-guidance/labels';
import { caseEvidenceFor } from '@/scripts/evaluation/operator-guidance/regression';
import {
  assertClaimsFinal, authenticateFreezeBody, authenticateFreezeForRun, authorizeFinalFreeze, committedProblem, executeGuidanceRun, finalizeFreeze, labelVerificationProblem, refuseExistingOutput, regradeSealedRun, verifySealedRun, writeNewJson, type FrozenGuidance, type GuidanceAsk,
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
    expect(result.card.verdict).toBe('FAIL_SPEND_INTEGRITY');
  }, 120_000);

  it('fails on a reservation breach by the very last call, and keeps the whole run as evidence', async () => {
    let calls = 0;
    const ask: GuidanceAsk = async (request) => {
      calls += 1;
      return reply(answer(request), calls === 24 ? { inputTokens: 100_000, outputTokens: 2_400 } : {});
    };
    const result = await executeGuidanceRun({ out: out(), frozen, ask });
    const last = HELDOUT_CASES.at(-1)!.caseId;
    expect(calls).toBe(24);
    expect(result.records.some((record) => record.status === 'not_called')).toBe(false);
    expect(result.card.verdict).toBe('FAIL_SPEND_INTEGRITY');
    expect(result.card.spendBreaches).toMatchObject([{ code: 'reservation_exceeded', caseId: last }]);
    // Everything the run produced survives a failing verdict, and says why.
    expect(readdirSync(out()).sort()).toEqual(['SHA256SUMS.txt', 'freeze.json', 'records.json', 'run-health.json', 'scorecard.json', 'started.json']);
    verifySealedRun(out());
    const sealed = JSON.parse(readFileSync(path.join(out(), 'records.json'), 'utf8')) as { records: GuidanceRunRecord[] };
    expect(sealed.records).toHaveLength(24);
    expect(sealed.records.every((record) => record.rawOutput != null && record.providerRequestId === 'req-stub')).toBe(true);
    expect(JSON.parse(readFileSync(path.join(out(), 'run-health.json'), 'utf8')).spendBreaches).toHaveLength(1);
    await expect(regradeSealedRun(out(), frozen)).resolves.toMatchObject({ verdict: 'FAIL_SPEND_INTEGRITY' });
  }, 120_000);

  it('fails when the very last call takes the run over the $1.00 ceiling', async () => {
    let calls = 0;
    const ask: GuidanceAsk = async (request) => {
      calls += 1;
      return reply(answer(request), calls === 24 ? { inputTokens: 400_000, outputTokens: 2_400 } : {});
    };
    const result = await executeGuidanceRun({ out: out(), frozen, ask });
    expect(result.spentUsd).toBeGreaterThan(GUIDANCE_BARS.spendCeilingUsd);
    expect(result.card.verdict).toBe('FAIL_SPEND_INTEGRITY');
    expect(result.card.spendBreaches.map((breach) => breach.code)).toEqual(['reservation_exceeded', 'spend_ceiling_exceeded']);
  }, 120_000);

  it('a regrade still fails a breach whose recorded cost was rewritten and resealed', async () => {
    let calls = 0;
    const ask: GuidanceAsk = async (request) => {
      calls += 1;
      return reply(answer(request), calls === 24 ? { inputTokens: 100_000, outputTokens: 2_400 } : {});
    };
    await executeGuidanceRun({ out: out(), frozen, ask });
    const file = path.join(out(), 'records.json');
    const run = JSON.parse(readFileSync(file, 'utf8')) as { freezeSha256: string; records: GuidanceRunRecord[] };
    writeFileSync(file, JSON.stringify({ ...run, records: run.records.map((record) => ({ ...record, costUsd: 0 })) }));
    const names = readdirSync(out()).filter((name) => name !== 'SHA256SUMS.txt').sort();
    writeFileSync(path.join(out(), 'SHA256SUMS.txt'), `${names.map((name) => `${sha256(readFileSync(path.join(out(), name), 'utf8'))}  ${name}`).join('\n')}\n`);
    verifySealedRun(out());
    await expect(regradeSealedRun(out(), frozen)).resolves.toMatchObject({ verdict: 'FAIL_SPEND_INTEGRITY' });
  }, 120_000);

  it.each([
    ['negative', { inputTokens: -1_000_000 }],
    ['zero input', { inputTokens: 0 }],
    ['fractional', { outputTokens: 0.5 }],
  ])('charges the whole reservation when reported usage is %s, so it cannot buy more calls', async (_name, usage) => {
    const ask: GuidanceAsk = async (request) => reply(answer(request), usage);
    const result = await executeGuidanceRun({ out: out(), frozen, ask });
    const first = result.records[0]!;
    expect(first.costUsd).toBe(reservedCallUsd(built.get(first.caseId)!.request));
    expect(result.spentUsd).toBeLessThanOrEqual(GUIDANCE_BARS.spendCeilingUsd);
    expect(result.records.at(-1)!.status).toBe('not_called');
  }, 120_000);

  it('seals what was paid for when the run cannot finish, and says why with a fixed code', async () => {
    const wrong = signed({ ...frozen, freezeSha256: undefined, requests: frozen.requests.map((entry, index) => (index === 0 ? { ...entry, bodySha256: 'another request' } : entry)) });
    const ask: GuidanceAsk = async (request) => reply(answer(request));
    await expect(executeGuidanceRun({ out: out(), frozen: wrong, ask })).rejects.toThrow('COHORT_INVALID');
    expect(readdirSync(out()).sort()).toEqual(['SHA256SUMS.txt', 'freeze.json', 'records.json', 'run-failure.json', 'started.json']);
    verifySealedRun(out());
    expect(JSON.parse(readFileSync(path.join(out(), 'records.json'), 'utf8')).records).toHaveLength(24);
    const failure = JSON.parse(readFileSync(path.join(out(), 'run-failure.json'), 'utf8'));
    expect(failure).toMatchObject({ failure: 'COHORT_INVALID', callsRecorded: 24 });
    expect(failure.chargedUsd).toBeGreaterThan(0);
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

describe('only a genuinely finalized freeze authorizes a paid run', () => {
  const body = { contract: 'rehearsal', labelSet: { digest: 'labels' }, requests: [], pinnedSources: { 'a.ts': 'digest-a' } };
  const current = signed(body);
  const candidate = (): FrozenGuidance => ({ ...current, implementationCommit: 'branch-commit', status: 'candidate_not_final' });
  const verified = (value: object = {}) => ({ status: 'verified', candidateFreezeSha256: current.freezeSha256, labelSetDigest: 'labels', verifiedBy: 'Someone else', verifiedOn: '2026-11-04', independentOfAuthor: true, ...value });
  const verification = (value: object = {}) => { const file = path.join(dir, 'verification.json'); writeFileSync(file, JSON.stringify(verified(value))); return file; };
  const final = () => finalizeFreeze(candidate(), current, verification());

  it('refuses a verification without a record, or of anything but exactly this candidate and these labels', () => {
    const problem = (value: object) => labelVerificationProblem(candidate(), verification(value));
    expect(labelVerificationProblem(candidate(), path.join(dir, 'absent.json'))).toContain('no independent label verification');
    expect(problem({})).toBeNull();
    expect(problem({ status: 'pending' })).toContain('pending');
    expect(problem({ candidateFreezeSha256: 'another candidate' })).toContain('another candidate');
    expect(problem({ candidateFreezeSha256: undefined })).toContain('another candidate');
    expect(problem({ labelSetDigest: 'other' })).toContain('other labels');
    expect(problem({ verifiedBy: ' ' })).toContain('independent verifier');
    expect(problem({ independentOfAuthor: false })).toContain('independent verifier');
    expect(problem({ verifiedOn: '' })).toContain('when');
    writeFileSync(path.join(dir, 'torn.json'), '{');
    expect(labelVerificationProblem(candidate(), path.join(dir, 'torn.json'))).toContain('unreadable');
  });

  it('finalizes a verified candidate, and keeps its digest', () => {
    const made = final();
    expect(made).toMatchObject({ status: 'final', freezeSha256: current.freezeSha256 });
    expect(() => authorizeFinalFreeze(made, current, verification())).not.toThrow();
  });

  it('will not finalize an unverified candidate, a tampered one, or one already final', () => {
    expect(() => finalizeFreeze(candidate(), current, path.join(dir, 'absent.json'))).toThrow('LABELS_NOT_VERIFIED');
    expect(() => finalizeFreeze({ ...candidate(), contract: 'edited' }, current, verification())).toThrow('FREEZE_NOT_AUTHENTIC');
    expect(() => finalizeFreeze(signed({ ...body, contract: 'other' }) as FrozenGuidance, current, verification())).toThrow('FREEZE_DIFFERS');
    expect(() => finalizeFreeze(final(), current, verification())).toThrow('FREEZE_NOT_CANDIDATE');
  });

  it('refuses a candidate, even one whose status was edited to final and whose labels are verified', () => {
    const file = verification();
    expect(() => authorizeFinalFreeze(candidate(), current, file)).toThrow('FREEZE_NOT_FINAL');
    expect(() => authorizeFinalFreeze({ ...candidate(), status: 'final' }, current, file)).toThrow('FREEZE_NOT_FINAL');
    expect(() => assertClaimsFinal({ ...candidate(), status: 'final' })).toThrow('FREEZE_NOT_FINAL');
  });

  it('refuses a final freeze with any metadata field edited', () => {
    const file = verification();
    const made = final();
    const edited = (value: object) => () => authorizeFinalFreeze({ ...made, ...value }, current, file);
    expect(edited({ status: 'candidate_not_final' })).toThrow('FREEZE_NOT_FINAL');
    expect(edited({ implementationCommit: 'another-commit' })).toThrow('FREEZE_NOT_FINAL');
    expect(edited({ finalizationSha256: 'forged' })).toThrow('FREEZE_NOT_FINAL');
    const forged = { ...(made.finalization as object), verifiedBy: 'Someone forged' };
    expect(edited({ finalization: forged })).toThrow('FREEZE_NOT_FINAL');
    // Recomputing the outer digest does not help: it must equal what the verification rebuilds.
    expect(edited({ finalization: forged, finalizationSha256: hashCanonical(forged) })).toThrow('FREEZE_NOT_FINAL');
    const anotherCandidate = { ...(made.finalization as object), candidateFreezeSha256: 'another candidate' };
    expect(edited({ finalization: anotherCandidate, finalizationSha256: hashCanonical(anotherCandidate) })).toThrow('FREEZE_NOT_FINAL');
  });

  it('refuses when the verification changes or disappears after finalizing', () => {
    const made = final();
    expect(() => authorizeFinalFreeze(made, current, verification({ verifiedOn: '2026-12-25' }))).toThrow('FREEZE_NOT_FINAL');
    expect(() => authorizeFinalFreeze(made, current, verification({ labelSetDigest: 'other' }))).toThrow('LABELS_NOT_VERIFIED');
    expect(() => authorizeFinalFreeze(made, current, path.join(dir, 'absent.json'))).toThrow('LABELS_NOT_VERIFIED');
  });

  it('refuses a final freeze whose body was edited, or that no longer matches the sources', () => {
    const made = final();
    const file = verification();
    expect(() => authorizeFinalFreeze({ ...made, labelSet: { digest: 'edited' } }, current, file)).toThrow('FREEZE_NOT_AUTHENTIC');
    expect(() => authorizeFinalFreeze(made, signed({ ...body, pinnedSources: { 'a.ts': 'changed' } }), file)).toThrow('FREEZE_DIFFERS');
  });

  it('a squash merge of the same sources stays authorized, because no commit id is required to exist', () => {
    const made = final();
    expect(made.implementationCommit).toBe('branch-commit');
    const builtOnMain = { ...signed(body), implementationCommit: 'squash-commit-on-main', status: 'candidate_not_final' };
    expect(() => authorizeFinalFreeze(made, builtOnMain, verification())).not.toThrow();
  });

  it('the withdrawn freeze, its replaced candidate and the current candidate cannot authorize a run as they stand', () => {
    for (const file of [GUIDANCE_WITHDRAWN_FREEZE_FILE, 'scripts/evaluation/artifacts/operator-guidance-v3/freeze-r2.json', GUIDANCE_CANDIDATE_FREEZE_FILE]) {
      expect(() => assertClaimsFinal(JSON.parse(readFileSync(file, 'utf8')) as FrozenGuidance)).toThrow('FREEZE_NOT_FINAL');
    }
  });
});

describe('authorization has to be on the record', () => {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (name: string, text = '{}\n') => writeFileSync(path.join(dir, name), text);

  beforeEach(() => {
    git('init', '-b', 'main');
    write('seed.json');
    git('add', '.');
    git('commit', '-m', 'seed');
  });

  it('refuses a file that is untracked, only staged, or changed since its commit', () => {
    write('final.json');
    expect(committedProblem(['final.json'], dir)).toContain('not committed');
    git('add', 'final.json');
    expect(committedProblem(['final.json'], dir)).toContain('uncommitted changes');
    git('commit', '-m', 'final');
    expect(committedProblem(['final.json'], dir)).toBeNull();
    write('final.json', '{"status":"final"}\n');
    expect(committedProblem(['final.json'], dir)).toContain('uncommitted changes');
  });

  it('reads a path with brackets literally', () => {
    write('[id].json');
    write('i.json');
    git('add', 'i.json');
    git('commit', '-m', 'only the lookalike');
    expect(committedProblem(['[id].json'], dir)).toContain('not committed');
  });

  it('accepts what a squash merge landed under a commit id the branch never had', () => {
    git('checkout', '-b', 'feature');
    write('final.json');
    git('add', 'final.json');
    git('commit', '-m', 'on the branch');
    const branchCommit = git('rev-parse', 'HEAD').trim();
    git('checkout', 'main');
    git('merge', '--squash', 'feature');
    git('commit', '-m', 'squashed');
    git('branch', '-D', 'feature');
    expect(git('rev-parse', 'HEAD').trim()).not.toBe(branchCommit);
    expect(committedProblem(['final.json'], dir)).toBeNull();
  });
});

describe('historical evidence is never overwritten', () => {
  const WITHDRAWN_SHA256 = '4bb943c9f5572feab58a755c8373cf7ab80f50a9a658c6b10c12ecbf00d3e0cd';
  const fileSha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  /** The real command, run the way the runbook runs it, with no credential in its environment. */
  const qualify = (...args: string[]) => {
    const env = { ...process.env };
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[key];
    return spawnSync(process.execPath, ['node_modules/vite-node/vite-node.mjs', '--config', 'vitest.config.ts', 'scripts/evaluation/operator-guidance/qualify.ts', '--', ...args], { env, encoding: 'utf8' });
  };

  it('a write refuses an existing file, leaving it byte for byte', () => {
    const file = path.join(dir, 'evidence.json');
    writeFileSync(file, 'original');
    expect(() => refuseExistingOutput(file)).toThrow('OUTPUT_EXISTS');
    expect(() => writeNewJson(file, { replaced: true })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('original');
    const fresh = path.join(dir, 'fresh.json');
    expect(() => refuseExistingOutput(fresh)).not.toThrow();
    writeNewJson(fresh, { written: true });
    expect(JSON.parse(readFileSync(fresh, 'utf8'))).toEqual({ written: true });
  });

  it.each(['preflight', 'regression'])('%s refuses an existing --out before doing anything else', (command) => {
    const file = path.join(dir, 'evidence.json');
    writeFileSync(file, 'original');
    const result = qualify(command, '--out', file);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('OUTPUT_EXISTS');
    expect(readFileSync(file, 'utf8')).toBe('original');
  }, 120_000);

  it('the withdrawn freeze is unchanged after every refusal', () => {
    expect(fileSha256(GUIDANCE_WITHDRAWN_FREEZE_FILE)).toBe(WITHDRAWN_SHA256);
  });

  it.each([
    ['the candidate as it stands', (freeze: object) => freeze],
    ['the candidate with its status edited to final', (freeze: object) => ({ ...freeze, status: 'final' })],
  ])('the paid run refuses %s, with no credential or run directory touched', (_name, edit) => {
    const file = path.join(dir, 'freeze.json');
    writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(GUIDANCE_CANDIDATE_FREEZE_FILE, 'utf8')) as object)));
    const before = existsSync(GUIDANCE_RUN_DIR);
    const result = qualify('run', '--freeze', file, '--out', GUIDANCE_RUN_DIR, '--confirm-paid-run');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FREEZE_NOT_FINAL');
    expect(existsSync(GUIDANCE_RUN_DIR)).toBe(before);
  }, 120_000);

  it('the paid run does not start until every gate has passed', () => {
    const source = readFileSync('scripts/evaluation/operator-guidance/qualify.ts', 'utf8');
    const runBody = source.slice(source.indexOf('async function run()'), source.indexOf('async function grade()'));
    const order = ['assertClaimsFinal(frozen)', 'committedProblem([freezeFile', 'authorizeFinalFreeze(frozen', 'ANTHROPIC_API_KEY', 'executeGuidanceRun('].map((step) => runBody.indexOf(step));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
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
