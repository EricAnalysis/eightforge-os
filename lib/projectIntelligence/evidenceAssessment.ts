import {
  canonicalizeRelationshipType,
  resolveDuplicateDocumentIdsForAuthority,
  resolveDuplicateResolutionEligibleIds,
  type GoverningDocumentFamily,
  type ResolvedDocumentPrecedenceRecord,
} from '@/lib/documentPrecedence';
import type { ValidatorFinding } from '@/lib/ask/types';
import type { OperatorIntent } from '@/lib/projectIntelligence/contextPlan';
import { orderFindings, type ProjectContextSources } from '@/lib/projectIntelligence/projectContext';
import { validatorRuleExplanation } from '@/lib/validator/ruleExplanations';

/**
 * The deterministic reading of a project's evidence for one question: for each
 * open finding, whether the source it wants is truly missing, already present,
 * present but unread, present but unlinked, or present and still flagged.
 *
 * This decides what the operator is told is possible. A model may explain the
 * reading and choose among the next steps it offers, but it cannot change the
 * reading, so a confident-sounding answer can never turn "already in the
 * project" into "upload it".
 *
 * Read-only and generic: it uses only precedence, the rule catalogue and
 * processing state, never a document, customer or benchmark name. It is a view
 * for one request, not a truth state: nothing stores it and no rule reads it.
 */

export const EVIDENCE_STATES = [
  /** No document of the needed kind is in the project. */
  'source_missing',
  /** Present, read and linked; validation has not re-run since it was read. */
  'source_present',
  /** Present, but EightForge has not successfully read it. */
  'source_present_unread',
  /** Present and read, but not linked, or its authority is unsettled. */
  'source_present_relationship_unresolved',
  /** Present, read, linked and validation is current, yet the finding says it is missing. */
  'likely_system_issue',
  /** The finding is not about an absent source. */
  'not_a_source_gap',
  /** The evidence needed to tell could not be read. Nothing can be concluded. */
  'evidence_unavailable',
] as const;
export type EvidenceState = typeof EVIDENCE_STATES[number];

export const NEXT_STEP_KINDS = [
  'no_action_needed',
  'review_existing_document',
  'link_existing_document',
  'upload_or_request_document',
  'correct_source_data',
  'review_ticket_or_transaction',
  'operator_judgment_required',
  'likely_system_issue',
] as const;
export type NextStepKind = typeof NEXT_STEP_KINDS[number];

export type AssessmentConfidence = 'high' | 'medium' | 'low';

type SourceNeed = Readonly<{
  family: GoverningDocumentFamily;
  /** How this source is named to an operator. */
  label: string;
  /** The source only counts once it is tied to the governing contract. */
  linkToContract: boolean;
  /** Only this contract-family subtype satisfies the need. */
  subtype?: 'amendment';
  /** The rule itself says a schedule exists, so the contract may be the source. */
  sourceMayBeContract?: boolean;
}>;

const PRICING_SCHEDULE: SourceNeed = { family: 'rate_sheet', label: 'pricing schedule', linkToContract: true };

/**
 * Which rules are about an absent source, and which source. Every other rule is
 * not a source gap. Keys are catalogue rule ids; the companion test fails if a
 * rule offering `upload_document` is neither here nor in
 * `UPLOAD_RULES_REQUIRING_JUDGMENT`.
 */
export const SOURCE_NEED_BY_RULE: Readonly<Record<string, SourceNeed>> = Object.freeze({
  SOURCES_NO_CONTRACT: { family: 'contract', label: 'contract', linkToContract: false },
  SOURCES_NO_RATE_SCHEDULE: PRICING_SCHEDULE,
  SOURCES_NO_INVOICE_DATA: { family: 'invoice', label: 'invoice', linkToContract: false },
  SOURCES_NO_TICKET_DATA: { family: 'ticket_support', label: 'ticket or transaction data', linkToContract: false },
  SOURCES_REFERENCED_AMENDMENT_MISSING: { family: 'contract', subtype: 'amendment', label: 'referenced amendment', linkToContract: true },
  FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED: PRICING_SCHEDULE,
  FINANCIAL_RATE_BASED_ROWS_REQUIRED: { ...PRICING_SCHEDULE, sourceMayBeContract: true },
  FINANCIAL_RATE_BASED_PAGES_REQUIRED: { ...PRICING_SCHEDULE, sourceMayBeContract: true },
  CONTRACT_RATE_SCHEDULE_HINT_MISMATCH: { ...PRICING_SCHEDULE, sourceMayBeContract: true },
});

/** Rules that may lead to an upload, but whether a document is needed at all is a person's call. */
export const UPLOAD_RULES_REQUIRING_JUDGMENT: ReadonlySet<string> = new Set(['FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED']);

/** Field keys that can show a source was actually read, by the family they evidence. */
const FACT_KEYS_BY_FAMILY: Readonly<Partial<Record<GoverningDocumentFamily, readonly string[]>>> = Object.freeze({
  rate_sheet: ['rate_schedule_present', 'rate_row_count', 'rate_schedule_pages'],
  contract: ['contract_ceiling_type', 'contract_ceiling', 'nte_amount'],
  invoice: ['invoice_total', 'billed_amount', 'total_billed'],
});

/** Facts worth loading for these findings, so an irrelevant fact is never read. */
export function factKeysForFindings(findings: readonly Pick<ValidatorFinding, 'ruleId' | 'field'>[]): string[] {
  return [...new Set(findings.flatMap((finding) => {
    const need = finding.ruleId ? SOURCE_NEED_BY_RULE[finding.ruleId] : undefined;
    return [...(need ? FACT_KEYS_BY_FAMILY[need.family] ?? [] : []), ...(finding.field ? [finding.field] : [])];
  }))].sort();
}

/** Two sources disagree and EightForge will not choose. */
const CONFLICT_RULE = /_CONFLICT(?:ING)?$/u;

export type AssessedDocument = Readonly<{
  id: string;
  title: string;
  linkedToContract: boolean;
  read: boolean;
  authorityUnsettled: boolean;
  processedAt: string | null;
}>;

export type FindingAssessment = Readonly<{
  findingId: string;
  ruleId: string | null;
  title: string;
  severity: string;
  blocksProject: boolean;
  state: EvidenceState;
  /** What the finding wants, in operator language; null when it is not a source gap. */
  neededSource: string | null;
  candidates: readonly AssessedDocument[];
  /** Documents nothing classifies, which could hold the needed source. Their titles establish nothing. */
  unclassifiedDocuments?: readonly AssessedDocument[];
  governingContract: Readonly<{ id: string; title: string }> | null;
  /** The steps this reading allows, first the one it leads with. A model may not leave this list. */
  nextSteps: readonly NextStepKind[];
  /** Records the reading rests on: always citable. */
  evidenceRecordIds: readonly string[];
  supportingFactCount: number;
  linkedOpenDecisionId: string | null;
  uncertainties: readonly string[];
  confidence: AssessmentConfidence;
}>;

export type ProjectEvidenceAssessment = Readonly<{
  intent: OperatorIntent;
  projectState: 'findings_open' | 'no_open_findings' | 'validation_not_run' | 'evidence_unavailable';
  primary: FindingAssessment | null;
  others: readonly FindingAssessment[];
  openFindingCount: number;
  /** Open findings that are about a source, of any state. */
  sourceGapCount: number;
}>;

const NOT_READ_STATUSES: ReadonlySet<string> = new Set(['failed', 'uploaded', 'pending', 'processing', 'queued']);

function isRead(document: { processingStatus?: string | null; processedAt?: string | null } | undefined): boolean {
  if (!document) return false;
  if (document.processingStatus && NOT_READ_STATUSES.has(document.processingStatus)) return false;
  return Boolean(document.processedAt) || document.processingStatus === 'extracted' || document.processingStatus === 'decisioned';
}

type PrecedenceView = Readonly<{
  documents: readonly ResolvedDocumentPrecedenceRecord[];
  governingContract: ResolvedDocumentPrecedenceRecord | null;
  contractIds: ReadonlySet<string>;
  duplicateIds: ReadonlySet<string>;
  relationships: NonNullable<ProjectContextSources['precedence']>['relationships'];
}>;

function precedenceView(precedence: NonNullable<ProjectContextSources['precedence']>): PrecedenceView {
  const documents = precedence.families.flatMap((family) => family.documents);
  const contractFamily = precedence.families.find((family) => family.family === 'contract');
  const contractDocuments = contractFamily?.documents ?? [];
  return {
    documents,
    governingContract: contractDocuments.find((document) => document.id === contractFamily?.governing_document_id) ?? null,
    contractIds: new Set(contractDocuments.map((document) => document.id)),
    // The same document uploaded twice is one source: a duplicate is never a second candidate.
    duplicateIds: new Set(resolveDuplicateDocumentIdsForAuthority(
      precedence.relationships, resolveDuplicateResolutionEligibleIds(documents))),
    relationships: precedence.relationships,
  };
}

function isLinkedToContract(documentId: string, view: PrecedenceView): boolean {
  if (view.contractIds.has(documentId)) return true;
  return view.relationships.some((relationship) => {
    const type = canonicalizeRelationshipType(relationship.relationship_type);
    if (!type || type === 'duplicate_of') return false;
    return (relationship.source_document_id === documentId && view.contractIds.has(relationship.target_document_id))
      || (relationship.target_document_id === documentId && view.contractIds.has(relationship.source_document_id));
  });
}

const UNSETTLED_AUTHORITY: ReadonlySet<string> = new Set(['draft', 'reference_only']);
const NOT_IN_FORCE: ReadonlySet<string> = new Set(['superseded', 'archived']);

function candidateDocuments(need: SourceNeed, view: PrecedenceView, sources: ProjectContextSources): AssessedDocument[] {
  const byId = new Map((sources.documents ?? []).map((document) => [document.id, document]));
  const matches = view.documents.filter((document) => {
    if (view.duplicateIds.has(document.id) || NOT_IN_FORCE.has(document.authority_status ?? '')) return false;
    if (need.subtype) return document.family === need.family && document.resolved_subtype === need.subtype;
    if (document.family === need.family) return true;
    if (need.family !== 'rate_sheet') return false;
    // A schedule attached inside the contract family is still a pricing schedule.
    return document.resolved_subtype === 'pricing_schedule'
      || (need.sourceMayBeContract === true && document.id === view.governingContract?.id);
  });
  return matches.map((document) => {
    const listed = byId.get(document.id);
    return {
      id: document.id,
      title: listed?.title ?? document.title ?? document.name,
      linkedToContract: isLinkedToContract(document.id, view),
      read: isRead(listed),
      authorityUnsettled: UNSETTLED_AUTHORITY.has(document.authority_status ?? ''),
      processedAt: listed?.processedAt ?? null,
    };
  }).sort((left, right) => left.id.localeCompare(right.id, 'en-US'));
}

/** On file, but in no document family, so what they hold is unknown either way. */
function unclassifiedDocuments(view: PrecedenceView, sources: ProjectContextSources): AssessedDocument[] {
  const classified = new Set(view.documents.map((document) => document.id));
  return (sources.documents ?? []).filter((document) => !classified.has(document.id)).map((document) => ({
    id: document.id, title: document.title ?? document.id, linkedToContract: false, read: isRead(document), authorityUnsettled: true, processedAt: document.processedAt ?? null,
  })).sort((left, right) => left.id.localeCompare(right.id, 'en-US'));
}

function supportingFacts(candidates: readonly AssessedDocument[], need: SourceNeed, sources: ProjectContextSources) {
  const keys = new Set(FACT_KEYS_BY_FAMILY[need.family] ?? []);
  const ids = new Set(candidates.map((document) => document.id));
  return (sources.facts ?? []).filter((fact) => fact.fieldKey && keys.has(fact.fieldKey) && ids.has(fact.extractedFrom));
}

function nonGapNextSteps(finding: ValidatorFinding): readonly NextStepKind[] {
  const rule = validatorRuleExplanation(finding.ruleId);
  if (!rule) return ['operator_judgment_required'];
  if (finding.ruleId && CONFLICT_RULE.test(finding.ruleId)) return ['operator_judgment_required', 'review_existing_document'];
  if (finding.ruleId && UPLOAD_RULES_REQUIRING_JUDGMENT.has(finding.ruleId)) {
    return ['operator_judgment_required', 'review_existing_document', 'upload_or_request_document'];
  }
  // Support rules compare billed lines to tickets and transactions.
  if (rule.category === 'Support') return ['review_ticket_or_transaction', 'review_existing_document', 'operator_judgment_required'];
  if (rule.actions.includes('open_manual_rate_link') || rule.actions.includes('enter_reviewed_value')) {
    return ['correct_source_data', 'review_existing_document', 'operator_judgment_required'];
  }
  if (rule.category === 'Human review') return ['operator_judgment_required', 'review_existing_document'];
  return ['review_existing_document', 'operator_judgment_required'];
}

function assessSourceGap(
  finding: ValidatorFinding,
  need: SourceNeed,
  sources: ProjectContextSources,
): Pick<FindingAssessment, 'state' | 'candidates' | 'unclassifiedDocuments' | 'governingContract' | 'nextSteps' | 'evidenceRecordIds' | 'supportingFactCount' | 'uncertainties' | 'confidence'> {
  const precedence = sources.precedence;
  if (!precedence || !sources.documents) {
    return {
      state: 'evidence_unavailable', candidates: [], governingContract: null,
      nextSteps: ['review_existing_document', 'operator_judgment_required'],
      evidenceRecordIds: [finding.id], supportingFactCount: 0,
      uncertainties: ["The project's documents could not be read just now, so whether it already holds this is unknown."],
      confidence: 'low',
    };
  }
  const view = precedenceView(precedence);
  const candidates = candidateDocuments(need, view, sources);
  const governingContract = view.governingContract
    ? { id: view.governingContract.id, title: view.governingContract.title ?? view.governingContract.name } : null;
  const base = { candidates, governingContract };
  const records = [finding.id, ...candidates.map((document) => document.id), ...(governingContract ? [governingContract.id] : [])];

  if (candidates.length === 0) {
    const unclassified = unclassifiedDocuments(view, sources);
    if (unclassified.length > 0) {
      // Whether the source is absent is not established: what is on file gets inspected first.
      return {
        ...base, state: 'source_missing', unclassifiedDocuments: unclassified,
        nextSteps: ['review_existing_document', 'operator_judgment_required'],
        evidenceRecordIds: [...new Set([...records, ...unclassified.map((document) => document.id)])], supportingFactCount: 0,
        uncertainties: unclassified.slice(0, 3).map((document) => `Whether "${document.title}" holds what this needs cannot be told from its record, and its title does not settle it.`),
        confidence: 'low',
      };
    }
    const mayBeInside = need.family === 'rate_sheet' && governingContract != null;
    return {
      ...base, state: 'source_missing',
      nextSteps: mayBeInside ? ['upload_or_request_document', 'review_existing_document'] : ['upload_or_request_document'],
      evidenceRecordIds: [...new Set(records)], supportingFactCount: 0,
      uncertainties: mayBeInside ? ['Whether the contract itself contains the schedule pages has not been confirmed.'] : [],
      confidence: mayBeInside ? 'medium' : 'high',
    };
  }

  const facts = supportingFacts(candidates, need, sources);
  const read = candidates.filter((document) => document.read);
  const withFacts = { supportingFactCount: facts.length,
    evidenceRecordIds: [...new Set([...records, ...facts.map((fact) => fact.id)])] };
  if (read.length === 0) {
    return {
      ...base, ...withFacts, state: 'source_present_unread',
      nextSteps: ['review_existing_document', 'likely_system_issue'],
      uncertainties: ['EightForge has not finished reading this document, so its contents are not confirmed.'],
      confidence: 'medium',
    };
  }

  const settled = read.filter((document) => !document.authorityUnsettled);
  const linked = settled.filter((document) => !need.linkToContract || document.linkedToContract);
  if (linked.length === 0) {
    return {
      ...base, ...withFacts, state: 'source_present_relationship_unresolved',
      nextSteps: ['link_existing_document', 'review_existing_document', 'operator_judgment_required'],
      uncertainties: [
        ...(governingContract ? [] : ['No governing contract is established for this project yet.']),
        ...(settled.length === 0 ? ["This document's authority has not been settled: a person decides whether it applies."] : []),
        ...(facts.length === 0 ? ['Whether it covers everything the project needs has not been confirmed.'] : []),
      ],
      confidence: facts.length > 0 ? 'high' : 'medium',
    };
  }

  const latestRun = sources.findings?.latestRunAt ?? null;
  const readAfterValidation = latestRun != null && linked.some((document) => document.processedAt != null
    && new Date(document.processedAt).getTime() > new Date(latestRun).getTime());
  if (readAfterValidation) {
    return {
      ...base, ...withFacts, state: 'source_present',
      nextSteps: ['review_existing_document', 'operator_judgment_required'],
      uncertainties: ['Validation has not run since this document was read, so this finding may be out of date.'],
      confidence: 'medium',
    };
  }
  return {
    ...base, ...withFacts, state: 'likely_system_issue',
    nextSteps: ['likely_system_issue', 'review_existing_document', 'operator_judgment_required'],
    uncertainties: ['The reason EightForge still flags this has not been established.'],
    confidence: 'low',
  };
}

/** A billed line with no ticket group: tickets on file may or may not cover it, and that is not established. */
export const BILLED_LINE_SUPPORT_UNCERTAINTY = 'Whether the tickets on file cover this billed line, or more support is needed, has not been established.';
const UNCERTAINTY_BY_RULE: Readonly<Record<string, string>> = Object.freeze({ TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE: BILLED_LINE_SUPPORT_UNCERTAINTY });

function assessFinding(finding: ValidatorFinding, sources: ProjectContextSources): FindingAssessment {
  const rule = validatorRuleExplanation(finding.ruleId);
  const need = finding.ruleId ? SOURCE_NEED_BY_RULE[finding.ruleId] : undefined;
  const linkedOpenDecisionId = finding.linkedDecisionId && (sources.decisions ?? [])
    .some((decision) => decision.id === finding.linkedDecisionId && ['open', 'in_review'].includes(decision.status))
    ? finding.linkedDecisionId : null;
  const identity = {
    findingId: finding.id, ruleId: finding.ruleId ?? null, title: rule?.title ?? finding.description,
    severity: finding.severity, blocksProject: finding.blocksProject, linkedOpenDecisionId,
  };
  if (need) return { ...identity, neededSource: need.label, ...assessSourceGap(finding, need, sources) };
  return {
    ...identity, neededSource: null, state: 'not_a_source_gap', candidates: [], governingContract: null,
    nextSteps: nonGapNextSteps(finding),
    evidenceRecordIds: [...new Set([finding.id, ...(finding.evidenceDocumentIds ?? []), ...(finding.documentId ? [finding.documentId] : [])])],
    supportingFactCount: 0,
    uncertainties: !rule ? ['EightForge has no explanation on file for this check.']
      : finding.ruleId && UNCERTAINTY_BY_RULE[finding.ruleId] ? [UNCERTAINTY_BY_RULE[finding.ruleId]!] : [],
    confidence: rule ? 'medium' : 'low',
  };
}

export function assessProjectEvidence(params: Readonly<{
  intent: OperatorIntent;
  focusFindingId: string | null;
  sources: ProjectContextSources;
}>): ProjectEvidenceAssessment {
  const { intent, focusFindingId, sources } = params;
  const open = sources.findings?.open;
  if (!open) {
    return { intent, projectState: 'evidence_unavailable', primary: null, others: [], openFindingCount: 0, sourceGapCount: 0 };
  }
  const ordered = orderFindings(open, focusFindingId);
  const assessed = ordered.map((finding) => assessFinding(finding, sources));
  const sourceGapCount = assessed.filter((entry) => entry.neededSource != null).length;
  // Questions about documents lead with a source gap; otherwise severity already decided.
  const leadsWithGap = (intent === 'whats_missing' || intent === 'need_document') && focusFindingId == null;
  const primary = (leadsWithGap ? assessed.find((entry) => entry.neededSource != null) : undefined) ?? assessed[0] ?? null;
  if (!primary) {
    // "Nothing open" only means something once validation has actually looked.
    const validated = sources.findings?.latestRunAt != null && sources.project.validationStatus !== 'NOT_READY'
      && sources.project.validationStatus != null;
    return { intent, projectState: validated ? 'no_open_findings' : 'validation_not_run', primary: null, others: [], openFindingCount: 0, sourceGapCount: 0 };
  }
  return {
    intent, projectState: 'findings_open', primary,
    others: assessed.filter((entry) => entry !== primary),
    openFindingCount: open.length, sourceGapCount,
  };
}
