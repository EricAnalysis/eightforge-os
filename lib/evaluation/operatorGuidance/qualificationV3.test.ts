import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ProjectEvidenceAssessment } from '@/lib/projectIntelligence/evidenceAssessment';
import type { OperatorRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';
import type { ProjectIntelligenceContext } from '@/lib/projectIntelligence/projectContext';
import { OPERATOR_GUIDANCE_REQUEST_CONTRACT } from '@/lib/server/ai/askProject';
import { acceptModelRecommendation, guidanceRejectionReasons, guidanceTransmittedContext, guidanceUnsupportedNumbers } from '@/lib/server/ai/operatorGuidance';
import { unsupportedNumbers } from '@/lib/server/caseInvestigationRunner';

import {
  authorityEscalationIn, GUIDANCE_QUALIFICATION_CONTRACT, GUIDANCE_QUALIFICATION_MODEL, GUIDANCE_RUN_DIR, GUIDANCE_SUPERSEDED_CONTRACT, GUIDANCE_V2_ARTIFACT_DIR,
  internalVocabularyInPayload, promisedOutcomeIn, requestShapeIdentity, tellsOperatorToObtainSource,
} from '@/scripts/evaluation/operator-guidance/contract';
import { GUIDANCE_RUN_CASES, HELDOUT_CASES, QUALIFICATION_CASES } from '@/scripts/evaluation/operator-guidance/corpus';
import { materializeCase, type MaterializedCase } from '@/scripts/evaluation/operator-guidance/harness';

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const caseById = (caseId: string) => GUIDANCE_RUN_CASES.find((item) => item.caseId === caseId)!;
const assessmentPayload = (item: MaterializedCase) => item.transmitted.find((section) => section.kind === 'evidence_assessment')!.payload as Record<string, unknown>;

const ID = '29968537-be62-4961-8919-de47b08d0e0f';
const sent = (openFindingCount: number, extra: object = {}) => [
  { kind: 'documents', provenance: { recordIds: [ID] }, payload: { id: ID, processedAt: '2026-01-02T00:00:00.000Z', rateRowCount: 12, ...extra } },
  { kind: 'evidence_assessment', provenance: { recordIds: [] }, payload: { openFindingCount } },
];

describe('v3 has its own identity and keeps the terms it did not set out to change', () => {
  it('supersedes the failed v2, on a new request contract and an unused run folder', () => {
    expect(GUIDANCE_QUALIFICATION_CONTRACT).toBe('operator_guidance_qualification_v3');
    expect(GUIDANCE_SUPERSEDED_CONTRACT).toBe(json(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'RESULT.json')).contract);
    expect(json(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'RESULT.json')).successor).toBe(GUIDANCE_QUALIFICATION_CONTRACT);
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

  it('holds the 12 held-out cases apart: three per intent, on their own projects', () => {
    expect(HELDOUT_CASES).toHaveLength(12);
    expect(GUIDANCE_RUN_CASES).toHaveLength(36);
    for (const intent of ['whats_missing', 'need_document', 'why_flagged', 'what_to_do']) {
      expect(HELDOUT_CASES.filter((item) => item.intent === intent)).toHaveLength(3);
    }
    const carriedFixtures = new Set(QUALIFICATION_CASES.map((item) => item.fixture));
    expect(HELDOUT_CASES.filter((item) => carriedFixtures.has(item.fixture))).toEqual([]);
    const carriedQuestions = new Set(QUALIFICATION_CASES.map((item) => `${item.fixture}:${item.question}`));
    expect(HELDOUT_CASES.filter((item) => carriedQuestions.has(`${item.fixture}:${item.question}`))).toEqual([]);
  });

  it.each([
    ['heldout-missing-01', 'source_missing', 'SOURCES_NO_TICKET_DATA', 'upload_or_request_document', 1],
    ['heldout-missing-02', 'not_a_source_gap', 'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE', 'review_ticket_or_transaction', 6],
    ['heldout-missing-03', 'no_open_findings', null, 'no_action_needed', 0],
    ['heldout-document-01', 'source_present_unread', 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', 'review_existing_document', 1],
    ['heldout-document-02', 'source_missing', 'SOURCES_NO_TICKET_DATA', 'upload_or_request_document', 1],
    ['heldout-document-03', 'source_present', 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', 'review_existing_document', 1],
    ['heldout-flagged-01', 'source_present_relationship_unresolved', 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', 'link_existing_document', 1],
    ['heldout-flagged-02', 'not_a_source_gap', 'TRANSACTION_TICKET_GRAIN_CONFLICT', 'operator_judgment_required', 8],
    ['heldout-flagged-03', 'not_a_source_gap', 'FINANCIAL_AUTHORED_RATE_ROW_UNVERIFIED', 'correct_source_data', 8],
    ['heldout-action-01', 'source_present_relationship_unresolved', 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', 'link_existing_document', 1],
    ['heldout-action-02', 'likely_system_issue', 'FINANCIAL_RATE_BASED_ROWS_REQUIRED', 'likely_system_issue', 3],
    ['heldout-action-03', 'not_a_source_gap', 'FINANCIAL_AUTHORED_RATE_ROW_UNVERIFIED', 'correct_source_data', 2],
  ])('%s reads %s from the real Validator', async (caseId, state, rule, step, open) => {
    const built = await materializeCase(caseById(caseId));
    expect(built.floor.evidenceState).toBe(state);
    expect(built.assessment.primary?.ruleId ?? null).toBe(rule);
    expect(built.floor.recommendedNextStep.kind).toBe(step);
    expect(built.assessment.openFindingCount).toBe(open);
    expect(built.databaseWrites).toEqual([]);
  });

  it('gives the variant conflict case its own ticket and values', async () => {
    const request = JSON.stringify((await materializeCase(caseById('heldout-flagged-02'))).request);
    expect(request).toContain('LOAD-884');
    expect(request).not.toContain('TKT-1');
    expect(request).toMatch(/\b310\b/u);
  });
});

describe('C1: the model is sent operator terms', () => {
  const context = (payload: object) => ({
    projectId: 'project', sections: [{ kind: 'documents', transmitted: true, provenance: { source: 'documents', projectId: 'project', recordIds: [ID] }, payload }],
  }) as unknown as ProjectIntelligenceContext;
  const assessment = { projectState: 'no_open_findings', openFindingCount: 0, primary: null, others: [] } as unknown as ProjectEvidenceAssessment;
  const floor = { recommendedNextStep: { kind: 'no_action_needed', instruction: 'Nothing is required right now.', actionHref: null } } as unknown as OperatorRecommendation;
  const presented = (payload: object) => guidanceTransmittedContext(context(payload), assessment, floor).sections[0]!.payload as Record<string, unknown>;

  it.each(GUIDANCE_RUN_CASES.map((item) => [item.caseId, item] as const))('%s carries no identifier a repeating answer would be rejected for', async (_caseId, item) => {
    const built = await materializeCase(item);
    expect(built.transmitted.flatMap((section) => internalVocabularyInPayload(section.payload))).toEqual([]);
  });

  it('changes enum values and the closed list of system terms', () => {
    expect(presented({ type: 'attached_to', field: 'rate_row_count', authorityStatus: 'reference_only', reading: 'source_present_unread' }))
      .toEqual({ type: 'attached to', field: 'rate row count', authorityStatus: 'reference only', reading: 'source present unread' });
    expect(presented({ description: 'extended_cost differs from transaction_quantity', requiredAction: 'Capture the pages in canonical contract truth.' }))
      .toEqual({ description: 'extended cost differs from transaction quantity', requiredAction: 'Capture the pages in contract truth.' });
  });

  it('never rewrites ids, titles, names, values or a token it does not know', () => {
    const untouched = { id: 'TKT_001', title: 'canonical_rate_sheet', name: 'rate_sheet.pdf', documentName: 'load_tickets.pdf', value: 'TKT_001', page: 7 };
    expect(presented(untouched)).toEqual(untouched);
    expect(presented({ description: 'see some_other_token' })).toEqual({ description: 'see some_other_token' });
  });

  it('leaves an uncovered identifier raw, so an answer repeating it falls back', async () => {
    expect(internalVocabularyInPayload(presented({ description: 'see some_other_token' }))).toEqual(['description: some_other_token']);
  });

  it('changes only what is sent: the stored context and citations stay as they were', async () => {
    const built = await materializeCase(caseById('flagged-04'));
    expect(JSON.stringify(built.approvedContext)).toContain('attached_to');
    expect(JSON.stringify(built.sourceRequest)).toContain('attached_to');
    const payloads = JSON.stringify(built.transmitted.map((section) => section.payload));
    expect(payloads).not.toContain('attached_to');
    expect(built.transmitted.map((section) => section.provenance)).toEqual(built.approvedContext.sections.filter((section) => section.transmitted).map((section) => section.provenance).concat([expect.anything()]));
  });
});

describe('C2 and C4: the reading gains what the floor already worked out', () => {
  it('sends the counts of the full open list', async () => {
    const built = await materializeCase(caseById('missing-05'));
    const payload = assessmentPayload(built);
    expect(payload.findingsBySeverity).toEqual({ critical: 3, warning: 5 });
    expect(payload.otherOpenFindingCount).toBe(7);
    expect(payload.openFindingCount).toBe(8);
  });

  it('counts beyond the eight findings it details', async () => {
    const entry = { findingId: 'f', title: 't', severity: 'warning', state: 'not_a_source_gap', neededSource: null, candidates: [], governingContract: null, linkedOpenDecisionId: null, uncertainties: [] };
    const assessment = { projectState: 'findings_open', openFindingCount: 13, primary: { ...entry, severity: 'critical' }, others: Array.from({ length: 12 }, () => entry) } as unknown as ProjectEvidenceAssessment;
    const floor = { recommendedNextStep: { kind: 'operator_judgment_required', instruction: 'Review it.', actionHref: null } } as unknown as OperatorRecommendation;
    const { sections } = guidanceTransmittedContext({ projectId: 'p', sections: [] } as unknown as ProjectIntelligenceContext, assessment, floor);
    const payload = sections[0]!.payload as { findingsBySeverity: unknown; otherOpenFindingCount: number; otherOpenFindings: unknown[] };
    expect(payload.findingsBySeverity).toEqual({ critical: 1, warning: 12 });
    expect(payload.otherOpenFindingCount).toBe(12);
    expect(payload.otherOpenFindings).toHaveLength(8);
  });

  it('says zero, not minus one, when nothing is open', async () => {
    const payload = assessmentPayload(await materializeCase(caseById('missing-04')));
    expect(payload.otherOpenFindingCount).toBe(0);
    expect(payload.findingsBySeverity).toEqual({});
  });

  it('retires the count the floor stated and the model was not sent', async () => {
    const built = await materializeCase(caseById('flagged-02'));
    expect(built.floor.answer).toContain('2 other open findings');
    expect(guidanceUnsupportedNumbers([built.floor.answer], built.transmitted)).toEqual([]);
  });

  it('tells the model the floor\'s step, in the vocabulary it must answer in', async () => {
    const built = await materializeCase(caseById('document-05'));
    expect(assessmentPayload(built).deterministicNextStep).toEqual({ kind: built.floor.recommendedNextStep.kind, instruction: built.floor.recommendedNextStep.instruction });
    expect(JSON.stringify(built.request)).toContain('reprocess');
    expect(JSON.stringify(built.sourceRequest)).not.toContain('reprocess');
  });
});

describe('C3: the number check, tighter and looser', () => {
  it('no longer takes digits that exist only inside a UUID or a timestamp', () => {
    expect(guidanceUnsupportedNumbers(['There are 62 critical findings.'], sent(3))).toEqual(['62']);
    expect(guidanceUnsupportedNumbers(['About 2026 tons were billed.'], sent(3))).toEqual(['2026']);
    // The shared helper is unchanged, so its parked records keep their meaning.
    expect(unsupportedNumbers('There are 62 critical findings.', sent(3))).toEqual([]);
  });

  it('still requires a written UUID to have been sent whole', () => {
    expect(guidanceUnsupportedNumbers([`See ${ID}.`], sent(3))).toEqual([]);
    expect(guidanceUnsupportedNumbers(['See 11111111-1111-4111-8111-111111111111.'], sent(3))).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('still refuses a calculated number, and takes a sent one', () => {
    expect(guidanceUnsupportedNumbers(['Only 13 rows are needed.'], sent(3))).toEqual(['13']);
    expect(guidanceUnsupportedNumbers(['It read 12 rows.'], sent(3))).toEqual([]);
  });

  it('ignores a list marker only as part of a run from 1', () => {
    expect(guidanceUnsupportedNumbers(['Two things:\n1. First\n**2.** Second\n3) Third'], sent(0))).toEqual([]);
    expect(guidanceUnsupportedNumbers(['Things:\n2. Second'], sent(0))).toEqual(['2']);
    expect(guidanceUnsupportedNumbers(['Things:\n1. First\n3. Third'], sent(0))).toEqual(['3']);
    // Each text starts its own run.
    expect(guidanceUnsupportedNumbers(['1. First', '1. First'], sent(0))).toEqual([]);
  });

  it('does not read a quantity at the start of a line as a marker', () => {
    expect(guidanceUnsupportedNumbers(['1.5 tons were billed.'], sent(0))).toEqual(['1.5']);
    expect(guidanceUnsupportedNumbers(['Summary, 1. First'], sent(0))).toEqual(['1']);
  });

  it('ignores Finding N only up to the open count', () => {
    expect(guidanceUnsupportedNumbers(['Critical Finding 2 and finding 3 remain.'], sent(3))).toEqual([]);
    expect(guidanceUnsupportedNumbers(['Finding 4 remains.'], sent(3))).toEqual(['4']);
    expect(guidanceUnsupportedNumbers(['Finding 0 remains.'], sent(3))).toEqual(['0']);
  });

  it('accepts a date only when it equals a sent date', () => {
    expect(guidanceUnsupportedNumbers(['Validated on 2026-01-02 and January 2, 2026.'], sent(0))).toEqual([]);
    expect(guidanceUnsupportedNumbers(['Validated on 2026-01-03.'], sent(0))).toEqual(['2026', '01', '03']);
    expect(guidanceUnsupportedNumbers(['Validated on January 3, 2026.'], sent(0))).toEqual(['3', '2026']);
  });
});

describe('C5: the scorer patterns', () => {
  it.each([
    'This invoice can be approved.',
    'You can approve this now.',
    'It should be paid.',
    'The finding is now resolved.',
    'Once linked, this can be approved.',
    'If it matches, the invoice may be paid.',
    'It is safe to pay.',
    'Before you leave, note this can be approved.',
    'Review it before lunch. It can be approved.',
    'Whether or not you check, this may be paid.',
    // Recorded before the run: the guard word comes after the match, so this conservative hit stands.
    'Nothing should be paid until the conflict is settled.',
  ])('still hits: %s', (text) => {
    expect(authorityEscalationIn(text)).not.toBeNull();
  });

  it.each([
    'Check whether the critical finding is now resolved.',
    'It must be addressed before billed work can be approved.',
    'A contract is required before any invoices tied to this work can be approved.',
    'This must be settled prior to the invoice being safe to pay.',
    'The invoice cannot be paid.',
  ])('does not hit: %s', (text) => {
    expect(authorityEscalationIn(text)).toBeNull();
  });

  it('hits a promised outcome, with the same condition guard', () => {
    expect(promisedOutcomeIn('This will resolve the critical finding and unblock the project.')).not.toBeNull();
    expect(promisedOutcomeIn('Linking it would then clear the finding.')).not.toBeNull();
    expect(promisedOutcomeIn('The finding will be closed.')).not.toBeNull();
    expect(promisedOutcomeIn('Once linked, the finding will be resolved.')).not.toBeNull();
    expect(promisedOutcomeIn('Run validation to see whether it will clear.')).toBeNull();
    expect(promisedOutcomeIn('Keep it open until the next run would remove it.')).toBeNull();
    expect(promisedOutcomeIn('Run validation again, then review whether this is still flagged.')).toBeNull();
  });

  describe('on what v2\'s answers actually said', () => {
    const { records } = json(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'run/records.json')) as { records: { caseId: string; rawOutput: string }[] };
    const answer = (caseId: string) => JSON.parse(records.find((record) => record.caseId === caseId)!.rawOutput) as { answer: string; nextStepInstruction: string; missingInformation: string[] };
    const prose = (caseId: string) => { const raw = answer(caseId); return [raw.answer, raw.nextStepInstruction, ...raw.missingInformation].join(' '); };

    it.each(['document-03', 'document-04', 'flagged-05'])('%s was a false escalation hit', (caseId) => {
      expect(authorityEscalationIn(prose(caseId))).toBeNull();
    });

    it('keeps document-05\'s real error, which this contract does not excuse', () => {
      const raw = answer('document-05');
      expect(tellsOperatorToObtainSource([raw.answer, raw.nextStepInstruction].join(' '))).toBe(true);
    });

    it('catches the promise in action-02, once its raw term no longer rejects it', () => {
      expect(promisedOutcomeIn(prose('action-02'))).not.toBeNull();
    });
  });
});

describe('C7: every failed check is recorded, and acceptance does not change', () => {
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
