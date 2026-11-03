import { describe, expect, it } from 'vitest';

import type { DocumentRelationshipRecord, ResolvedDocumentPrecedenceFamily } from '@/lib/documentPrecedence';
import { resolveDocumentPrecedence } from '@/lib/documentPrecedence';
import type { AskDocument, ValidatorFinding } from '@/lib/ask/types';
import {
  classifyOperatorIntent,
  CONTEXT_SECTION_KINDS,
  INTENT_CONTEXT_SECTIONS,
  OPERATOR_INTENTS,
  planProjectContext,
  type OperatorIntent,
} from '@/lib/projectIntelligence/contextPlan';
import {
  assessProjectEvidence,
  EVIDENCE_STATES,
  factKeysForFindings,
  NEXT_STEP_KINDS,
  SOURCE_NEED_BY_RULE,
  UPLOAD_RULES_REQUIRING_JUDGMENT,
} from '@/lib/projectIntelligence/evidenceAssessment';
import {
  deriveProductImprovementSignals,
  PRODUCT_SIGNAL_CATEGORIES,
} from '@/lib/projectIntelligence/improvementSignal';
import {
  authorityClaimIn,
  deterministicRecommendation,
  internalVocabularyIn,
} from '@/lib/projectIntelligence/operatorRecommendation';
import {
  assembleProjectContext,
  contextRecordIndex,
  LOCAL_ONLY_POLICY,
  type ProjectContextSources,
} from '@/lib/projectIntelligence/projectContext';
import { VALIDATOR_RULE_EXPLANATIONS } from '@/lib/validator/ruleExplanations';

/**
 * The shape of the Goodlettsville project: a rate-based contract and a separately
 * uploaded price sheet (one PDF, uploaded twice) with no link between them. The
 * precedence families come from the real resolver, not from hand-written state.
 */

const PROJECT = 'project-goodlettsville';
const CONTRACT = 'doc-contract';
const SHEET = 'doc-price-sheet';
const SHEET_DUPLICATE = 'doc-price-sheet-duplicate';
const AT = '2026-10-01T00:00:00.000Z';
const LATER = '2026-10-05T00:00:00.000Z';

function document(id: string, title: string, documentType: string, overrides: Partial<AskDocument> = {}): AskDocument {
  return { id, title, documentName: title, documentType, processingStatus: 'decisioned', createdAt: AT, processedAt: AT, ...overrides };
}

const CONTRACT_DOCUMENT = document(CONTRACT, 'Goodlettsville Debris Contract', 'contract');
const SHEET_DOCUMENT = document(SHEET, 'Goodlettsville Price Sheet', 'price sheet');

function finding(ruleId: string, overrides: Partial<ValidatorFinding> = {}): ValidatorFinding {
  return {
    id: `finding-${ruleId}`, severity: 'critical', category: 'required_sources', description: 'Flagged', blocksProject: true,
    lastRun: AT, timestamp: AT, status: 'open', ruleId, subjectId: PROJECT, field: null, evidenceDocumentIds: [], ...overrides,
  };
}

function precedence(documents: readonly AskDocument[], relationships: DocumentRelationshipRecord[] = []): {
  families: ResolvedDocumentPrecedenceFamily[]; relationships: DocumentRelationshipRecord[];
} {
  const families = resolveDocumentPrecedence({
    documents: documents.map((entry) => ({ id: entry.id, project_id: PROJECT, title: entry.title, name: entry.documentName ?? entry.title,
      document_type: entry.documentType ?? null, created_at: entry.createdAt })),
    relationships,
  });
  return { families, relationships };
}

function link(id: string, source: string, target: string, type = 'attached_to'): DocumentRelationshipRecord {
  return { id, project_id: PROJECT, source_document_id: source, target_document_id: target, relationship_type: type, created_at: AT };
}

function sources(params: Readonly<{
  findings?: readonly ValidatorFinding[];
  documents?: readonly AskDocument[];
  relationships?: DocumentRelationshipRecord[];
  latestRunAt?: string | null;
}> = {}): ProjectContextSources {
  const documents = params.documents ?? [CONTRACT_DOCUMENT, SHEET_DOCUMENT];
  return {
    project: { id: PROJECT, name: 'Goodlettsville', validationStatus: 'BLOCKED' },
    findings: { open: params.findings ?? [finding('FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED')], latestRunAt: params.latestRunAt === undefined ? LATER : params.latestRunAt },
    documents,
    precedence: precedence(documents, params.relationships ?? []),
    facts: [],
    decisions: [],
    reviewedTruth: { effective: [], held: [] },
  };
}

function read(intent: OperatorIntent, input: ProjectContextSources, focusFindingId: string | null = null) {
  const plan = planProjectContext(intent, { focusFindingId });
  const assessment = assessProjectEvidence({ intent, focusFindingId, sources: input });
  const context = assembleProjectContext({ organizationId: 'org-1', plan, sources: input, policy: LOCAL_ONLY_POLICY });
  const raw = input.findings?.open.find((entry) => entry.id === assessment.primary?.findingId);
  const recommendation = deterministicRecommendation({ context, assessment,
    primaryFinding: raw ? { subjectId: raw.subjectId ?? null, evidenceDocumentIds: raw.evidenceDocumentIds ?? [], page: null } : null });
  return { plan, assessment, context, recommendation };
}

describe('intent -> context plan (proof 1, 3)', () => {
  it.each([
    ['What am I missing?', 'whats_missing'],
    ['what else is missing on this project', 'whats_missing'],
    ['Do I need another document?', 'need_document'],
    ['Do we need to upload a rate schedule?', 'need_document'],
    ['Should I request the amendment?', 'need_document'],
    ['Why is this flagged?', 'why_flagged'],
    ['Why is the invoice blocked?', 'why_flagged'],
    ['What should I do?', 'what_to_do'],
    ['What is the next step?', 'what_to_do'],
  ] as const)('%s -> %s', (question, intent) => {
    expect(classifyOperatorIntent(question)?.intent).toBe(intent);
  });

  it('leaves fact lookups to the plain Ask path, unless they were asked from a finding', () => {
    expect(classifyOperatorIntent('What is the contract ceiling?')).toBeNull();
    expect(classifyOperatorIntent('Tell me about the contractor')).toBeNull();
    expect(classifyOperatorIntent('Explain this', { hasFocusFinding: true })).toEqual({ intent: 'why_flagged', basis: 'focus_finding' });
  });

  it('is deterministic: the same intent always yields the same plan', () => {
    for (const intent of OPERATOR_INTENTS) {
      expect(planProjectContext(intent)).toEqual(planProjectContext(intent));
      expect(planProjectContext(intent).sections).toContain('validator_findings');
    }
  });

  it('never plans every section: each intent leaves something out', () => {
    for (const intent of OPERATOR_INTENTS) {
      expect(INTENT_CONTEXT_SECTIONS[intent].length).toBeLessThan(CONTEXT_SECTION_KINDS.length);
    }
    expect(INTENT_CONTEXT_SECTIONS.need_document).not.toContain('operator_decisions');
    expect(INTENT_CONTEXT_SECTIONS.whats_missing).not.toContain('canonical_facts');
  });

  it('records a section the plan left out as omitted, not silently absent', () => {
    const { context } = read('need_document', sources());
    expect(context.sections.map((section) => section.kind)).not.toContain('operator_decisions');
    expect(context.omissions).toContainEqual({ kind: 'operator_decisions', reason: 'not_in_plan' });
  });

  it('asks only for facts the open findings make relevant', () => {
    expect(factKeysForFindings([{ ruleId: 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', field: 'rate_schedule_present' }]))
      .toEqual(['rate_row_count', 'rate_schedule_pages', 'rate_schedule_present']);
    expect(factKeysForFindings([{ ruleId: 'INVOICE_DUPLICATE_BILLED_LINE', field: null }])).toEqual([]);
  });
});

describe('the first slice: the project already holds the schedule', () => {
  it('tells the operator no document is needed and to check the link', () => {
    const { recommendation, assessment } = read('need_document', sources());
    expect(assessment.primary?.state).toBe('source_present_relationship_unresolved');
    expect(recommendation.evidenceState).toBe('source_present_relationship_unresolved');
    expect(recommendation.answer).toContain('Goodlettsville Price Sheet');
    expect(recommendation.answer).toMatch(/No additional document appears necessary/u);
    expect(recommendation.recommendedNextStep.kind).toBe('link_existing_document');
    expect(recommendation.recommendedNextStep.instruction).toContain('Goodlettsville Debris Contract');
    expect(recommendation.needsHumanReview).toBe(true);
  });

  it('cites records that all resolve to this project\'s context', () => {
    const { recommendation, context } = read('need_document', sources());
    const index = contextRecordIndex(context);
    expect(recommendation.evidenceRefs.length).toBeGreaterThan(0);
    for (const ref of recommendation.evidenceRefs) expect(index.has(ref.recordId)).toBe(true);
    expect(recommendation.evidenceRefs.map((ref) => ref.recordId)).toEqual(
      expect.arrayContaining(['finding-FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', SHEET, CONTRACT]));
  });

  it('offers the existing linked-documents route, never a new one', () => {
    const { recommendation } = read('need_document', sources());
    expect(recommendation.recommendedNextStep.actionHref).toBe(`/platform/projects/${PROJECT}#project-documents`);
  });

  it('emits the product signal separately, and it is about the relationship', () => {
    const { assessment, recommendation } = read('need_document', sources());
    const [signal] = deriveProductImprovementSignals(assessment);
    expect(signal).toMatchObject({
      category: 'relationship_precedence', code: 'source_present_relationship_may_block_validator',
      orchestratorRootCause: 'relationship_governance_issue', authority: 'non_authoritative', audience: 'internal', reviewRequired: true,
    });
    expect(Object.keys(recommendation)).not.toContain('signal');
    expect(JSON.stringify(recommendation)).not.toContain('source_present_relationship_may_block_validator');
  });

  it('counts one PDF uploaded twice as one source, not two', () => {
    const duplicate = document(SHEET_DUPLICATE, 'Goodlettsville Price Sheet', 'price sheet');
    const { assessment } = read('need_document', sources({
      documents: [CONTRACT_DOCUMENT, SHEET_DOCUMENT, duplicate],
      relationships: [link('rel-dup', SHEET_DUPLICATE, SHEET, 'duplicate_of')],
    }));
    expect(assessment.primary?.candidates.map((entry) => entry.id)).toEqual([SHEET]);
  });
});

describe('the four outcomes an operator must be able to tell apart (proof 7)', () => {
  it('truly missing: no such document exists', () => {
    const { assessment, recommendation } = read('need_document', sources({ documents: [CONTRACT_DOCUMENT] }));
    expect(assessment.primary?.state).toBe('source_missing');
    expect(recommendation.recommendedNextStep.kind).toBe('upload_or_request_document');
    // The rule's own contract could still hold the pages: said, not assumed.
    expect(recommendation.missingInformation.join(' ')).toMatch(/contract itself/u);
  });

  it('already present: read and linked, and validation has not caught up', () => {
    const { assessment, recommendation } = read('need_document', sources({
      documents: [CONTRACT_DOCUMENT, document(SHEET, 'Goodlettsville Price Sheet', 'price sheet', { processedAt: LATER })],
      relationships: [link('rel-1', SHEET, CONTRACT)],
      latestRunAt: AT,
    }));
    expect(assessment.primary?.state).toBe('source_present');
    expect(recommendation.recommendedNextStep.kind).toBe('review_existing_document');
    expect(recommendation.recommendedNextStep.instruction).toMatch(/validation again/u);
  });

  it('present but unlinked: the relationship is what is open', () => {
    const { assessment } = read('need_document', sources());
    expect(assessment.primary?.state).toBe('source_present_relationship_unresolved');
  });

  it('present with authority unsettled: a person decides, it is not called linked', () => {
    const input = sources({ relationships: [link('rel-1', SHEET, CONTRACT)] });
    const families = (input.precedence!.families).map((family) => ({
      ...family, documents: family.documents.map((entry) => entry.id === SHEET ? { ...entry, authority_status: 'reference_only' } : entry),
    }));
    const { assessment, recommendation } = read('need_document', { ...input, precedence: { ...input.precedence!, families } });
    expect(assessment.primary?.state).toBe('source_present_relationship_unresolved');
    expect(recommendation.missingInformation.join(' ')).toMatch(/authority has not been settled/u);
  });

  it('likely ours: read, linked, validation current, still flagged', () => {
    const { assessment, recommendation } = read('need_document', sources({ relationships: [link('rel-1', SHEET, CONTRACT)] }));
    expect(assessment.primary?.state).toBe('likely_system_issue');
    expect(recommendation.recommendedNextStep.kind).toBe('likely_system_issue');
    expect(recommendation.confidence).toBe('low');
    expect(deriveProductImprovementSignals(assessment)[0]?.category).toBe('validator_logic');
  });

  it('present but unread is its own outcome: extraction, not a missing source', () => {
    const { assessment } = read('need_document', sources({
      documents: [CONTRACT_DOCUMENT, document(SHEET, 'Goodlettsville Price Sheet', 'price sheet', { processingStatus: 'failed', processedAt: null })],
    }));
    expect(assessment.primary?.state).toBe('source_present_unread');
    expect(deriveProductImprovementSignals(assessment)[0]?.category).toBe('extraction');
  });

  it('a failed document read concludes nothing: never "missing"', () => {
    const { assessment } = read('need_document', { ...sources(), documents: null, precedence: null });
    expect(assessment.primary?.state).toBe('evidence_unavailable');
    expect(assessment.primary?.nextSteps).not.toContain('upload_or_request_document');
  });

  it('the contract can be the source when the rule says a schedule exists', () => {
    const { assessment } = read('need_document', sources({
      findings: [finding('FINANCIAL_RATE_BASED_ROWS_REQUIRED')], documents: [CONTRACT_DOCUMENT],
    }));
    expect(assessment.primary?.state).toBe('likely_system_issue');
    expect(assessment.primary?.candidates.map((entry) => entry.id)).toEqual([CONTRACT]);
  });
});

describe('when nothing is flagged', () => {
  it('says no action only after validation has actually run', () => {
    const { recommendation } = read('whats_missing', sources({ findings: [] }));
    expect(recommendation.recommendedNextStep.kind).toBe('no_action_needed');
    expect(recommendation.needsHumanReview).toBe(false);
  });

  it('does not read "no findings" as "nothing missing" when validation never ran', () => {
    const { recommendation } = read('whats_missing', sources({ findings: [], latestRunAt: null }));
    expect(recommendation.evidenceState).toBe('validation_not_run');
    expect(recommendation.recommendedNextStep.kind).toBe('operator_judgment_required');
    expect(recommendation.confidence).toBe('low');
  });
});

describe('findings that are not about a source', () => {
  it('a conflict goes to a person, and is not presented as resolved', () => {
    const { assessment } = read('what_to_do', sources({ findings: [finding('TRANSACTION_TICKET_GRAIN_CONFLICT')] }));
    expect(assessment.primary?.state).toBe('not_a_source_gap');
    expect(assessment.primary?.nextSteps[0]).toBe('operator_judgment_required');
    for (const ruleId of Object.keys(VALIDATOR_RULE_EXPLANATIONS).filter((id) => /_CONFLICT(?:ING)?$/u.test(id))) {
      const { assessment: next } = read('what_to_do', sources({ findings: [finding(ruleId)] }));
      expect(next.primary?.nextSteps[0]).toBe('operator_judgment_required');
    }
  });

  it('a transaction rule points at tickets and transactions', () => {
    const { recommendation } = read('why_flagged', sources({ findings: [finding('TRANSACTION_RATE_OUTLIERS')] }));
    expect(recommendation.recommendedNextStep.kind).toBe('review_ticket_or_transaction');
  });

  it('an unknown rule is honest about it and goes to a person', () => {
    const { assessment } = read('why_flagged', sources({ findings: [finding('NOT_A_RULE')] }));
    expect(assessment.primary?.nextSteps).toEqual(['operator_judgment_required']);
    expect(assessment.primary?.confidence).toBe('low');
  });

  it('leads a document question with the source gap even when a different finding is more severe', () => {
    const { assessment } = read('whats_missing', sources({ findings: [
      finding('TRANSACTION_RATE_OUTLIERS', { id: 'a-first' }),
      finding('SOURCES_NO_RATE_SCHEDULE', { id: 'z-last', severity: 'warning' }),
    ] }));
    expect(assessment.primary?.findingId).toBe('z-last');
    expect(assessment.others.map((entry) => entry.findingId)).toEqual(['a-first']);
  });

  it('a question from a finding stays on that finding', () => {
    const { assessment } = read('whats_missing', sources({ findings: [
      finding('SOURCES_NO_RATE_SCHEDULE', { id: 'gap' }),
      finding('TRANSACTION_RATE_OUTLIERS', { id: 'focus', severity: 'warning' }),
    ] }), 'focus');
    expect(assessment.primary?.findingId).toBe('focus');
  });
});

describe('operator language and authority (proof 5)', () => {
  const scenarios: ReadonlyArray<ProjectContextSources> = [
    sources(),
    sources({ documents: [CONTRACT_DOCUMENT] }),
    sources({ relationships: [link('rel-1', SHEET, CONTRACT)] }),
    sources({ findings: [] }),
    sources({ findings: [], latestRunAt: null }),
    sources({ findings: [finding('TRANSACTION_RATE_OUTLIERS')] }),
    sources({ findings: [finding('FINANCIAL_RATE_CODE_MISSING')] }),
    sources({ documents: [CONTRACT_DOCUMENT, document(SHEET, 'Goodlettsville Price Sheet', 'price sheet', { processingStatus: 'failed', processedAt: null })] }),
    { ...sources(), documents: null, precedence: null },
    { ...sources(), findings: null },
  ];

  it('never puts internal vocabulary or a claim of action into any deterministic answer', () => {
    for (const input of scenarios) {
      for (const intent of OPERATOR_INTENTS) {
        const { recommendation } = read(intent, input);
        const text = [recommendation.answer, recommendation.recommendedNextStep.instruction, ...recommendation.missingInformation].join(' ');
        expect(internalVocabularyIn(text)).toBeNull();
        expect(authorityClaimIn(text)).toBeNull();
        expect(recommendation.authority).toBe('non_authoritative');
      }
    }
  });

  it('detects the internal phrasing the operator must not get', () => {
    expect(internalVocabularyIn('The Validator needs contract-family traversal to an authoritative rate exhibit.')).toBe('traversal');
    expect(internalVocabularyIn('Rule FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED fired.')).toBe('FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED');
    expect(authorityClaimIn('I have linked the schedule to the contract.')).not.toBeNull();
    expect(authorityClaimIn('Check whether the schedule is linked to the contract.')).toBeNull();
  });

  it('only ever offers next steps from the closed vocabulary, and no vocabulary entry writes', () => {
    for (const input of scenarios) {
      const { assessment } = read('what_to_do', input);
      for (const step of assessment.primary?.nextSteps ?? []) expect(NEXT_STEP_KINDS).toContain(step);
    }
    expect(NEXT_STEP_KINDS.join(' ')).not.toMatch(/approve|clear|override|activate|resolve/u);
    expect(EVIDENCE_STATES).toContain('source_present_relationship_unresolved');
  });
});

describe('product signal stays separate and content-free (proof 6)', () => {
  it('holds codes and references, never customer text', () => {
    const { assessment } = read('need_document', sources());
    const text = JSON.stringify(deriveProductImprovementSignals(assessment));
    expect(text).not.toContain('Goodlettsville');
    expect(text).not.toContain('Price Sheet');
  });

  it('has no field that could act on anything', () => {
    const [signal] = deriveProductImprovementSignals(read('need_document', sources()).assessment);
    expect(Object.keys(signal!).sort()).toEqual(['audience', 'authority', 'category', 'code', 'evidenceState',
      'findingRef', 'orchestratorRootCause', 'recordRefs', 'reviewRequired', 'ruleId', 'schemaVersion']);
    expect(PRODUCT_SIGNAL_CATEGORIES).toContain(signal!.category);
    expect(signal!.findingRef).toMatch(/^(?:sha256:[0-9a-f]{64}|[0-9a-f-]{36})$/u);
  });

  it('digests a record id it cannot prove is not customer text', () => {
    const [signal] = deriveProductImprovementSignals(read('need_document', sources()).assessment);
    for (const ref of signal!.recordRefs) expect(ref).toMatch(/^(?:sha256:[0-9a-f]{64}|[0-9a-f-]{36})$/u);
  });

  it('a normal finding yields no signal at all: signals are optional', () => {
    const { assessment } = read('why_flagged', sources({ findings: [finding('TRANSACTION_RATE_OUTLIERS')] }));
    expect(deriveProductImprovementSignals(assessment)).toEqual([]);
  });
});

describe('no duplicate business logic (proof 8)', () => {
  it('the source-need table names only catalogue rules', () => {
    for (const ruleId of Object.keys(SOURCE_NEED_BY_RULE)) expect(VALIDATOR_RULE_EXPLANATIONS[ruleId]).toBeDefined();
  });

  it('every catalogue rule that can send an operator to upload is classified here', () => {
    const uploadRules = Object.entries(VALIDATOR_RULE_EXPLANATIONS)
      .filter(([, rule]) => rule.actions.includes('upload_document')).map(([ruleId]) => ruleId);
    expect(uploadRules.length).toBeGreaterThan(0);
    expect(uploadRules.filter((ruleId) => !SOURCE_NEED_BY_RULE[ruleId] && !UPLOAD_RULES_REQUIRING_JUDGMENT.has(ruleId))).toEqual([]);
  });

  it('explains a finding with the catalogue text, never a second copy', () => {
    const { context } = read('why_flagged', sources());
    const section = context.sections.find((entry) => entry.kind === 'validator_findings');
    const payload = section?.payload as { findings: Array<{ whatItChecks: string | null; requiredAction: string | null }> };
    expect(payload.findings[0]?.whatItChecks).toBe(VALIDATOR_RULE_EXPLANATIONS.FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED!.explanation);
    expect(payload.findings[0]?.requiredAction).toBe(VALIDATOR_RULE_EXPLANATIONS.FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED!.requiredAction);
  });
});

describe('transmission policy', () => {
  const plan = planProjectContext('need_document');

  it('sends nothing under the local policy', () => {
    const context = assembleProjectContext({ organizationId: 'org-1', plan, sources: sources(), policy: LOCAL_ONLY_POLICY });
    expect(context.sections.every((section) => !section.transmitted)).toBe(true);
  });

  it('sends approved sections within budget and lists what it dropped', () => {
    const context = assembleProjectContext({ organizationId: 'org-1', plan, sources: sources(),
      policy: { approvedContentClasses: ['text_excerpts'], maxTransmittedTextChars: 400 } });
    expect(context.sections.find((section) => section.kind === 'project_identity')?.transmitted).toBe(true);
    expect(context.omissions.some((entry) => entry.reason === 'over_budget')).toBe(true);
  });

  it('gives the same evidence the same digest, and different evidence a different one', () => {
    const one = assembleProjectContext({ organizationId: 'org-1', plan, sources: sources(), policy: LOCAL_ONLY_POLICY });
    const two = assembleProjectContext({ organizationId: 'org-1', plan, sources: sources(), policy: LOCAL_ONLY_POLICY });
    const other = assembleProjectContext({ organizationId: 'org-1', plan,
      sources: sources({ relationships: [link('rel-1', SHEET, CONTRACT)] }), policy: LOCAL_ONLY_POLICY });
    expect(one.readDigest).toBe(two.readDigest);
    expect(other.readDigest).not.toBe(one.readDigest);
  });

  it('a section that could not be read is reported as such, not as empty', () => {
    const context = assembleProjectContext({ organizationId: 'org-1', plan, sources: { ...sources(), documents: null }, policy: LOCAL_ONLY_POLICY });
    expect(context.omissions).toContainEqual({ kind: 'documents', reason: 'read_failed' });
  });
});
