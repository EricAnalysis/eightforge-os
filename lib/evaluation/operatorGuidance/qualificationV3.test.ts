import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

const { getClaudeClientMock } = vi.hoisted(() => ({ getClaudeClientMock: vi.fn() }));
vi.mock('@/lib/server/ai/claudeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai/claudeClient')>()),
  getClaudeClient: getClaudeClientMock,
}));

import type { FindingAssessment, ProjectEvidenceAssessment } from '@/lib/projectIntelligence/evidenceAssessment';
import { nextStepActionHref, type OperatorRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';
import { operatorPresentation, operatorTermForEnum, operatorTextForSystemText } from '@/lib/projectIntelligence/operatorTerms';
import type { ProjectIntelligenceContext } from '@/lib/projectIntelligence/projectContext';
import { OPERATOR_GUIDANCE_REQUEST_CONTRACT } from '@/lib/server/ai/askProject';
import { acceptModelRecommendation, guidanceRejectionReasons, guidanceTransmittedContext, guidanceUnsupportedNumbers } from '@/lib/server/ai/operatorGuidance';
import { unsupportedNumbers } from '@/lib/server/caseInvestigationRunner';

import {
  authorityEscalationIn, GUIDANCE_BARS, GUIDANCE_QUALIFICATION_CONTRACT, GUIDANCE_QUALIFICATION_MODEL, GUIDANCE_RUN_DIR, GUIDANCE_SUPERSEDED_CONTRACT, GUIDANCE_V2_ARTIFACT_DIR,
  internalVocabularyInPayload, pinnedSourceDigests, promisedOutcomeIn, requestShapeIdentity, tellsOperatorToObtainSource, unsupportedRelationshipAdviceIn,
} from '@/scripts/evaluation/operator-guidance/contract';
import { HELDOUT_CASES, HELDOUT_PROJECT_FIXTURES, V2_REGRESSION_CASES, type QualificationCase } from '@/scripts/evaluation/operator-guidance/corpus';
import { materializeCase, type MaterializedCase } from '@/scripts/evaluation/operator-guidance/harness';
import { HELDOUT_LABELS } from '@/scripts/evaluation/operator-guidance/labels';
import { replayV2Answers, type V2ReplayRow } from '@/scripts/evaluation/operator-guidance/regression';

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const ALL_CASES: readonly QualificationCase[] = [...V2_REGRESSION_CASES, ...HELDOUT_CASES];
const caseById = (caseId: string) => ALL_CASES.find((item) => item.caseId === caseId)!;
const assessmentPayload = (item: MaterializedCase) => item.transmitted.find((section) => section.kind === 'evidence_assessment')!.payload as Record<string, unknown>;

const ID = '29968537-be62-4961-8919-de47b08d0e0f';
const sent = (openFindingCount: number, extra: object = {}, bySeverity: object = {}) => [
  { kind: 'documents', provenance: { recordIds: [ID] }, payload: { id: ID, processedAt: '2026-01-02T00:00:00.000Z', rateRowCount: 12, ...extra } },
  { kind: 'evidence_assessment', provenance: { recordIds: [] }, payload: { openFindingCount, findingsBySeverity: bySeverity } },
];

describe('v3 has its own identity and keeps the terms it did not set out to change', () => {
  it('supersedes the failed v2, on a new request contract and an unused run folder', () => {
    const result = json(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'RESULT.json'));
    expect(GUIDANCE_QUALIFICATION_CONTRACT).toBe('operator_guidance_qualification_v3');
    expect(GUIDANCE_SUPERSEDED_CONTRACT).toBe(result.contract);
    expect(result.successor).toBe(GUIDANCE_QUALIFICATION_CONTRACT);
    expect(result.classification).toBe('OPERATOR GUIDANCE V2 = FAIL_HARD_CORRECTNESS');
    expect(result.diagnosis.state).toBe('MIXED');
    expect(OPERATOR_GUIDANCE_REQUEST_CONTRACT).toBe('project_ask_operator_guidance_v2');
    expect(GUIDANCE_RUN_DIR).toBe('scripts/evaluation/artifacts/operator-guidance-v3/run');
    expect(existsSync(GUIDANCE_RUN_DIR)).toBe(false);
  });

  it('keeps v2\'s model, prompt, schema, next-step vocabulary, timeout and retries', () => {
    const v2 = json(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'freeze.json')).request;
    const { requestContract: v3Contract, ...v3Terms } = requestShapeIdentity();
    const { requestContract: v2Contract, ...v2Terms } = v2;
    expect(v3Terms).toEqual(v2Terms);
    expect(v3Contract).not.toBe(v2Contract);
    expect(GUIDANCE_QUALIFICATION_MODEL).toBe('claude-sonnet-4-6');
  });

  it('keeps every bar', () => {
    const v2 = json(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'freeze.json')).bars;
    const { scorer: v3Scorer, ...v3Bars } = GUIDANCE_BARS;
    const { scorer: v2Scorer, ...v2Bars } = v2;
    expect(v3Bars).toEqual(v2Bars);
    expect(v3Scorer).not.toBe(v2Scorer);
  });
});

describe('the 24 held-out cases', () => {
  it('are six per intent, across at least three fixtures, with none above eight', () => {
    expect(HELDOUT_CASES).toHaveLength(24);
    for (const intent of ['whats_missing', 'need_document', 'why_flagged', 'what_to_do']) {
      expect(HELDOUT_CASES.filter((item) => item.intent === intent)).toHaveLength(6);
    }
    const perFixture = new Map<string, number>();
    for (const item of HELDOUT_CASES) perFixture.set(item.fixture, (perFixture.get(item.fixture) ?? 0) + 1);
    expect(perFixture.size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...perFixture.values())).toBeLessThanOrEqual(8);
    expect([...perFixture.keys()].every((fixture) => fixture in HELDOUT_PROJECT_FIXTURES)).toBe(true);
  });

  it('reuse nothing from v1 or v2', async () => {
    const v2 = json(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'freeze.json')) as { census: { caseId: string; fixture: string }[]; requests: { bodySha256: string }[] };
    expect(new Set(HELDOUT_CASES.map((item) => item.caseId)).size).toBe(24);
    const oldIds = new Set(v2.census.map((entry) => entry.caseId));
    const oldFixtures = new Set(v2.census.map((entry) => entry.fixture));
    expect(HELDOUT_CASES.filter((item) => oldIds.has(item.caseId) || oldFixtures.has(item.fixture))).toEqual([]);
    const oldBodies = new Set(v2.requests.map((entry) => entry.bodySha256));
    for (const item of HELDOUT_CASES) {
      const built = await materializeCase(item);
      expect(oldBodies.has(createHash('sha256').update(JSON.stringify(built.request)).digest('hex'))).toBe(false);
    }
  });

  it('carry a written derivation each, and name where truth is genuinely open', () => {
    expect(HELDOUT_LABELS.map((label) => label.caseId).sort()).toEqual(HELDOUT_CASES.map((item) => item.caseId).sort());
    for (const label of HELDOUT_LABELS) expect(label.derivation.length).toBeGreaterThan(20);
    expect(HELDOUT_LABELS.filter((label) => label.openForAdjudication).map((label) => label.caseId)).toEqual(['heldout-missing-02', 'heldout-document-04']);
  });

  it.each([
    ['heldout-missing-01', 'source_missing', 'SOURCES_NO_TICKET_DATA', 'upload_or_request_document', 1],
    ['heldout-missing-02', 'not_a_source_gap', 'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE', 'review_ticket_or_transaction', 6],
    ['heldout-missing-03', 'no_open_findings', null, 'no_action_needed', 0],
    ['heldout-missing-04', 'source_missing', 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', 'upload_or_request_document', 1],
    ['heldout-missing-05', 'source_missing', 'SOURCES_NO_CONTRACT', 'upload_or_request_document', 1],
    ['heldout-missing-06', 'source_missing', 'SOURCES_NO_INVOICE_DATA', 'upload_or_request_document', 2],
    ['heldout-document-01', 'source_present_unread', 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', 'review_existing_document', 1],
    ['heldout-document-02', 'source_missing', 'SOURCES_NO_TICKET_DATA', 'upload_or_request_document', 1],
    ['heldout-document-03', 'source_present', 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', 'review_existing_document', 1],
    ['heldout-document-04', 'source_missing', 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', 'upload_or_request_document', 1],
    ['heldout-document-05', 'no_open_findings', null, 'no_action_needed', 0],
    ['heldout-document-06', 'source_present_unread', 'SOURCES_NO_CONTRACT', 'review_existing_document', 1],
    ['heldout-flagged-01', 'source_present_relationship_unresolved', 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', 'link_existing_document', 1],
    ['heldout-flagged-02', 'not_a_source_gap', 'TRANSACTION_TICKET_GRAIN_CONFLICT', 'operator_judgment_required', 8],
    ['heldout-flagged-03', 'not_a_source_gap', 'FINANCIAL_AUTHORED_RATE_ROW_UNVERIFIED', 'correct_source_data', 8],
    ['heldout-flagged-04', 'likely_system_issue', 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', 'likely_system_issue', 1],
    ['heldout-flagged-05', 'not_a_source_gap', 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR', 'review_existing_document', 1],
    ['heldout-flagged-06', 'not_a_source_gap', 'TRANSACTION_QUANTITY_MATCHES_INVOICE', 'review_ticket_or_transaction', 3],
    ['heldout-action-01', 'source_present_relationship_unresolved', 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', 'link_existing_document', 1],
    ['heldout-action-02', 'likely_system_issue', 'FINANCIAL_RATE_BASED_ROWS_REQUIRED', 'likely_system_issue', 3],
    ['heldout-action-03', 'not_a_source_gap', 'FINANCIAL_AUTHORED_RATE_ROW_UNVERIFIED', 'correct_source_data', 2],
    ['heldout-action-04', 'not_a_source_gap', 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE', 'review_ticket_or_transaction', 3],
    ['heldout-action-05', 'no_open_findings', null, 'no_action_needed', 0],
    ['heldout-action-06', 'source_present_unread', 'SOURCES_NO_INVOICE_DATA', 'review_existing_document', 2],
  ])('%s reads %s from the real Validator', async (caseId, state, rule, step, open) => {
    const built = await materializeCase(caseById(caseId));
    expect(built.floor.evidenceState).toBe(state);
    expect(built.assessment.primary?.ruleId ?? null).toBe(rule);
    expect(built.floor.recommendedNextStep.kind).toBe(step);
    expect(built.assessment.openFindingCount).toBe(open);
    expect(built.databaseWrites).toEqual([]);
  });

  it('give the variant conflict case its own ticket and values', async () => {
    const request = JSON.stringify((await materializeCase(caseById('heldout-flagged-02'))).request);
    expect(request).toContain('LOAD-884');
    expect(request).not.toContain('TKT-1');
    expect(request).toMatch(/\b310\b/u);
  });

  it('build without touching a provider', async () => {
    getClaudeClientMock.mockClear();
    for (const item of HELDOUT_CASES) await materializeCase(item);
    expect(getClaudeClientMock).not.toHaveBeenCalled();
  });
});

describe('the deterministic action link follows what the recommendation names', () => {
  const context = { projectId: 'project' } as unknown as ProjectIntelligenceContext;
  const document = (id: string, overrides: object = {}) => ({ id, title: id, linkedToContract: true, read: true, authorityUnsettled: false, processedAt: null, ...overrides });
  const reading = (overrides: Partial<FindingAssessment>): FindingAssessment => ({
    findingId: 'finding', ruleId: 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', title: 't', severity: 'critical', blocksProject: true, state: 'source_present_unread',
    neededSource: 'pricing schedule', candidates: [], governingContract: null, nextSteps: ['review_existing_document'], evidenceRecordIds: [], supportingFactCount: 0,
    linkedOpenDecisionId: null, uncertainties: [], confidence: 'medium', ...overrides,
  });
  const finding = (evidenceDocumentIds: readonly string[], page: number | null = null) => ({ subjectId: null, evidenceDocumentIds, page });

  it('opens the price sheet when the reading is about the price sheet, whatever the finding cites', () => {
    expect(nextStepActionHref('review_existing_document', reading({ candidates: [document('price-sheet', { read: false })] }), context, finding(['governing-contract'])))
      .toBe('/platform/documents/price-sheet');
  });

  it('opens the governing agreement when the agreement is the source the reading found', () => {
    expect(nextStepActionHref('review_existing_document', reading({ state: 'source_present', candidates: [document('governing-agreement')] }), context, finding(['governing-agreement'])))
      .toBe('/platform/documents/governing-agreement');
  });

  it('opens the finding\'s own evidence when the finding is not about a source', () => {
    const applicability = reading({ ruleId: 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR', state: 'not_a_source_gap', neededSource: null });
    expect(nextStepActionHref('review_existing_document', applicability, context, finding(['governing-agreement', 'other'], 7)))
      .toBe('/platform/documents/governing-agreement?page=7');
  });

  it('prefers the read, linked source the reading rests on, and no blanket order', () => {
    const stale = document('a-draft', { authorityUnsettled: true });
    const rests = document('b-final');
    expect(nextStepActionHref('review_existing_document', reading({ state: 'source_present', candidates: [stale, rests] }), context, finding(['contract'])))
      .toBe('/platform/documents/b-final');
  });

  it('keeps a page number with the document it belongs to', () => {
    const sheet = reading({ candidates: [document('price-sheet', { read: false })] });
    expect(nextStepActionHref('review_existing_document', sheet, context, finding(['governing-contract'], 7))).toBe('/platform/documents/price-sheet');
    expect(nextStepActionHref('review_existing_document', sheet, context, finding(['price-sheet'], 7))).toBe('/platform/documents/price-sheet?page=7');
  });

  it('sends a missing source to upload, never to an unrelated document', () => {
    const missing = reading({ ruleId: 'SOURCES_NO_CONTRACT', state: 'source_missing', neededSource: 'contract', nextSteps: ['upload_or_request_document'] });
    expect(nextStepActionHref('upload_or_request_document', missing, context, finding(['unrelated-document']))).toBe('/platform/documents');
  });

  it('gives no link for a step that has none, rather than an approximate one', () => {
    expect(nextStepActionHref('likely_system_issue', reading({ candidates: [document('price-sheet')] }), context, finding(['contract']))).toBeNull();
  });

  it.each([
    ['heldout-document-01', 'doc:sheet'],
    ['heldout-document-03', 'doc:sheet'],
    ['heldout-flagged-05', 'doc:contract'],
  ])('%s opens %s, across document families', async (caseId, symbol) => {
    const built = await materializeCase(caseById(caseId));
    expect(built.floor.recommendedNextStep.actionHref).toBe(`/platform/documents/${built.symbols[symbol]}`);
  });
});

describe('operator terms: one seam, in the sent copy alone', () => {
  const context = (payload: object) => ({
    projectId: 'project', sections: [{ kind: 'documents', transmitted: true, provenance: { source: 'documents', projectId: 'project', recordIds: [ID] }, payload }],
  }) as unknown as ProjectIntelligenceContext;
  const assessment = { projectState: 'no_open_findings', openFindingCount: 0, primary: null, others: [] } as unknown as ProjectEvidenceAssessment;
  const floor = { recommendedNextStep: { kind: 'no_action_needed', instruction: 'Nothing is required right now.', actionHref: null } } as unknown as OperatorRecommendation;
  const presented = (payload: object) => guidanceTransmittedContext(context(payload), assessment, floor).sections[0]!.payload as Record<string, unknown>;

  it.each(ALL_CASES.map((item) => [item.caseId, item] as const))('%s carries no identifier a repeating answer would be rejected for', async (_caseId, item) => {
    const built = await materializeCase(item);
    expect(built.transmitted.flatMap((section) => internalVocabularyInPayload(section.payload))).toEqual([]);
  });

  it('translates the terms v2 leaked', () => {
    expect(operatorTermForEnum('attached_to')).toBe('attached to');
    expect(operatorTermForEnum('reference_only')).toBe('reference only');
    expect(operatorTermForEnum('rate_sheet')).toBe('rate sheet');
    expect(operatorTextForSystemText('Capture the pages in canonical contract truth.')).toBe('Capture the pages in contract record.');
    expect(operatorTextForSystemText('A canonical value differs.')).toBe('A value differs.');
  });

  it('changes enum values and the closed list of system terms', () => {
    expect(presented({ type: 'attached_to', field: 'rate_row_count', authorityStatus: 'reference_only', reading: 'source_present_unread' }))
      .toEqual({ type: 'attached to', field: 'rate row count', authorityStatus: 'reference only', reading: 'source present unread' });
    expect(presented({ description: 'extended_cost differs from transaction_quantity' })).toEqual({ description: 'extended cost differs from transaction quantity' });
  });

  it('never rewrites ids, titles, names, values or a token it does not know', () => {
    const untouched = { id: 'TKT_001', title: 'canonical_rate_sheet', name: 'rate_sheet.pdf', documentName: 'load_tickets.pdf', value: 'TKT_001', page: 7 };
    expect(operatorPresentation(untouched)).toEqual(untouched);
    expect(presented(untouched)).toEqual(untouched);
    expect(presented({ description: 'see some_other_token' })).toEqual({ description: 'see some_other_token' });
  });

  it('leaves an uncovered identifier raw, so an answer repeating it falls back', () => {
    expect(internalVocabularyInPayload(presented({ description: 'see some_other_token' }))).toEqual(['description: some_other_token']);
  });

  it('changes only what is sent: the stored context, citations and provenance stay as they were', async () => {
    const built = await materializeCase(caseById('flagged-04'));
    expect(JSON.stringify(built.approvedContext)).toContain('attached_to');
    expect(JSON.stringify(built.sourceRequest)).toContain('attached_to');
    expect(JSON.stringify(built.transmitted.map((section) => section.payload))).not.toContain('attached_to');
    expect(built.transmitted.map((section) => section.provenance).slice(0, -1)).toEqual(built.approvedContext.sections.filter((section) => section.transmitted).map((section) => section.provenance));
  });

  it('keeps the validator strict against what it translates away', async () => {
    const built = await materializeCase(caseById('document-01'));
    const raw = JSON.stringify({ answer: 'The sheet is attached_to the contract.', nextStepKind: 'link_existing_document', nextStepInstruction: 'Check it.', citations: ['A'], missingInformation: [], confidence: 'medium' });
    expect(acceptModelRecommendation({ raw, context: built.approvedContext, assessment: built.assessment, floor: built.floor, transmitted: built.transmitted })).toEqual({ ok: false, reason: 'internal_vocabulary' });
  });
});

describe('the reading gains what the floor already worked out', () => {
  it('sends the counts of the full open list', async () => {
    const payload = assessmentPayload(await materializeCase(caseById('missing-05')));
    expect(payload.findingsBySeverity).toEqual({ critical: 3, warning: 5 });
    expect(payload.otherOpenFindingCount).toBe(7);
    expect(payload.openFindingCount).toBe(8);
  });

  it('counts beyond the eight findings it details', () => {
    const entry = { findingId: 'f', title: 't', severity: 'warning', state: 'not_a_source_gap', neededSource: null, candidates: [], governingContract: null, linkedOpenDecisionId: null, uncertainties: [] };
    const assessment = { projectState: 'findings_open', openFindingCount: 13, primary: { ...entry, severity: 'critical' }, others: Array.from({ length: 12 }, () => entry) } as unknown as ProjectEvidenceAssessment;
    const floor = { recommendedNextStep: { kind: 'operator_judgment_required', instruction: 'Review it.', actionHref: null } } as unknown as OperatorRecommendation;
    const { sections } = guidanceTransmittedContext({ projectId: 'p', sections: [] } as unknown as ProjectIntelligenceContext, assessment, floor);
    const payload = sections[0]!.payload as { findingsBySeverity: unknown; otherOpenFindingCount: number; otherOpenFindings: unknown[] };
    expect(payload.findingsBySeverity).toEqual({ critical: 1, warning: 12 });
    expect(payload.otherOpenFindingCount).toBe(12);
    expect(payload.otherOpenFindings).toHaveLength(8);
  });

  it('says zero, not minus one or nothing, when nothing is open', async () => {
    const payload = assessmentPayload(await materializeCase(caseById('missing-04')));
    expect(payload.otherOpenFindingCount).toBe(0);
    expect(payload.findingsBySeverity).toEqual({ critical: 0, warning: 0 });
  });

  it('retires the count the floor stated and the model was not sent', async () => {
    const built = await materializeCase(caseById('flagged-02'));
    expect(built.floor.answer).toContain('2 other open findings');
    expect(guidanceUnsupportedNumbers([built.floor.answer], built.transmitted)).toEqual([]);
  });

  it.each(ALL_CASES.map((item) => [item.caseId, item] as const))('%s sends the production next step', async (_caseId, item) => {
    const built = await materializeCase(item);
    expect(assessmentPayload(built).deterministicNextStep).toEqual({ kind: built.floor.recommendedNextStep.kind, instruction: built.floor.recommendedNextStep.instruction });
    expect(built.request.allowedNextSteps).toContain(built.floor.recommendedNextStep.kind);
  });

  it('shows the model a reprocess step it could not see in v2', async () => {
    const built = await materializeCase(caseById('document-05'));
    expect(JSON.stringify(built.request)).toContain('reprocess');
    expect(JSON.stringify(built.sourceRequest)).not.toContain('reprocess');
  });

  it('never exposes a label as such', async () => {
    for (const label of HELDOUT_LABELS) {
      const request = JSON.stringify((await materializeCase(caseById(label.caseId))).request);
      expect(request).not.toContain(label.derivation);
      expect(request).not.toMatch(/forbiddenNextSteps|expectedEvidenceClassification|openForAdjudication/u);
    }
  });
});

describe('the guidance number check', () => {
  it('closes the UUID hole: digits inside an identifier support nothing', () => {
    expect(guidanceUnsupportedNumbers(['There are 62 critical findings.'], sent(3))).toContain('62');
    expect(guidanceUnsupportedNumbers(['About 8961 tons were billed.'], sent(3))).toEqual(['8961']);
    expect(guidanceUnsupportedNumbers(['About 2026 tons were billed.'], sent(3))).toEqual(['2026']);
    expect(guidanceUnsupportedNumbers(['About 1001 tons were billed.'], sent(0, { expected: 'INV1001::HAUL015' }))).toEqual(['1001']);
    expect(guidanceUnsupportedNumbers(['About 884 tons were billed.'], sent(0, { actual: 'LOAD-884' }))).toEqual(['884']);
    expect(guidanceUnsupportedNumbers(['About 123456 tons were billed.'], sent(0, { digest: 'abc123456def7890abc123456def7890' }))).toEqual(['123456']);
    expect(guidanceUnsupportedNumbers(['About 7 tons were billed.'], sent(0, { documentName: 'Sample Invoice 7' }))).toEqual(['7']);
  });

  it('still takes an identifier or title written whole, and refuses one never sent', () => {
    expect(guidanceUnsupportedNumbers([`See ${ID}.`], sent(3))).toEqual([]);
    expect(guidanceUnsupportedNumbers(['See 11111111-1111-4111-8111-111111111111.'], sent(3))).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(guidanceUnsupportedNumbers(['See ticket LOAD-884.'], sent(0, { actual: 'LOAD-884' }))).toEqual([]);
    expect(guidanceUnsupportedNumbers(['See ticket LOAD-999.'], sent(0, { actual: 'LOAD-884' }))).toEqual(['LOAD-999']);
    expect(guidanceUnsupportedNumbers(['Open Sample Invoice 7.'], sent(0, { documentName: 'Sample Invoice 7' }))).toEqual([]);
  });

  it.each([
    ['a rate', 'The rate is $15.75 per yard.'],
    ['a cost', 'The cost comes to $4,200.'],
    ['a percentage', 'About 37% of it is unsupported.'],
    ['a measurement', 'It covers 88 cubic yards.'],
    ['a count', 'There are 44 tickets.'],
    ['a glued quantity', 'It covers 88CY.'],
  ])('refuses an unsupported %s', (_kind, text) => {
    expect(guidanceUnsupportedNumbers([text], sent(3)).length).toBeGreaterThan(0);
  });

  it('takes a quantity the context sent, in any safe format, and refuses arithmetic on it', () => {
    const context = sent(0, { actual: '2 conflicting values: 3875, 5000', amount: 3125.5 });
    expect(guidanceUnsupportedNumbers(['Values of $3,875.00 and 5,000 disagree, and 3,125.50 stands.'], context)).toEqual([]);
    expect(guidanceUnsupportedNumbers(['They differ by 1,125.'], context)).toEqual(['1125']);
  });

  it('holds a count about the findings to the count sent, even where that number is elsewhere', () => {
    const context = sent(8, {}, { critical: 3, warning: 5 });
    expect(guidanceUnsupportedNumbers(['There are 3 critical findings, 5 warnings and 8 open findings.'], context)).toEqual([]);
    expect(guidanceUnsupportedNumbers(['There are 5 critical findings.'], context)).toEqual(['5 critical']);
    expect(guidanceUnsupportedNumbers(['There are 3 warnings.'], context)).toEqual(['3 warnings']);
    expect(guidanceUnsupportedNumbers(['5 other open findings remain.'], context)).toEqual(['5 other open findings']);
    // 7 is the count the reading sends, and this context did not send it.
    expect(guidanceUnsupportedNumbers(['7 other open findings remain.'], sent(8, { otherOpenFindingCount: 7 }, { critical: 3, warning: 5 }))).toEqual([]);
  });

  it('ignores a list marker only as part of a run from 1', () => {
    expect(guidanceUnsupportedNumbers(['Two things:\n1. First\n**2.** Second\n3) Third'], sent(0))).toEqual([]);
    expect(guidanceUnsupportedNumbers(['Things:\n2. Second'], sent(0))).toEqual(['2']);
    expect(guidanceUnsupportedNumbers(['Things:\n1. First\n3. Third'], sent(0))).toEqual(['3']);
    expect(guidanceUnsupportedNumbers(['1. First', '1. First'], sent(0))).toEqual([]);
  });

  it('does not read a quantity as a marker', () => {
    expect(guidanceUnsupportedNumbers(['1.5 tons were billed.'], sent(0))).toEqual(['1.5']);
    expect(guidanceUnsupportedNumbers(['Summary, 1. First'], sent(0))).toEqual(['1']);
  });

  it('ignores a finding\'s ordinal only up to the open count, and ordinal words', () => {
    expect(guidanceUnsupportedNumbers(['Critical Finding 2 and finding 3 remain, and the 2nd matters.'], sent(3))).toEqual([]);
    expect(guidanceUnsupportedNumbers(['Finding 4 remains.'], sent(3))).toEqual(['4']);
    expect(guidanceUnsupportedNumbers(['Finding 0 remains.'], sent(3))).toEqual(['0']);
  });

  it.each(['2026-01-02', '2026-01-02T00:00:00.000Z', 'January 2, 2026', 'Jan 2, 2026', 'Jan. 2, 2026', '2 January 2026', '01/02/2026', '1/2/2026'])('accepts %s, the date sent', (date) => {
    expect(guidanceUnsupportedNumbers([`Validated on ${date}.`], sent(0))).toEqual([]);
  });

  it.each(['2026-01-03', 'January 3, 2026', '3 January 2026', '1/3/2026'])('refuses %s, a date never sent', (date) => {
    expect(guidanceUnsupportedNumbers([`Validated on ${date}.`], sent(0)).length).toBeGreaterThan(0);
  });
});

describe('Case Investigation is not touched', () => {
  it('runs on the exact runner v2 froze, which is its historical behaviour', () => {
    const v2 = json(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'freeze.json'));
    expect(pinnedSourceDigests()['lib/server/caseInvestigationRunner.ts']).toBe(v2.pinnedSources['lib/server/caseInvestigationRunner.ts']);
  });

  it('keeps every quirk of the shared helper, including the ones guidance fixed for itself', () => {
    expect(unsupportedNumbers('There are 62 critical findings.', sent(3))).toEqual([]);
    expect(unsupportedNumbers('1. Only', sent(0))).toEqual(['1']);
    expect(unsupportedNumbers('Finding 2 remains.', sent(3))).toEqual(['2']);
    expect(unsupportedNumbers('It lists 987654 items.', sent(3))).toEqual(['987654']);
  });

  it('is not imported by the operator terms seam or changed by it', () => {
    expect(readFileSync('lib/projectIntelligence/operatorTerms.ts', 'utf8')).not.toContain('caseInvestigation');
    expect(readFileSync('lib/server/caseInvestigationRunner.ts', 'utf8')).not.toMatch(/operatorGuidance|operatorTerms/u);
  });
});

describe('authority claims and conditional language', () => {
  it.each([
    'This is approved.',
    'The finding is cleared.',
    'I approved this.',
    'The project is compliant.',
    'The finding has been resolved.',
    'This invoice can be approved.',
    'You can approve this now.',
    'It should be paid.',
    'The finding is now resolved.',
    'Once linked, this can be approved.',
    'Once linked this can be approved.',
    'If it matches, the invoice may be paid.',
    'It is safe to pay.',
    'Before you leave, note this can be approved.',
    'Review it before lunch. It can be approved.',
    'Whether or not you check, this may be paid.',
  ])('is a claim: %s', (text) => {
    expect(authorityEscalationIn(text)).not.toBeNull();
  });

  it.each([
    'Check whether the finding is resolved.',
    'Check whether the critical finding is now resolved.',
    'Review this before the invoice can be approved.',
    'Confirm whether this satisfies the requirement.',
    'Confirm that the finding is resolved.',
    'It must be addressed before billed work can be approved.',
    'A contract is required before any invoices tied to this work can be approved.',
    'This must be settled prior to the invoice being safe to pay.',
    'Nothing should be paid until the conflict is settled.',
    'No invoice can be approved until then.',
    'The invoice cannot be paid.',
    'This is not approved.',
    'If the finding is cleared, review the next one.',
    'Once it is resolved, run validation again.',
  ])('is not a claim: %s', (text) => {
    expect(authorityEscalationIn(text)).toBeNull();
  });
});

describe('promised outcomes, apart from authority', () => {
  it.each([
    'This will resolve the finding.',
    'This will unblock the project.',
    'This will make the project compliant.',
    'Linking it would then clear the finding.',
    'The finding will be closed.',
    'Once linked, the finding will be resolved.',
    'If linked the finding will clear.',
    'This guarantees the finding closes.',
  ])('is a promise: %s', (text) => {
    expect(promisedOutcomeIn(text)).not.toBeNull();
  });

  it.each([
    'This is the next item to review.',
    'If confirmed, this may address the finding.',
    'Review this before determining whether the finding is resolved.',
    'Run validation to see whether it will clear.',
    'Run validation again, then review whether this is still flagged.',
    'This will not resolve the finding by itself.',
    'It could clear on the next run.',
  ])('is cautious: %s', (text) => {
    expect(promisedOutcomeIn(text)).toBeNull();
  });

  it('is a separate check from authority', () => {
    expect(authorityEscalationIn('This will resolve the finding.')).toBeNull();
    expect(promisedOutcomeIn('This is approved.')).toBeNull();
  });
});

describe('advice that a link is needed, on a reading that never asked for one', () => {
  it.each([
    'That link may be required before validation can recognize it.',
    'That relationship may need to be established first.',
    'It needs to be linked to the contract.',
  ])('is advice: %s', (text) => {
    expect(unsupportedRelationshipAdviceIn(text)).not.toBeNull();
  });

  it.each([
    'It is unknown whether it needs to be explicitly linked to the contract.',
    'The finding requires that a schedule be attached or extracted.',
    'It is not confirmed whether the document is linked.',
    'Confirm that the link between them is recorded; if so, this may need to be escalated.',
    'No link is required here.',
    'I have linked it.',
    'Open the document and review it.',
  ])('is not advice: %s', (text) => {
    expect(unsupportedRelationshipAdviceIn(text)).toBeNull();
  });
});

describe('every failed check is recorded, and acceptance does not change', () => {
  const parts = async (raw: object) => {
    const built = await materializeCase(caseById('document-01'));
    return { raw: JSON.stringify(raw), context: built.approvedContext, assessment: built.assessment, floor: built.floor, transmitted: built.transmitted };
  };
  const answer = (text: string) => ({ answer: text, nextStepKind: 'link_existing_document', nextStepInstruction: 'Check the link.', citations: ['A'], missingInformation: [], confidence: 'medium' });

  it('reports all of them, and acceptance stops at the first', async () => {
    const params = await parts(answer('It lists 987654 items in canonical form.'));
    expect(guidanceRejectionReasons(params)).toEqual(['unsupported_number', 'internal_vocabulary']);
    expect(acceptModelRecommendation(params)).toEqual({ ok: false, reason: 'unsupported_number' });
  });

  it('reports nothing for an accepted answer', async () => {
    const params = await parts(answer('The price sheet is already in the project.'));
    expect(guidanceRejectionReasons(params)).toEqual([]);
    expect(acceptModelRecommendation(params).ok).toBe(true);
  });

  it('keeps a parse failure as a single reason', async () => {
    const params = { ...(await parts({})), raw: 'not json' };
    expect(guidanceRejectionReasons(params)).toEqual(['output_not_json']);
    expect(acceptModelRecommendation(params)).toEqual({ ok: false, reason: 'output_not_json' });
  });
});

describe('v2\'s saved answers under v3: regression evidence only', () => {
  let rows: readonly V2ReplayRow[] = [];
  const row = (caseId: string) => rows.find((entry) => entry.caseId === caseId)!;
  const records = json(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'run/records.json')).records as { caseId: string; rawOutput: string }[];
  const prose = (caseId: string) => {
    const raw = JSON.parse(records.find((record) => record.caseId === caseId)!.rawOutput) as { answer: string; nextStepInstruction: string; missingInformation: string[] };
    return [raw.answer, raw.nextStepInstruction, ...raw.missingInformation].join(' ');
  };

  beforeAll(async () => { rows = await replayV2Answers(); }, 120_000);

  it('matches the committed table', () => {
    expect(json('scripts/evaluation/artifacts/operator-guidance-v3/regression-v2-answers.json').rows).toEqual(JSON.parse(JSON.stringify(rows)));
  });

  it('computes no rate and no verdict', () => {
    const table = json('scripts/evaluation/artifacts/operator-guidance-v3/regression-v2-answers.json');
    expect(table.evidenceOnly).toContain('Not a qualification result');
    expect(JSON.stringify(table)).not.toMatch(/acceptedRate|verdict|PENDING_HUMAN_REVIEW/u);
  });

  it.each(['document-03', 'document-04', 'flagged-05'])('%s loses its false escalation hit', (caseId) => {
    expect(authorityEscalationIn(prose(caseId))).toBeNull();
    expect(row(caseId).scorerHitsUnderV3).not.toContain('authority_escalation');
  });

  it('document-05 stays unsafe', () => {
    expect(row('document-05').scorerHitsUnderV3).toContain('obtain_source_already_present');
  });

  it('document-04\'s unsupported link advice is now detected', () => {
    expect(row('document-04').scorerHitsUnderV3).toContain('unsupported_relationship_advice');
  });

  it('action-02\'s promised outcome is now detected', () => {
    expect(row('action-02').scorerHitsUnderV3).toContain('promised_outcome');
  });

  it('no answer fails on a list marker, an ordinal or any other number', () => {
    expect(rows.filter((entry) => entry.validatorFailuresUnderV3.includes('unsupported_number'))).toEqual([]);
    expect(rows.filter((entry) => entry.scorerHitsUnderV3.includes('invented_number'))).toEqual([]);
  });

  it('raw internal identifiers stay rejected', () => {
    for (const caseId of ['flagged-04', 'action-02', 'action-03', 'missing-05', 'flagged-01', 'flagged-03', 'action-04']) {
      expect(row(caseId).validatorFailuresUnderV3, caseId).toContain('internal_vocabulary');
    }
  });

  it('only the two wrong links change, and they open the source', () => {
    expect(rows.filter((entry) => entry.floorLinkInV2 !== entry.floorLinkInV3).map((entry) => entry.caseId)).toEqual(['document-03', 'document-05']);
  });

  it('the accepted answers gain no new hit beyond the two genuine errors', () => {
    const accepted = rows.filter((entry) => entry.v2Status === 'accepted' && entry.scorerHitsUnderV3.length > 0).map((entry) => entry.caseId);
    expect(accepted).toEqual(['document-04', 'document-05']);
  });
});
