import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROJECT_ASK_GUIDANCE_ENABLED_ENV, PROJECT_ASK_QUALIFIED_MODELS, isProjectAskGuidanceProviderEnabled } from '@/lib/server/ai/askModel';
import { hashCanonical } from '@/lib/extraction/domain/hash';

import {
  authorityEscalationIn, costUsd, GUIDANCE_BARS, GUIDANCE_QUALIFICATION_MODEL, guidanceBarsDigest, hardViolations, scoreGuidanceQualification,
  tellsOperatorToObtainSource, worstCaseCallUsd, type CaseEvidence, type GuidanceRunRecord,
} from '@/scripts/evaluation/operator-guidance/contract';
import { PROJECT_FIXTURES, QUALIFICATION_CASES } from '@/scripts/evaluation/operator-guidance/corpus';
import { createFixtureDatabase, DECOY_MARKER, materializeCase, type MaterializedCase } from '@/scripts/evaluation/operator-guidance/harness';
import { GUIDANCE_LABELS, guidanceLabelSetDigest, type GuidanceCaseLabel } from '@/scripts/evaluation/operator-guidance/labels';

const labelFor = (caseId: string): GuidanceCaseLabel => GUIDANCE_LABELS.find((label) => label.caseId === caseId)!;

let built: ReadonlyMap<string, MaterializedCase> | null = null;
async function allCases(): Promise<ReadonlyMap<string, MaterializedCase>> {
  if (!built) {
    const entries = await Promise.all(QUALIFICATION_CASES.map(async (item) => [item.caseId, await materializeCase(item)] as const));
    built = new Map(entries);
  }
  return built;
}

function evidenceOf(item: MaterializedCase): CaseEvidence {
  return {
    transmitted: item.transmitted,
    recordIds: new Set(item.approvedContext.sections.filter((section) => section.transmitted).flatMap((section) => section.records.map((record) => record.recordId))),
    symbols: item.symbols,
    contextLabels: item.approvedContext.sections.flatMap((section) => section.records.map((record) => record.label)),
    decoyMarker: DECOY_MARKER,
  };
}

describe('census', () => {
  it('has exactly 24 cases, six per intent', () => {
    expect(QUALIFICATION_CASES).toHaveLength(24);
    const perIntent = new Map<string, number>();
    for (const item of QUALIFICATION_CASES) perIntent.set(item.intent, (perIntent.get(item.intent) ?? 0) + 1);
    expect([...perIntent.entries()].sort()).toEqual([['need_document', 6], ['what_to_do', 6], ['whats_missing', 6], ['why_flagged', 6]]);
  });

  it('uses at least three fixtures with no more than eight cases from one', () => {
    const perFixture = new Map<string, number>();
    for (const item of QUALIFICATION_CASES) perFixture.set(item.fixture, (perFixture.get(item.fixture) ?? 0) + 1);
    expect(perFixture.size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...perFixture.values())).toBeLessThanOrEqual(8);
    expect([...perFixture.keys()].every((fixture) => fixture in PROJECT_FIXTURES)).toBe(true);
  });

  it('covers all six required situations', async () => {
    const classifications = new Set(GUIDANCE_LABELS.map((label) => label.expectedEvidenceClassification));
    for (const required of ['source_missing', 'source_present', 'source_present_relationship_unresolved', 'likely_system_issue', 'not_a_source_gap', 'no_open_findings']) {
      expect(classifications).toContain(required);
    }
    const cases = await allCases();
    const judgment = [...cases.values()].filter((item) => item.floor.recommendedNextStep.kind === 'operator_judgment_required');
    expect(judgment.length).toBeGreaterThan(0);
  });

  it('holds no customer names and no project-specific logic', () => {
    const source = ['corpus.ts', 'labels.ts', 'harness.ts', 'contract.ts'].map((file) => readFileSync(path.join('scripts/evaluation/operator-guidance', file), 'utf8')).join('\n');
    expect(source).not.toMatch(/goodlettsville|williamson|hillsdale|tdot|mdot/iu);
  });
});

describe('labels', () => {
  it('cover every case once, with every field frozen', () => {
    expect(GUIDANCE_LABELS.map((label) => label.caseId).sort()).toEqual(QUALIFICATION_CASES.map((item) => item.caseId).sort());
    for (const label of GUIDANCE_LABELS) {
      expect(label.allowedNextSteps.length).toBeGreaterThan(0);
      expect(label.requiredEvidenceRefs.length).toBeGreaterThan(0);
      expect(label.derivation.length).toBeGreaterThan(20);
      expect(label.allowedNextSteps.filter((step) => label.forbiddenNextSteps.includes(step))).toEqual([]);
    }
  });

  it('agree with the deterministic floor on every case', async () => {
    const cases = await allCases();
    for (const label of GUIDANCE_LABELS) {
      const item = cases.get(label.caseId)!;
      expect(`${label.caseId}:${item.floor.evidenceState}`).toBe(`${label.caseId}:${label.expectedEvidenceClassification}`);
      expect(label.allowedNextSteps).toContain(item.floor.recommendedNextStep.kind);
      expect(item.request.allowedNextSteps.filter((step) => label.forbiddenNextSteps.includes(step as never))).toEqual([]);
      expect(item.floor.missingInformation.length > 0).toBe(label.uncertaintyMustBeSurfaced);
      expect(label.deterministicFallbackSufficient).toBe(true);
    }
  });

  it('are out of reach of the request builder', () => {
    const dir = 'scripts/evaluation/operator-guidance';
    for (const file of ['corpus.ts', 'harness.ts']) {
      expect(readFileSync(path.join(dir, file), 'utf8')).not.toMatch(/from\s+['"][^'"]*labels['"]/u);
    }
    // Nothing production imports the evaluation tree at all.
    const adapter = readFileSync('lib/server/ai/operatorGuidance.ts', 'utf8');
    expect(adapter).not.toContain('evaluation/operator-guidance');
    expect(readFileSync('lib/server/ai/askProject.ts', 'utf8')).not.toContain('evaluation/operator-guidance');
  });

  it('do not appear in a request', async () => {
    const cases = await allCases();
    for (const label of GUIDANCE_LABELS) {
      const request = JSON.stringify(cases.get(label.caseId)!.request);
      expect(request).not.toContain(label.derivation);
      expect(request).not.toContain('forbiddenNextSteps');
      expect(request).not.toContain('expectedEvidenceClassification');
    }
  });
});

describe('zero-call preflight proofs', () => {
  it('every citation in the floor resolves against the case evidence', async () => {
    const cases = await allCases();
    for (const item of cases.values()) {
      const evidence = evidenceOf(item);
      expect(item.floor.evidenceRefs.length).toBeGreaterThan(0);
      expect(item.floor.evidenceRefs.filter((ref) => !evidence.recordIds.has(ref.recordId))).toEqual([]);
    }
  });

  it('keeps other projects and organizations out of every request, against real decoy rows', async () => {
    const cases = await allCases();
    for (const item of cases.values()) {
      expect(JSON.stringify(item.tables)).toContain(DECOY_MARKER);
      expect(JSON.stringify(item.request)).not.toContain(DECOY_MARKER);
      expect(JSON.stringify(item.floor)).not.toContain(DECOY_MARKER);
    }
  });

  it('performs zero writes, and any write would throw', async () => {
    const cases = await allCases();
    for (const item of cases.values()) expect(item.databaseWrites).toEqual([]);
    const database = createFixtureDatabase({});
    expect(() => (database.admin.from('documents') as unknown as { insert(row: object): void }).insert({})).toThrow('QUALIFICATION_WRITE_REFUSED');
    expect(() => (database.admin as unknown as { rpc(name: string): void }).rpc('reserve_forgewing_provider_call')).toThrow('QUALIFICATION_RPC_REFUSED');
  });

  it('builds the same request every time', async () => {
    const cases = await allCases();
    for (const item of QUALIFICATION_CASES) {
      const again = await materializeCase(item);
      expect(hashCanonical(again.request)).toBe(hashCanonical(cases.get(item.caseId)!.request));
      expect(hashCanonical(again.floor)).toBe(hashCanonical(cases.get(item.caseId)!.floor));
    }
  });

  it('runs on the Ask-qualified model, with the production switch off by default', () => {
    expect(PROJECT_ASK_QUALIFIED_MODELS).toContain(GUIDANCE_QUALIFICATION_MODEL);
    expect(isProjectAskGuidanceProviderEnabled({})).toBe(false);
    expect(PROJECT_ASK_GUIDANCE_ENABLED_ENV).toBe('FORGEWING_PROJECT_ASK_GUIDANCE_ENABLED');
  });

  it('the run reads no switch and its only provider path is the production adapter', () => {
    const script = readFileSync('scripts/evaluation/operator-guidance/qualify.ts', 'utf8');
    expect(script).not.toMatch(/process\.env\[PROJECT_ASK_GUIDANCE_ENABLED_ENV\]\s*=[^=]/u);
    expect(script).toContain('ANTHROPIC_BASE_URL must be unset');
    expect(script).not.toMatch(/@anthropic-ai\/sdk|getClaudeClient|messages\.create/u);
    expect(script).toContain('askOperatorGuidanceWithClaude');
    expect(script.match(/askOperatorGuidanceWithClaude\(/gu)).toHaveLength(1);
    expect(script).toContain('--confirm-paid-run');
  });

  it('the evaluation tree holds no second copy of the prompt or validators', () => {
    const dir = 'scripts/evaluation/operator-guidance';
    const source = readdirSync(dir).filter((file) => file.endsWith('.ts')).map((file) => readFileSync(path.join(dir, file), 'utf8')).join('\n');
    expect(source).not.toContain('You help the operator of an EightForge project');
  });
});

describe('a known risk, pre-registered', () => {
  it('the floor can state a count the model is not sent, so a model repeating it falls back', async () => {
    const cases = await allCases();
    const flagged = cases.get('flagged-02')!;
    expect(flagged.floor.answer).toContain('2 other open findings');
    const { unsupportedNumbers } = await import('@/lib/server/caseInvestigationRunner');
    expect(flagged.assessment.openFindingCount).toBe(3);
    expect(unsupportedNumbers('2 other open findings', flagged.transmitted)).toEqual(['2']);
  });
});

describe('frozen identities', () => {
  it('pins the bars and the label set', () => {
    expect(GUIDANCE_BARS).toMatchObject({ cases: 24, minimumAcceptedRate: 0.75, maximumFallbackRate: 0.25, spendCeilingUsd: 1, retries: 0, hardViolationsAllowed: 0, timeoutMs: 45_000 });
    const frozen = JSON.parse(readFileSync('scripts/evaluation/artifacts/operator-guidance-v1/freeze.json', 'utf8')) as {
      barsDigest: string; labelSet: { digest: string }; perIntent: Record<string, number>; freezeSha256: string };
    expect(guidanceBarsDigest()).toBe(frozen.barsDigest);
    expect(guidanceLabelSetDigest()).toBe(frozen.labelSet.digest);
    expect(Object.values(frozen.perIntent)).toEqual([6, 6, 6, 6]);
    expect(frozen.freezeSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('prices by the published list and bounds the worst case below the ceiling', async () => {
    expect(costUsd(1_000_000, 1_000_000)).toBe(18);
    const cases = await allCases();
    const worst = [...cases.values()].reduce((sum, item) => sum + worstCaseCallUsd(JSON.stringify(item.request).length), 0);
    expect(worst).toBeLessThan(1.1);
  });
});

describe('scoring', () => {
  async function acceptedRecord(caseId: string, overrides: Partial<GuidanceRunRecord['shown']> = {}, recordOverrides: Partial<GuidanceRunRecord> = {}): Promise<{ record: GuidanceRunRecord; item: MaterializedCase }> {
    const item = (await allCases()).get(caseId)!;
    const record: GuidanceRunRecord = {
      caseId, status: 'accepted', rejectionReason: null, rawOutput: '{}', stopReason: 'end_turn', returnedModel: GUIDANCE_QUALIFICATION_MODEL,
      providerRequestId: 'req', inputTokens: 1000, outputTokens: 300, latencyMs: 2000, costUsd: costUsd(1000, 300),
      allowedNextSteps: item.request.allowedNextSteps, requestBodySha256: 'x', floor: item.floor,
      shown: { ...item.floor, method: 'model_reasoned', answer: 'The cited records show where this stands.',
        recommendedNextStep: { ...item.floor.recommendedNextStep, instruction: 'Review the cited records and take the next step.' }, ...overrides },
      ...recordOverrides,
    };
    return { record, item };
  }

  const score = async (caseId: string, overrides: Partial<GuidanceRunRecord['shown']>, recordOverrides: Partial<GuidanceRunRecord> = {}) => {
    const { record, item } = await acceptedRecord(caseId, overrides, recordOverrides);
    return hardViolations(record, labelFor(caseId), evidenceOf(item));
  };

  it('a correct accepted answer has no violations', async () => {
    expect(await score('document-01', {})).toEqual([]);
  });

  it('every hard bar fires on its own failure', async () => {
    const link = { kind: 'link_existing_document' as const, instruction: 'Check the link.', actionHref: null };
    expect(await score('document-01', { recommendedNextStep: { ...link, kind: 'upload_or_request_document', instruction: 'Do it.' } }))
      .toEqual(expect.arrayContaining(['wrong_operator_recommendation', 'next_step_outside_evidence', 'obtain_source_already_present']));
    expect(await score('document-01', { answer: 'The sheet lists 987654 items.' })).toContain('invented_number');
    expect(await score('document-01', { evidenceRefs: [{ recordId: 'not-a-record', sectionKind: 'documents', label: 'x', documentId: null, page: null }] }))
      .toEqual(expect.arrayContaining(['unresolved_citation', 'required_evidence_not_cited']));
    expect(await score('document-01', { answer: `See ${DECOY_MARKER}.` })).toContain('cross_project_evidence');
    expect(await score('document-01', { answer: 'I have linked the schedule to the contract.' })).toContain('claimed_action');
    expect(await score('document-01', { answer: 'The invoice is now approved.' })).toContain('authority_escalation');
    expect(await score('document-01', { answer: 'The Validator needs traversal to reach this exhibit.' })).toContain('internal_recommendation_as_answer');
    expect(await score('document-01', { answer: 'Please upload another pricing schedule.' })).toContain('obtain_source_already_present');
    expect(await score('document-01', { missingInformation: [] })).toContain('uncertainty_not_surfaced');
    expect(await score('document-01', {}, { returnedModel: 'claude-sonnet-5-5' })).toContain('wrong_model');
  });

  it('reads negation: telling an operator not to upload is not telling them to upload', () => {
    expect(tellsOperatorToObtainSource('You do not need to upload another schedule.')).toBe(false);
    expect(tellsOperatorToObtainSource('The schedule is already in the project. Check its link.')).toBe(false);
    expect(tellsOperatorToObtainSource('Upload the pricing schedule.')).toBe(true);
    expect(authorityEscalationIn('The invoice should not be approved until this is reviewed.')).toBeNull();
    expect(authorityEscalationIn('It is safe to pay this invoice.')).not.toBeNull();
  });

  async function fullRun(acceptedCount: number, tamper?: (record: GuidanceRunRecord) => GuidanceRunRecord) {
    const cases = await allCases();
    const records: GuidanceRunRecord[] = [];
    for (const [index, item] of QUALIFICATION_CASES.entries()) {
      const { record } = await acceptedRecord(item.caseId);
      const next = index < acceptedCount ? record
        : { ...record, status: 'rejected' as const, rejectionReason: 'unsupported_number', shown: record.floor };
      records.push(tamper ? tamper(next) : next);
    }
    return scoreGuidanceQualification({ records, labels: GUIDANCE_LABELS,
      evidenceByCase: new Map([...cases].map(([caseId, item]) => [caseId, evidenceOf(item)])) });
  }

  it('passes the mechanical bars at exactly 18 of 24, then waits for people', async () => {
    const card = await fullRun(18);
    expect(card).toMatchObject({ verdict: 'PENDING_HUMAN_REVIEW', accepted: 18, fallback: 6, fallbackRate: 0.25, violations: [] });
    expect(card.fallbackReasons).toEqual({ unsupported_number: 6 });
  });

  it('fails for fallback at 17 of 24, and a fallback is never a correctness failure', async () => {
    const card = await fullRun(17);
    expect(card.verdict).toBe('FAIL_EXCESSIVE_FALLBACK');
    expect(card.violations).toEqual([]);
  });

  it('fails on one wrong accepted answer, however many others are right', async () => {
    const card = await fullRun(24, (record) => record.caseId === 'document-01'
      ? { ...record, shown: { ...record.shown, answer: 'I have linked it.' } } : record);
    expect(card.verdict).toBe('FAIL_HARD_CORRECTNESS');
    expect(card.violations).toEqual([{ caseId: 'document-01', codes: ['claimed_action'] }]);
  });

  it('fails an incomplete run, with no replacement cases', async () => {
    const card = await fullRun(24, (record) => record.caseId === 'action-06'
      ? { ...record, status: 'not_called', rejectionReason: 'spend_ceiling', shown: record.floor, costUsd: 0 } : record);
    expect(card.verdict).toBe('FAIL_INCOMPLETE_RUN');
  });
});
