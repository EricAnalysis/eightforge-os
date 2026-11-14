import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { EvidenceState, NextStepKind } from '@/lib/projectIntelligence/evidenceAssessment';

/**
 * Expected outcomes, frozen before any provider call. Each comes from the case's
 * fixture truth and the Validator rule that fired, stated in `derivation`. None came
 * from a model. The grader reads this module; nothing that builds a request may
 * import it (held by the qualification test).
 *
 * `allowedNextSteps` is what a correct answer may recommend for this case, and it can
 * be narrower than what the evidence reading offers. `requiredEvidenceRefs` is a set
 * of which an accepted answer must cite at least one: `finding:<rule>`, `finding:primary`
 * (the finding the reading leads with), `doc:<key>`, or `project`.
 */

export type EvidenceClassification = EvidenceState | 'no_open_findings';

export type GuidanceCaseLabel = Readonly<{
  caseId: string;
  expectedEvidenceClassification: EvidenceClassification;
  /** The finding the answer must be about; several when any one is correct. Empty when none are open. */
  expectedPrimaryRules: readonly string[];
  allowedNextSteps: readonly NextStepKind[];
  forbiddenNextSteps: readonly NextStepKind[];
  requiredEvidenceRefs: readonly string[];
  uncertaintyMustBeSurfaced: boolean;
  deterministicFallbackSufficient: boolean;
  /**
   * The source this requirement needs is in the project, so telling the operator to obtain
   * it is wrong. It speaks to this requirement only: another document being on file does
   * not make something else present, and a source being on file does not make it read,
   * linked, authoritative or sufficient.
   */
  sourceAlreadyPresent: boolean;
  /** Sources this project genuinely lacks, for another finding. Advice about them is not advice to obtain this one again. */
  absentSources?: readonly string[];
  /** Whether what is on file suffices is unsettled, so "if it does not hold it, request it" is correct, and an outright request is not. */
  obtainOnlyIfInsufficient?: boolean;
  derivation: string;
  /** The owner's decision, where deterministic truth alone left a real question. */
  ownerAdjudication?: string;
}>;

const SCHEDULE_RULE = 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED';
const CONFLICT_RULE = 'TRANSACTION_TICKET_GRAIN_CONFLICT';

const NOT_UPLOAD_OR_CLEAR: readonly NextStepKind[] = ['upload_or_request_document', 'no_action_needed'];
const NOT_LINK_OR_CLEAR: readonly NextStepKind[] = ['link_existing_document', 'no_action_needed'];

function missingSchedule(caseId: string): GuidanceCaseLabel {
  return {
    caseId, expectedEvidenceClassification: 'source_missing', expectedPrimaryRules: [SCHEDULE_RULE],
    allowedNextSteps: ['upload_or_request_document', 'review_existing_document'], forbiddenNextSteps: NOT_LINK_OR_CLEAR,
    requiredEvidenceRefs: [`finding:${SCHEDULE_RULE}`, 'doc:contract'], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: false,
    derivation: 'The project holds only the contract and the rate-based rule fired. No schedule exists, though the contract could still hold its pages, which is why reviewing it is also correct.',
  };
}

function unlinkedSchedule(caseId: string): GuidanceCaseLabel {
  return {
    caseId, expectedEvidenceClassification: 'source_present_relationship_unresolved', expectedPrimaryRules: [SCHEDULE_RULE],
    allowedNextSteps: ['link_existing_document', 'review_existing_document', 'operator_judgment_required'], forbiddenNextSteps: NOT_UPLOAD_OR_CLEAR,
    requiredEvidenceRefs: ['doc:sheet', `finding:${SCHEDULE_RULE}`], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true,
    derivation: 'A read price sheet is in the project with no link to the contract, and the rate-based rule fired. The source exists; its relationship is what is open.',
  };
}

function linkedStillFlagged(caseId: string): GuidanceCaseLabel {
  return {
    caseId, expectedEvidenceClassification: 'likely_system_issue', expectedPrimaryRules: [SCHEDULE_RULE],
    allowedNextSteps: ['likely_system_issue', 'review_existing_document', 'operator_judgment_required'], forbiddenNextSteps: NOT_UPLOAD_OR_CLEAR,
    requiredEvidenceRefs: ['doc:sheet', `finding:${SCHEDULE_RULE}`], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true,
    derivation: 'The price sheet is read and attached to the contract, and validation ran after it was read, yet the rule still fired because no rate facts reached validation. Nothing is missing from the project.',
  };
}

function cleared(caseId: string): GuidanceCaseLabel {
  return {
    caseId, expectedEvidenceClassification: 'no_open_findings', expectedPrimaryRules: [],
    allowedNextSteps: ['no_action_needed'], forbiddenNextSteps: ['upload_or_request_document', 'link_existing_document', 'correct_source_data'],
    requiredEvidenceRefs: ['project', 'doc:contract'], uncertaintyMustBeSurfaced: false,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: false,
    derivation: 'Validation ran on a ceiling contract with its amount on file and raised nothing.',
  };
}

function ticketConflict(caseId: string): GuidanceCaseLabel {
  return {
    caseId, expectedEvidenceClassification: 'not_a_source_gap', expectedPrimaryRules: [CONFLICT_RULE],
    allowedNextSteps: ['operator_judgment_required', 'review_existing_document'],
    forbiddenNextSteps: ['upload_or_request_document', 'link_existing_document', 'no_action_needed'],
    requiredEvidenceRefs: [`finding:${CONFLICT_RULE}`], uncertaintyMustBeSurfaced: false,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: false,
    derivation: 'Repeated rows of one physical ticket carry conflicting quantities. EightForge will not choose between them, so a person must.',
  };
}

function ticketGrain(caseId: string, rule: string): GuidanceCaseLabel {
  return {
    caseId, expectedEvidenceClassification: 'not_a_source_gap', expectedPrimaryRules: [rule],
    allowedNextSteps: ['review_ticket_or_transaction', 'review_existing_document', 'operator_judgment_required'],
    forbiddenNextSteps: ['upload_or_request_document', 'link_existing_document', 'no_action_needed'],
    requiredEvidenceRefs: [`finding:${rule}`], uncertaintyMustBeSurfaced: false,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: false,
    derivation: 'The invoice line and its ticket rows disagree. All the sources are in the project, so the rows are what to check.',
  };
}

const LABELS: readonly GuidanceCaseLabel[] = Object.freeze([
  missingSchedule('missing-01'),
  unlinkedSchedule('missing-02'),
  {
    caseId: 'missing-03', expectedEvidenceClassification: 'source_missing',
    expectedPrimaryRules: ['SOURCES_NO_INVOICE_DATA', 'SOURCES_NO_TICKET_DATA'],
    allowedNextSteps: ['upload_or_request_document'], forbiddenNextSteps: NOT_LINK_OR_CLEAR,
    requiredEvidenceRefs: ['finding:SOURCES_NO_INVOICE_DATA', 'finding:SOURCES_NO_TICKET_DATA'], uncertaintyMustBeSurfaced: false,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: false,
    derivation: 'A billing-review project holding only its contract. Both the invoice and ticket rules fired and neither source exists; either is a correct lead.',
  },
  cleared('missing-04'),
  ticketConflict('missing-05'),
  linkedStillFlagged('missing-06'),

  unlinkedSchedule('document-01'),
  missingSchedule('document-02'),
  {
    caseId: 'document-03', expectedEvidenceClassification: 'source_present', expectedPrimaryRules: [SCHEDULE_RULE],
    allowedNextSteps: ['review_existing_document', 'operator_judgment_required'], forbiddenNextSteps: NOT_UPLOAD_OR_CLEAR,
    requiredEvidenceRefs: ['doc:sheet', `finding:${SCHEDULE_RULE}`], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true,
    derivation: 'The attached price sheet was read after the latest validation, so the finding predates it. No further document is needed.',
  },
  {
    caseId: 'document-04', expectedEvidenceClassification: 'source_present', expectedPrimaryRules: ['SOURCES_NO_INVOICE_DATA'],
    allowedNextSteps: ['review_existing_document', 'operator_judgment_required'], forbiddenNextSteps: NOT_UPLOAD_OR_CLEAR,
    requiredEvidenceRefs: ['doc:invoice', 'finding:SOURCES_NO_INVOICE_DATA'], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true,
    derivation: 'The missing-invoice finding came from a run before the invoice arrived. The invoice is now in the project and read.',
  },
  {
    caseId: 'document-05', expectedEvidenceClassification: 'source_present_unread', expectedPrimaryRules: [SCHEDULE_RULE],
    allowedNextSteps: ['review_existing_document', 'likely_system_issue'], forbiddenNextSteps: NOT_UPLOAD_OR_CLEAR,
    requiredEvidenceRefs: ['doc:sheet', `finding:${SCHEDULE_RULE}`], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true,
    derivation: 'The price sheet is in the project but its processing failed, so it was never read. It needs reprocessing or review, not a second copy.',
  },
  cleared('document-06'),

  ticketConflict('flagged-01'),
  ticketGrain('flagged-02', 'TRANSACTION_QUANTITY_MATCHES_INVOICE'),
  {
    caseId: 'flagged-03', expectedEvidenceClassification: 'likely_system_issue', expectedPrimaryRules: ['FINANCIAL_RATE_BASED_ROWS_REQUIRED'],
    allowedNextSteps: ['likely_system_issue', 'review_existing_document', 'operator_judgment_required'], forbiddenNextSteps: NOT_UPLOAD_OR_CLEAR,
    requiredEvidenceRefs: ['doc:contract', 'finding:FINANCIAL_RATE_BASED_ROWS_REQUIRED'], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true,
    derivation: 'The contract states a rate schedule is present, the rule itself says so, and no rows were read from it. The source is in hand; reading it is what fell short.',
  },
  {
    caseId: 'flagged-04', expectedEvidenceClassification: 'source_present_relationship_unresolved', expectedPrimaryRules: [SCHEDULE_RULE],
    allowedNextSteps: ['link_existing_document', 'review_existing_document', 'operator_judgment_required'], forbiddenNextSteps: NOT_UPLOAD_OR_CLEAR,
    requiredEvidenceRefs: ['doc:sheet', `finding:${SCHEDULE_RULE}`], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true,
    derivation: 'The price sheet is attached but marked reference only. Whether it applies is an unsettled authority question for a person.',
  },
  {
    caseId: 'flagged-05', expectedEvidenceClassification: 'source_missing', expectedPrimaryRules: ['SOURCES_NO_CONTRACT'],
    allowedNextSteps: ['upload_or_request_document'], forbiddenNextSteps: NOT_LINK_OR_CLEAR,
    requiredEvidenceRefs: ['finding:SOURCES_NO_CONTRACT'], uncertaintyMustBeSurfaced: false,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: false,
    derivation: 'The project holds no documents and the rule fired on that.',
  },
  {
    caseId: 'flagged-06', expectedEvidenceClassification: 'not_a_source_gap', expectedPrimaryRules: ['FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR'],
    allowedNextSteps: ['review_existing_document', 'operator_judgment_required'],
    forbiddenNextSteps: ['upload_or_request_document', 'link_existing_document', 'no_action_needed'],
    requiredEvidenceRefs: ['finding:FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR'], uncertaintyMustBeSurfaced: false,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: false,
    derivation: 'The contract\'s schedule is fully read. What is open is whether it applies to the billed work, which the contract must answer and a person must confirm.',
  },

  missingSchedule('action-01'),
  unlinkedSchedule('action-02'),
  linkedStillFlagged('action-03'),
  ticketConflict('action-04'),
  ticketGrain('action-05', 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE'),
  cleared('action-06'),
]);

/** v1 and v2's labels, unchanged, for regression evidence only. */
export const V2_REGRESSION_LABELS: readonly GuidanceCaseLabel[] = LABELS;
export const V2_REGRESSION_LABEL_SET_VERSION = 'operator_guidance_labels_v1';
export const v2RegressionLabelSetDigest = (): string => hashCanonical({ version: V2_REGRESSION_LABEL_SET_VERSION, labels: LABELS });

function absentTickets(caseId: string): GuidanceCaseLabel {
  return {
    caseId, expectedEvidenceClassification: 'source_missing', expectedPrimaryRules: ['SOURCES_NO_TICKET_DATA'],
    allowedNextSteps: ['upload_or_request_document'], forbiddenNextSteps: NOT_LINK_OR_CLEAR,
    requiredEvidenceRefs: ['finding:SOURCES_NO_TICKET_DATA'], uncertaintyMustBeSurfaced: false,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: false,
    derivation: 'A billing-review project holding a contract and an invoice, with no ticket data, and the ticket rule fired. That source does not exist in the project.',
  };
}

function unverifiedRateRow(caseId: string, derivation: string): GuidanceCaseLabel {
  const rule = 'FINANCIAL_AUTHORED_RATE_ROW_UNVERIFIED';
  return {
    caseId, expectedEvidenceClassification: 'not_a_source_gap', expectedPrimaryRules: [rule],
    allowedNextSteps: ['correct_source_data', 'review_existing_document', 'operator_judgment_required'],
    forbiddenNextSteps: ['upload_or_request_document', 'link_existing_document', 'no_action_needed'],
    // Several rows can fire this rule, and the reading leads with one of them.
    requiredEvidenceRefs: ['finding:primary', `finding:${rule}`, 'doc:fixture-contract'], uncertaintyMustBeSurfaced: false,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true, derivation,
  };
}

/** A source that is in the project but could not be read. */
function unreadSource(caseId: string, rule: string, doc: string, derivation: string): GuidanceCaseLabel {
  return {
    caseId, expectedEvidenceClassification: 'source_present_unread', expectedPrimaryRules: [rule],
    allowedNextSteps: ['review_existing_document', 'likely_system_issue'], forbiddenNextSteps: NOT_UPLOAD_OR_CLEAR,
    requiredEvidenceRefs: [doc, `finding:${rule}`], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true, derivation,
  };
}

/**
 * Labels for what v3 qualifies on, from fixture truth and the rule that fired, like the
 * 24 before them. Their author had read v2's answers, so they need independent
 * verification before a freeze of them can be final.
 */
export const HELDOUT_LABELS: readonly GuidanceCaseLabel[] = Object.freeze([
  absentTickets('heldout-missing-01'),
  {
    caseId: 'heldout-missing-02', expectedEvidenceClassification: 'not_a_source_gap', expectedPrimaryRules: ['TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE'],
    allowedNextSteps: ['review_ticket_or_transaction', 'review_existing_document', 'operator_judgment_required'],
    forbiddenNextSteps: ['upload_or_request_document', 'link_existing_document', 'no_action_needed'],
    requiredEvidenceRefs: ['finding:TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE'], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true, obtainOnlyIfInsufficient: true,
    derivation: 'A ticket export and a transaction row are on file, but the row sits under another billing code, so the billed line has no group. The source family is not absent, the grouping is unresolved, and whether more support is needed is not established.',
    ownerAdjudication: 'Owner, 2026-11-03: review the existing ticket and transaction evidence and its grouping. Keep whether more support is needed uncertain. Do not call the source family absent, request a duplicate upload or assume the grouping is correct. If the evidence stays insufficient, ask for human review.',
  },
  { ...cleared('heldout-missing-03'), derivation: 'Validation ran on a ceiling contract with its $480,000 amount on file and raised nothing.' },
  { ...missingSchedule('heldout-missing-04'), derivation: 'The project holds only the agreement and the rate-based rule fired. No schedule exists, though the agreement could still hold its pages, which is why reviewing it is also correct.' },
  {
    caseId: 'heldout-missing-05', expectedEvidenceClassification: 'source_missing', expectedPrimaryRules: ['SOURCES_NO_CONTRACT'],
    allowedNextSteps: ['upload_or_request_document'], forbiddenNextSteps: NOT_LINK_OR_CLEAR,
    requiredEvidenceRefs: ['finding:SOURCES_NO_CONTRACT'], uncertaintyMustBeSurfaced: false,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: false,
    derivation: 'The project holds no documents and the contract rule fired on that.',
  },
  {
    caseId: 'heldout-missing-06', expectedEvidenceClassification: 'source_missing',
    expectedPrimaryRules: ['SOURCES_NO_INVOICE_DATA', 'SOURCES_NO_TICKET_DATA'],
    allowedNextSteps: ['upload_or_request_document'], forbiddenNextSteps: NOT_LINK_OR_CLEAR,
    requiredEvidenceRefs: ['finding:SOURCES_NO_INVOICE_DATA', 'finding:SOURCES_NO_TICKET_DATA'], uncertaintyMustBeSurfaced: false,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: false,
    derivation: 'A billing-review project holding only its contract. Two findings are open: both the invoice and ticket rules fired and neither source exists, so either is a correct lead.',
  },

  unreadSource('heldout-document-01', SCHEDULE_RULE, 'doc:sheet', 'The rate exhibit is in the project but its processing failed, so it was never read. It needs reprocessing or review, not a second copy.'),
  unreadSource('heldout-document-02', 'SOURCES_NO_TICKET_DATA', 'doc:tickets', 'A ticket export is in the project but its processing failed, so validation has no ticket rows. It needs reprocessing or review, not a second copy.'),
  {
    caseId: 'heldout-document-03', expectedEvidenceClassification: 'source_present', expectedPrimaryRules: [SCHEDULE_RULE],
    allowedNextSteps: ['review_existing_document', 'operator_judgment_required'], forbiddenNextSteps: NOT_UPLOAD_OR_CLEAR,
    requiredEvidenceRefs: ['doc:sheet', `finding:${SCHEDULE_RULE}`], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true,
    derivation: 'The attached rate exhibit was read after the latest validation, so the finding predates it. No further document is needed.',
  },
  {
    caseId: 'heldout-document-04', expectedEvidenceClassification: 'source_missing', expectedPrimaryRules: [SCHEDULE_RULE],
    allowedNextSteps: ['review_existing_document', 'operator_judgment_required'], forbiddenNextSteps: ['upload_or_request_document', 'link_existing_document', 'no_action_needed'],
    requiredEvidenceRefs: ['doc:sheet', `finding:${SCHEDULE_RULE}`], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true, obtainOnlyIfInsufficient: true,
    derivation: 'A read document titled Rate Information is on file, but nothing classifies it, so no document is established as the schedule. Inspecting it comes first, and only if the pricing is genuinely absent is the source requested.',
    ownerAdjudication: 'Owner, 2026-11-03: inspect the existing document first, and let the operator verify its contents and classification through existing governed workflows. If the pricing is there, proceed through extraction, relationship and validation. If it is genuinely absent, request the source. Do not infer authority from a title. Keep the uncertainty until evidence settles it.',
  },
  { ...cleared('heldout-document-05'), derivation: 'Validation ran on a ceiling contract with its $125,000 amount on file and raised nothing.' },
  unreadSource('heldout-document-06', 'SOURCES_NO_CONTRACT', 'doc:contract', 'The missing-contract finding came from a run before the agreement arrived. The agreement is now in the project and still processing, so it needs reading, not requesting again.'),

  {
    caseId: 'heldout-flagged-01', expectedEvidenceClassification: 'source_present_relationship_unresolved', expectedPrimaryRules: [SCHEDULE_RULE],
    allowedNextSteps: ['link_existing_document', 'review_existing_document', 'operator_judgment_required'], forbiddenNextSteps: NOT_UPLOAD_OR_CLEAR,
    requiredEvidenceRefs: ['doc:sheet', `finding:${SCHEDULE_RULE}`], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true,
    derivation: 'The rate exhibit is attached but marked reference only. Being attached does not make it authoritative: whether it applies is an unsettled question for a person.',
  },
  { ...ticketConflict('heldout-flagged-02'), sourceAlreadyPresent: true, derivation: 'Two rows of one physical ticket on file carry conflicting quantities. EightForge will not choose between them, so a person compares them. The ticket source is already in the project.' },
  unverifiedRateRow('heldout-flagged-03', 'The project is blocked first by contract rate rows recovered without source verification. The contract is held, so the rows are what to check and correct.'),
  { ...linkedStillFlagged('heldout-flagged-04'), derivation: 'The rate exhibit is read and attached to the agreement, and validation ran after it was read, yet the rule still fired because no rate facts reached validation. Nothing is missing from the project.' },
  {
    caseId: 'heldout-flagged-05', expectedEvidenceClassification: 'not_a_source_gap', expectedPrimaryRules: ['FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR'],
    allowedNextSteps: ['review_existing_document', 'operator_judgment_required'],
    forbiddenNextSteps: ['upload_or_request_document', 'link_existing_document', 'no_action_needed'],
    requiredEvidenceRefs: ['finding:FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR'], uncertaintyMustBeSurfaced: false,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true,
    derivation: 'The agreement\'s schedule is fully read. What is open is whether it applies to the billed work, which the agreement must answer and a person must confirm. No further document is called for.',
  },
  { ...ticketGrain('heldout-flagged-06', 'TRANSACTION_QUANTITY_MATCHES_INVOICE'), sourceAlreadyPresent: true, derivation: 'The billed line says 300 and the ticket on file says 260. Both sources are in the project, so the rows are what to check.' },

  { ...unlinkedSchedule('heldout-action-01'), derivation: 'A read rate exhibit is in the project with no link to the agreement, and the rate-based rule fired. The source exists; its relationship is what is open.' },
  {
    caseId: 'heldout-action-02', expectedEvidenceClassification: 'likely_system_issue', expectedPrimaryRules: ['FINANCIAL_RATE_BASED_ROWS_REQUIRED'],
    allowedNextSteps: ['likely_system_issue', 'review_existing_document', 'operator_judgment_required'], forbiddenNextSteps: NOT_UPLOAD_OR_CLEAR,
    requiredEvidenceRefs: ['doc:contract', 'finding:FINANCIAL_RATE_BASED_ROWS_REQUIRED'], uncertaintyMustBeSurfaced: true,
    deterministicFallbackSufficient: true, sourceAlreadyPresent: true,
    derivation: 'The agreement states a rate schedule is present, the rule itself says so, and no rows were read from it. The source is in hand; reading it is what fell short.',
  },
  unverifiedRateRow('heldout-action-03', 'A recovered contract rate row has no source verification. The contract is held, so checking the row against it comes first.'),
  { ...ticketGrain('heldout-action-04', 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE'), sourceAlreadyPresent: true, derivation: 'The billed line totals 4,275 and the ticket on file totals 3,990. Both sources are in the project, so the rows are what to check.' },
  { ...cleared('heldout-action-05'), derivation: 'Validation ran on a ceiling contract with its $310,000 amount and an amendment on file and raised nothing, so nothing is required.' },
  { ...unreadSource('heldout-action-06', 'SOURCES_NO_INVOICE_DATA', 'doc:invoice', 'The missing-invoice finding came from a run before the pay application arrived. It is now in the project but its processing failed, so it needs reprocessing or review. Ticket data is separately absent, and saying so is correct.'),
    absentSources: ['ticket', 'transaction'] },
]);

export const GUIDANCE_LABEL_SET_VERSION = 'operator_guidance_heldout_labels_v2';
export const guidanceLabelSetDigest = (): string => hashCanonical({ version: GUIDANCE_LABEL_SET_VERSION, labels: HELDOUT_LABELS });
