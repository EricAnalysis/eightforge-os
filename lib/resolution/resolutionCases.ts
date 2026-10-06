import type {
  DiagnosticAttention,
  DiagnosticCode,
  DiagnosticRecoverability,
  DiagnosticRecoveryType,
} from '@/lib/diagnostics/failureDiagnostic';
import {
  CONTRACT_RATE_ROW_FACT_KEY,
  PRICED_EVIDENCE_DISPOSITION_FACT_KEY,
  formatReviewedValue,
  openRegionAssertionEntryTargets,
  type EffectiveRegionAssertion,
  type HeldRegionAssertion,
  type HumanFactAssertionRow,
  type RegionAssertionEntryTarget,
  type ReviewedRateRowValue,
  type ReviewRequiredValueTarget,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import type { ValueReadingOutcomeCode, ValueReadingOutcomeReason } from '@/lib/server/valueReadingProposals';
import { getIssueDisplayLabel } from '@/lib/issueDisplayFormatter';
import { isIssueRequiringReview, type IssueObject } from '@/lib/issueObjects';
import { pageFrameVisual, type DocumentPageFrames } from '@/lib/recovery/diagnosticVisualEvidence';
import type { VisualSourceEvidence } from '@/lib/recovery/visualSourceEvidence';
import { isApprovalBlocker } from '@/lib/validator/findingSemantics';
import { isHumanReviewedEvidenceNote } from '@/lib/validator/humanReviewedEvidence';
import type { ValidationEvidence } from '@/types/validator';

/**
 * ResolutionCase: the operator's unit of work (Forgewing resolution layer B5-A).
 *
 * A derived read model, never a store. Every case is computed on the server
 * from records that already exist:
 * - open Validator findings, through the same IssueObjects the Validator tab
 *   renders;
 * - priced lines extraction could not read (B2) that have no effective
 *   human-reviewed value;
 * - human-reviewed values held for re-review (B3);
 * - pending recovery proposals (a Forgewing suggestion source; included only
 *   when the caller says Forgewing is enabled for the organization);
 * - evidence EightForge knows it could not read, refused to publish, or could
 *   not interpret: every document diagnostic whose registry attention is
 *   `resolution_case`, whatever its recoverability. Recoverability says
 *   whether a recovery mechanism exists; it never decides visibility.
 *
 * The client can only act on what is listed here. Every action is typed and
 * names an existing write path. This model performs no write, and it never
 * invents an anchor, a value or an authority.
 *
 * Ordering is deterministic. Cases are ranked by impact tier first (what
 * blocks approval, what is missing an authoritative value, ...), then by
 * dollars at stake, then by a stable id. Cases sharing a source-bound root
 * cause are grouped, so the operator resolves the cause once.
 */

export const RESOLUTION_CASE_MODEL_VERSION = 'resolution_case_v1' as const;

export type ResolutionImpactTier =
  | 'blocks_approval'
  | 'missing_authoritative_value'
  | 'missing_document_or_link'
  | 'affects_pricing'
  | 'structural'
  | 'informational';

export const RESOLUTION_TIER_ORDER: readonly ResolutionImpactTier[] = [
  'blocks_approval',
  'missing_authoritative_value',
  'missing_document_or_link',
  'affects_pricing',
  'structural',
  'informational',
];

export type ResolutionCaseKind =
  | 'validator_finding'
  | 'unreadable_priced_line'
  | 'reviewed_value_needs_rereview'
  | 'recovery_proposal_pending'
  /** A priced line on a page extraction read, found and refused publication (rejected, withheld, or unpriced). */
  | 'withheld_priced_line'
  /** Table structure was read but could not be interpreted (header roles unrecognized, page reconstruction failed). */
  | 'structure_review'
  /** A published value extraction knows must be reviewed before it can be pricing authority. */
  | 'review_required_value'
  /** EightForge could not read a page sufficiently (OCR failed, abstained, skipped, coverage incomplete). */
  | 'coverage_gap'
  /** Page pricing was withheld because its authority could not be verified. */
  | 'pricing_withheld';

/**
 * Which evidence this is for the decision: what the source shows now, what an
 * earlier review rested on, or what the Validator cited in support.
 */
export type ResolutionEvidenceRole = 'current' | 'previous' | 'supporting';

/** Where the evidence is. Source-bound only: document, page, observations, region. */
export type ResolutionEvidenceRef = Readonly<{
  documentId: string | null;
  physicalPageNumber: number | null;
  observationIds: readonly string[];
  region: RegionAssertionEntryTarget['sourceRegion'] | null;
  label: string;
  role: ResolutionEvidenceRole;
  /**
   * The source page with this evidence drawn on it, built on the server from
   * the current extraction. Null when the page cannot be shown (no source
   * artifact, or the page is not a current verified page). Previous evidence
   * is never drawn on the current page.
   */
  visual: VisualSourceEvidence | null;
  /** The Validator's persisted evidence values, verbatim; null for other sources. */
  detail: Readonly<{
    evidenceType: string;
    fieldName: string | null;
    value: string | null;
    note: string | null;
    /** True when the cited value is a human-reviewed value (B3.1 marker). */
    humanReviewed: boolean;
  }> | null;
}>;

/** The review a re-review case is about, verbatim from the append-only ledger. */
export type PreviousReview = Readonly<{
  assertionId: string;
  status: HumanFactAssertionRow['status'];
  value: unknown;
  /** The value as every human-reviewed label shows it; null for a withdrawal. */
  valueText: string | null;
  reason: string;
  assertedAt: string;
  actorId: string;
  physicalPageNumber: number | null;
  pageRepresentationDigest: string | null;
  observationIds: readonly string[];
  region: unknown;
  /** What extraction read when the review was made. */
  originalSourceText: string | null;
}>;

/** A confirmation the reviewer may choose for a recovery proposal, by its exact server id. */
export type RecoveryConfirmationOption = Readonly<{
  /** The request field the review route takes for this proposal version. */
  field: 'confirmedObservationId' | 'confirmedCandidateId';
  id: string;
  rawText: string;
  /** True for the option the proposal selected. A suggestion, not a default. */
  proposed: boolean;
  visual: VisualSourceEvidence | null;
}>;

/**
 * A typed suggestion. Its source says who suggested it. A suggestion is never
 * authority: only the operator's action through a listed write path is.
 */
export type ResolutionSuggestion = Readonly<{
  source: 'forgewing_recovery_proposal';
  /** The proposal's own value, verbatim. Shown beside the decision, never pre-filled as truth. */
  proposedValue: string;
  /** Model self-report. Uncalibrated; renderers must not present it as accuracy. */
  uncalibratedCertainty: number | null;
  proposalId: string;
}> | Readonly<{
  source: 'forgewing_value_reading';
  proposedValue: string;
  rateRow: ReviewedRateRowValue;
  uncalibratedCertainty: null;
  proposalId: string;
}>;

/** Every action names the existing write path it uses. */
export type ResolutionAction =
  | Readonly<{
      kind: 'enter_reviewed_value';
      method: 'POST';
      endpoint: string;
      factKey: 'contract_rate_row';
      target: RegionAssertionEntryTarget;
      /** The current chain head to supersede, or null for a first review. */
      supersedesAssertionId: string | null;
      /** Offered provenance only; the operator must explicitly use the suggestion. */
      forgewingProposalId?: string;
    }>
  | Readonly<{
      /**
       * The operator decides this evidence is not a rate or value at all. It
       * closes the case and nothing else: same ledger and chain rule as a
       * reviewed value, under its own fact key, never a fact or a price.
       */
      kind: 'record_disposition';
      method: 'POST';
      endpoint: string;
      factKey: typeof PRICED_EVIDENCE_DISPOSITION_FACT_KEY;
      disposition: 'not_a_rate_or_value';
      target: RegionAssertionEntryTarget;
      supersedesAssertionId: string | null;
    }>
  | Readonly<{
      kind: 'request_value_reading';
      method: 'POST';
      endpoint: string;
    }>
  | Readonly<{
      kind: 'review_value_reading';
      method: 'POST';
      endpoint: string;
      proposalId: string;
      proposalDigestSha256: string;
      dispositions: readonly ('rejected' | 'deferred')[];
    }>
  | Readonly<{
      kind: 'withdraw_reviewed_value';
      method: 'POST';
      endpoint: string;
      anchorKey: string;
      supersedesAssertionId: string;
      /** The current target the withdrawal binds; offered only when one exists. */
      target: RegionAssertionEntryTarget;
    }>
  | Readonly<{
      kind: 'review_recovery_proposal';
      method: 'POST';
      endpoint: '/api/internal/forgewing-recovery-review';
      proposalId: string;
      proposalDigestSha256: string;
      proposalVersion: 1 | 2;
      dispositions: readonly ('accepted' | 'modified' | 'rejected' | 'deferred')[];
      /** Server-derived options for accepted/modified; the client never names another id. */
      selectableConfirmations: readonly RecoveryConfirmationOption[];
      /** The persisted candidates no longer close over their source identity: draw nothing. */
      sourceEvidenceUnbound: boolean;
    }>
  | Readonly<{
      kind: 'link_invoice_line_rate';
      method: 'POST';
      endpoint: string;
      findingId: string;
      /** The finding's own subject: the invoice line the link is for. */
      invoiceLineSubjectId: string;
    }>
  | Readonly<{
      kind: 'resolve_execution_item';
      /** The execution outcome route accepts PATCH only. */
      method: 'PATCH';
      endpoint: string;
      outcomes: readonly ('approve' | 'correct' | 'override')[];
    }>
  | Readonly<{
      kind: 'open_in_validator';
      href: string;
    }>
  | Readonly<{
      kind: 'open_document';
      href: string;
    }>;

export type ResolutionCase = Readonly<{
  caseId: string;
  kind: ResolutionCaseKind;
  tier: ResolutionImpactTier;
  /** Dollars at stake when the source states them; never estimated. */
  exposureAmount: number | null;
  projectId: string;
  documentId: string | null;
  physicalPageNumber: number | null;
  /** Operator-readable title. Never a raw rule id. */
  title: string;
  problem: string;
  /** The Validator finding this case is, verbatim; null for other kinds. */
  finding: Readonly<{
    /** The Validator's persisted identity for the finding. */
    checkKey: string;
    ruleId: string;
    severity: string;
    field: string | null;
    expected: string | null;
    actual: string | null;
    recommendedAction: string;
  }> | null;
  /** The review a re-review case concerns; empty for other kinds. */
  previousReviews: readonly PreviousReview[];
  /** What EightForge knows deterministically. */
  deterministicState: string;
  /** What extraction read at the source, when there is one. Never rewritten. */
  originalSourceText: string | null;
  /** Source-bound root cause. Cases sharing it are resolved together. */
  rootCauseKey: string;
  evidence: readonly ResolutionEvidenceRef[];
  suggestions: readonly ResolutionSuggestion[];
  /** Durable explanation only; never a value or authority. */
  valueReadingOutcome?: Readonly<{ code: ValueReadingOutcomeCode; reason: ValueReadingOutcomeReason }> | null;
  actions: readonly ResolutionAction[];
  /** The diagnostic a case was derived from, verbatim from the registry; absent for other sources. */
  diagnostic?: Readonly<{
    code: DiagnosticCode;
    attention: DiagnosticAttention;
    recoverability: DiagnosticRecoverability;
    recoveryType: DiagnosticRecoveryType | null;
  }>;
  /** Ids of the records this case was derived from. */
  sourceRefs: Readonly<{
    findingId?: string;
    assertionIds?: readonly string[];
    proposalId?: string;
    anchorKey?: string;
    diagnosticId?: string;
  }>;
}>;

export type ResolutionCaseGroup = Readonly<{
  rootCauseKey: string;
  tier: ResolutionImpactTier;
  title: string;
  caseIds: readonly string[];
  /** Validator findings in the group. */
  findingCount: number;
  exposureAmount: number | null;
}>;

export type ResolutionQueue = Readonly<{
  modelVersion: typeof RESOLUTION_CASE_MODEL_VERSION;
  projectId: string;
  cases: readonly ResolutionCase[];
  groups: readonly ResolutionCaseGroup[];
  countsByTier: Readonly<Record<ResolutionImpactTier, number>>;
  forgewingSuggestionsIncluded: boolean;
}>;

/** The B3 per-document review state the server already resolves. */
export type DocumentReviewedValueState = Readonly<{
  history: readonly HumanFactAssertionRow[];
  effective: readonly EffectiveRegionAssertion[];
  held: readonly HeldRegionAssertion[];
  entryTargets: readonly RegionAssertionEntryTarget[];
}>;

/**
 * One document diagnostic as this model reads it: the registry's attention and
 * recoverability travel with it, and its evidence stays source-bound.
 */
export type AttentionDiagnostic = Readonly<{
  diagnosticId: string;
  code: DiagnosticCode;
  attention: DiagnosticAttention;
  recoverability: DiagnosticRecoverability;
  recoveryType: DiagnosticRecoveryType | null;
  severity: 'info' | 'warning' | 'blocking';
  summary: string;
  physicalPageNumber: number | null;
  observationIds: readonly string[];
  visual: VisualSourceEvidence | null;
  recoveryProposalId: string | null;
}>;

/**
 * Per document: its diagnostics, the targets for priced evidence it withheld,
 * and the published rows whose scanned amount awaits a person's review.
 */
export type DocumentEvidenceAttention = Readonly<{
  diagnostics: readonly AttentionDiagnostic[];
  withheldTargets: readonly RegionAssertionEntryTarget[];
  reviewRequiredTargets?: readonly ReviewRequiredValueTarget[];
}>;

/** The subset of a recovery review candidate this model reads. */
export type PendingRecoveryProposal = Readonly<{
  proposalId: string;
  proposalDigestSha256: string;
  recoveryType: string;
  physicalPageNumber: number;
  sourceDocumentId: string;
  recoveryReason: string;
  proposedValue: string;
  certainty: number;
  reviewState: string;
  evidence: readonly Readonly<{ observationId: string; rawText: string }>[];
  proposalVersion: 1 | 2;
  selectableConfirmations: readonly RecoveryConfirmationOption[];
  sourceEvidenceUnbound: boolean;
}>;

export type ResolutionDocument = Readonly<{
  id: string;
  title?: string | null;
  name?: string | null;
}>;

const MANUAL_RATE_LINK_RULE_IDS = new Set(['FINANCIAL_RATE_CODE_MISSING', 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS']);

/** A rule or check key such as `FINANCIAL_RATE_CODE_MISSING` or `FINANCIAL_NTE_FACT_MISSING:project-1`. */
const RAW_RULE_KEY = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?::|$)/;

const HELD_REASON_TEXT: Record<HeldRegionAssertion['reason'], string> = {
  page_representation_changed: 'The page was re-extracted differently since this value was reviewed.',
  page_representation_unverifiable: 'The current page representation cannot be verified.',
  ambiguous_competing_assertions: 'More than one reviewed value competes for this target.',
  source_observations_required: 'The review cites no source observation.',
  invalid_asserted_value: 'The reviewed value is incomplete.',
};

/** Which case a resolution-case diagnostic opens. Every code with case attention has one. */
export const CASE_KIND_BY_DIAGNOSTIC_CODE: Readonly<Partial<Record<DiagnosticCode, ResolutionCaseKind>>> = Object.freeze({
  page_ocr_required: 'coverage_gap',
  page_ocr_abstained: 'coverage_gap',
  page_ocr_failed: 'coverage_gap',
  page_image_decode_failed: 'coverage_gap',
  page_extraction_coverage_incomplete: 'coverage_gap',
  expected_pricing_page_no_usable_evidence: 'coverage_gap',
  page_skipped_due_evidence_limit: 'coverage_gap',
  pricing_page_reconstruction_failed: 'structure_review',
  priced_header_semantics_unresolved: 'structure_review',
  ruling_line_pricing_authority_withheld: 'pricing_withheld',
  ambiguous_rate_clusters: 'withheld_priced_line',
  insufficient_row_structure: 'withheld_priced_line',
  outside_table_body: 'withheld_priced_line',
  ambiguous_row_continuation: 'withheld_priced_line',
  inconsistent_row_pitch: 'withheld_priced_line',
  insufficient_priced_rows: 'withheld_priced_line',
  ambiguous_recovery_confirmation: 'withheld_priced_line',
  recovery_closure_failed: 'withheld_priced_line',
  unpriced_row: 'withheld_priced_line',
});

const WITHHELD_REASON_TEXT: Partial<Record<DiagnosticCode, string>> = {
  ambiguous_rate_clusters: 'The line carries more than one plausible amount, so no row was published.',
  insufficient_row_structure: 'The line carries a price but not enough row structure to publish.',
  outside_table_body: 'The line carries a price but sits outside the table body the accepted rows establish.',
  ambiguous_row_continuation: 'A neighbouring line could complete this row or the next, so the row was withheld.',
  inconsistent_row_pitch: 'The line carries a price but does not match the table\'s row spacing.',
  insufficient_priced_rows: 'Too few priced rows survived for the table to publish, so this one was withheld.',
  ambiguous_recovery_confirmation: 'More than one confirmation applies to this withheld row.',
  recovery_closure_failed: 'The confirmed evidence did not close over the reconstructed row.',
  unpriced_row: 'This table row carries no readable price, so it is not priced.',
};

const UNRESOLVED_REASON_TEXT: Record<string, string> = {
  multiple_priced_headers: 'The page holds more than one priced table, so it was not read as one.',
  ambiguous_header_candidates: 'More than one line could be the table header; none was chosen.',
  header_not_found: 'Priced lines were found, but no table header.',
  unresolved_later_header: 'A second table starts below the first under a header that could not be read, so neither was read as one table.',
};

function documentLabel(documents: ReadonlyMap<string, ResolutionDocument>, id: string | null): string {
  if (!id) return 'Project';
  const document = documents.get(id);
  return document?.title?.trim() || document?.name?.trim() || 'Document';
}

function documentHref(documentId: string, page: number | null): string {
  return `/platform/documents/${documentId}${page != null ? `?page=${page}` : ''}`;
}

function regionAssertionEndpoint(documentId: string): string {
  return `/api/documents/${documentId}/facts/region-assertions`;
}

function dispositionAction(
  documentId: string,
  target: RegionAssertionEntryTarget,
  history: readonly HumanFactAssertionRow[],
): ResolutionAction {
  return {
    kind: 'record_disposition',
    method: 'POST',
    endpoint: regionAssertionEndpoint(documentId),
    factKey: PRICED_EVIDENCE_DISPOSITION_FACT_KEY,
    disposition: 'not_a_rate_or_value',
    target,
    supersedesAssertionId: chainHead(history, target.anchorKey, PRICED_EVIDENCE_DISPOSITION_FACT_KEY),
  };
}

/**
 * The single head of a chain, or null when there is none or it is ambiguous.
 * One chain per (document, fact key, anchor), exactly as the record function
 * enforces: a disposition on an anchor never heads its reviewed-value chain.
 */
function chainHead(
  history: readonly HumanFactAssertionRow[],
  anchorKey: string,
  factKey: string = CONTRACT_RATE_ROW_FACT_KEY,
): string | null {
  const chain = history.filter((row) => row.anchor_key === anchorKey && row.fact_key === factKey);
  const superseded = new Set(chain.flatMap((row) => (row.supersedes_assertion_id ? [row.supersedes_assertion_id] : [])));
  const heads = chain.filter((row) => !superseded.has(row.id));
  return heads.length === 1 ? heads[0]!.id : null;
}

function currentTargetEvidence(documentId: string, target: RegionAssertionEntryTarget): ResolutionEvidenceRef {
  return {
    documentId,
    physicalPageNumber: target.physicalPageNumber,
    observationIds: target.sourceObservationIds,
    region: target.sourceRegion,
    label: target.rawText,
    role: 'current',
    visual: target.visual,
    detail: null,
  };
}

function previousReviewOf(row: HumanFactAssertionRow): PreviousReview {
  return {
    assertionId: row.id,
    status: row.status,
    value: row.asserted_value,
    valueText: row.status === 'withdrawn' || row.asserted_value == null ? null : formatReviewedValue(row.asserted_value),
    reason: row.reason,
    assertedAt: row.asserted_at,
    actorId: row.actor_id,
    physicalPageNumber: row.physical_page_number ?? null,
    pageRepresentationDigest: row.page_representation_digest ?? null,
    observationIds: row.source_observation_ids ?? [],
    region: row.source_region ?? null,
    originalSourceText: row.original_source_text ?? null,
  };
}

function findingTier(issue: IssueObject): ResolutionImpactTier {
  const finding = issue.finding;
  if (isApprovalBlocker(finding)) return 'blocks_approval';
  if (finding.category === 'required_sources') return 'missing_document_or_link';
  if (finding.severity === 'info') return 'informational';
  if (finding.category === 'financial_integrity') return 'affects_pricing';
  return 'structural';
}

function validatorCases(params: {
  projectId: string;
  issues: readonly IssueObject[];
  evidence: readonly ValidationEvidence[];
  documentPages: ReadonlyMap<string, DocumentPageFrames>;
}): ResolutionCase[] {
  const evidenceByFinding = new Map<string, ValidationEvidence[]>();
  for (const row of params.evidence) {
    evidenceByFinding.set(row.finding_id, [...(evidenceByFinding.get(row.finding_id) ?? []), row]);
  }
  return params.issues.flatMap((issue) => {
    if (issue.finding.status !== 'open' || !isIssueRequiringReview(issue)) return [];
    const finding = issue.finding;
    const actions: ResolutionAction[] = [];
    if (MANUAL_RATE_LINK_RULE_IDS.has(finding.rule_id)) {
      actions.push({
        kind: 'link_invoice_line_rate',
        method: 'POST',
        endpoint: `/api/projects/${params.projectId}/invoice-line-rate-link`,
        findingId: finding.id,
        invoiceLineSubjectId: finding.subject_id,
      });
    }
    if (issue.executionItemId) {
      actions.push({
        kind: 'resolve_execution_item',
        method: 'PATCH',
        endpoint: `/api/execution-items/${issue.executionItemId}/outcome`,
        outcomes: ['approve', 'correct', 'override'],
      });
    }
    actions.push({
      kind: 'open_in_validator',
      href: `/platform/projects/${params.projectId}?activeTab=validator&selectedIssue=${finding.id}#project-validator`,
    });
    const rows = (evidenceByFinding.get(finding.id) ?? [])
      .slice().sort((left, right) => left.id.localeCompare(right.id, 'en-US'));
    const display = getIssueDisplayLabel(issue.issueType, issue.title);
    // The shared label falls back to the finding's check key for rules it has
    // no template for. A raw key is not an operator title: use the finding's
    // own summary, which the Validator already writes in plain language.
    const title = RAW_RULE_KEY.test(display.title) && issue.summary.trim() ? issue.summary.trim() : display.title;
    const evidence: ResolutionEvidenceRef[] = rows.map((row) => {
      const label = row.note ?? row.field_name ?? row.evidence_type;
      return {
        documentId: row.source_document_id,
        physicalPageNumber: row.source_page,
        observationIds: [],
        region: null,
        label,
        role: 'supporting' as const,
        // Validator evidence cites a page, not observations: the page is shown
        // without a highlight rather than with a guessed one.
        visual: row.source_document_id
          ? pageFrameVisual(params.documentPages.get(row.source_document_id), row.source_page, `evidence:${row.id}`, label)
          : null,
        detail: {
          evidenceType: row.evidence_type,
          fieldName: row.field_name,
          value: row.field_value,
          note: row.note,
          humanReviewed: isHumanReviewedEvidenceNote(row.note),
        },
      };
    });
    // Findings that rest on the same contract rate row share a root cause. The
    // row's record id is the source identity the Validator itself cites.
    const rateRow = rows.find((row) => row.evidence_type === 'rate_schedule' && row.record_id);
    return [{
      caseId: `finding:${finding.id}`,
      kind: 'validator_finding' as const,
      tier: findingTier(issue),
      exposureAmount: issue.exposureAmount,
      projectId: params.projectId,
      documentId: evidence.find((entry) => entry.documentId)?.documentId ?? null,
      physicalPageNumber: evidence.find((entry) => entry.physicalPageNumber != null)?.physicalPageNumber ?? null,
      title,
      problem: title === issue.summary.trim() ? display.explanation : issue.summary,
      finding: {
        checkKey: finding.check_key,
        ruleId: finding.rule_id,
        severity: finding.severity,
        field: finding.field,
        expected: finding.expected,
        actual: finding.actual,
        recommendedAction: finding.required_action?.trim() || display.recommended_action,
      },
      previousReviews: [],
      deterministicState: [
        finding.expected != null ? `Expected ${finding.expected}` : null,
        finding.actual != null ? `found ${finding.actual}` : null,
      ].filter(Boolean).join(', ') || display.explanation,
      originalSourceText: null,
      rootCauseKey: rateRow ? `rate_row:${rateRow.source_document_id ?? ''}:${rateRow.record_id}` : `finding:${finding.id}`,
      evidence,
      suggestions: [],
      actions,
      sourceRefs: { findingId: finding.id },
    }];
  });
}

function reviewedValueCases(params: {
  projectId: string;
  documents: ReadonlyMap<string, ResolutionDocument>;
  reviewedValuesByDocument: ReadonlyMap<string, DocumentReviewedValueState>;
  evidenceAttentionByDocument: ReadonlyMap<string, DocumentEvidenceAttention>;
}): ResolutionCase[] {
  const cases: ResolutionCase[] = [];
  for (const [documentId, state] of params.reviewedValuesByDocument) {
    const label = documentLabel(params.documents, documentId);

    for (const target of openRegionAssertionEntryTargets(state)) {
      cases.push({
        caseId: `unreadable:${documentId}:${target.anchorKey}`,
        kind: 'unreadable_priced_line',
        tier: 'missing_authoritative_value',
        exposureAmount: null,
        projectId: params.projectId,
        documentId,
        physicalPageNumber: target.physicalPageNumber,
        title: `Unread priced line · ${label} p.${target.physicalPageNumber}`,
        problem: UNRESOLVED_REASON_TEXT[target.unresolvedReason]
          ?? 'Extraction could not read this priced line as a table row.',
        finding: null,
        previousReviews: [],
        deterministicState: 'No priced row exists for this line. It is not used in pricing.',
        originalSourceText: target.rawText,
        rootCauseKey: `unresolved_page:${documentId}:${target.physicalPageNumber}`,
        evidence: [currentTargetEvidence(documentId, target)],
        suggestions: [],
        actions: [
          {
            kind: 'enter_reviewed_value',
            method: 'POST',
            endpoint: regionAssertionEndpoint(documentId),
            factKey: 'contract_rate_row',
            target,
            supersedesAssertionId: chainHead(state.history, target.anchorKey),
          },
          dispositionAction(documentId, target, state.history),
          { kind: 'open_document', href: documentHref(documentId, target.physicalPageNumber) },
        ],
        sourceRefs: { anchorKey: target.anchorKey },
      });
    }

    for (const held of state.held) {
      const anchorKey = held.anchorKey;
      // A held review binds to whichever current target still presents its anchor.
      const target = state.entryTargets.find((entry) => entry.anchorKey === anchorKey)
        ?? params.evidenceAttentionByDocument.get(documentId)?.withheldTargets
          .find((entry) => entry.anchorKey === anchorKey)
        ?? params.evidenceAttentionByDocument.get(documentId)?.reviewRequiredTargets
          ?.find((entry) => entry.anchorKey === anchorKey)
        ?? null;
      const head = held.assertionIds.length === 1 ? held.assertionIds[0]! : null;
      const page = state.history.find((row) => held.assertionIds.includes(row.id))?.physical_page_number ?? null;
      const actions: ResolutionAction[] = [];
      // Re-review is possible only against a target the current extraction still offers.
      if (target) {
        actions.push({
          kind: 'enter_reviewed_value',
          method: 'POST',
          endpoint: regionAssertionEndpoint(documentId),
          factKey: 'contract_rate_row',
          target,
          supersedesAssertionId: chainHead(state.history, anchorKey),
        });
      }
      // Withdrawal is bound to the current target like any other review, so it
      // is offered only when the current extraction still presents one.
      if (target && head && chainHead(state.history, anchorKey) === head) {
        actions.push({
          kind: 'withdraw_reviewed_value',
          method: 'POST',
          endpoint: regionAssertionEndpoint(documentId),
          anchorKey,
          supersedesAssertionId: head,
          target,
        });
      }
      const previousReviews = state.history
        .filter((row) => held.assertionIds.includes(row.id))
        .sort((left, right) => left.asserted_at.localeCompare(right.asserted_at, 'en-US') || left.id.localeCompare(right.id, 'en-US'))
        .map(previousReviewOf);
      actions.push({ kind: 'open_document', href: documentHref(documentId, page) });
      cases.push({
        caseId: `rereview:${documentId}:${anchorKey}`,
        kind: 'reviewed_value_needs_rereview',
        tier: 'missing_authoritative_value',
        exposureAmount: null,
        projectId: params.projectId,
        documentId,
        physicalPageNumber: page,
        title: `Reviewed value not applied · ${label}${page != null ? ` p.${page}` : ''}`,
        problem: HELD_REASON_TEXT[held.reason],
        finding: null,
        previousReviews,
        deterministicState: 'The human-reviewed value is held, not applied, until it is reviewed again.',
        originalSourceText: target?.rawText ?? null,
        rootCauseKey: `reviewed_value:${documentId}:${anchorKey}`,
        evidence: [
          ...(target ? [currentTargetEvidence(documentId, target)] : []),
          // What the earlier review rested on. Its page representation is no
          // longer current, so it is described, never drawn on today's page.
          ...previousReviews.map((review) => ({
            documentId,
            physicalPageNumber: review.physicalPageNumber,
            observationIds: review.observationIds,
            region: null,
            label: review.originalSourceText ?? 'Reviewed region',
            role: 'previous' as const,
            visual: null,
            detail: null,
          })),
        ],
        suggestions: [],
        actions,
        sourceRefs: { assertionIds: held.assertionIds, anchorKey },
      });
    }
  }
  return cases;
}

function sameObservations(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((id) => set.has(id));
}

/**
 * Cases for evidence EightForge knows it could not read, refused to publish,
 * or could not interpret. One case per diagnostic whose registry attention is
 * `resolution_case`; a withheld priced line is identified by its source
 * observations (the same anchor scheme as an unread line), so its case and its
 * review survive reprocessing that leaves the evidence unchanged.
 */
function evidenceAttentionCases(params: {
  projectId: string;
  documents: ReadonlyMap<string, ResolutionDocument>;
  reviewedValuesByDocument: ReadonlyMap<string, DocumentReviewedValueState>;
  evidenceAttentionByDocument: ReadonlyMap<string, DocumentEvidenceAttention>;
  /** Proposals already listed as their own cases; their evidence is not listed twice. */
  pendingProposalIds: ReadonlySet<string>;
}): ResolutionCase[] {
  const cases: ResolutionCase[] = [];
  for (const [documentId, attention] of params.evidenceAttentionByDocument) {
    const label = documentLabel(params.documents, documentId);
    const state = params.reviewedValuesByDocument.get(documentId);
    const history = state?.history ?? [];
    const closedAnchors = new Set([
      ...(state?.effective ?? []).map((entry) => entry.anchorKey),
      ...(state?.held ?? []).flatMap((entry) => entry.anchorKey.split(',')),
    ]);
    const listedAnchors = new Set<string>();
    for (const diagnostic of attention.diagnostics) {
      if (diagnostic.attention !== 'resolution_case') continue;
      const kind = CASE_KIND_BY_DIAGNOSTIC_CODE[diagnostic.code];
      if (!kind) continue;
      if (diagnostic.recoveryProposalId && params.pendingProposalIds.has(diagnostic.recoveryProposalId)) continue;
      const page = diagnostic.physicalPageNumber;
      const diagnosticRef = {
        code: diagnostic.code,
        attention: diagnostic.attention,
        recoverability: diagnostic.recoverability,
        recoveryType: diagnostic.recoveryType,
      };
      const pageEvidence: ResolutionEvidenceRef = {
        documentId,
        physicalPageNumber: page,
        observationIds: diagnostic.observationIds,
        region: null,
        label: diagnostic.summary,
        role: 'current',
        visual: diagnostic.visual,
        detail: null,
      };
      const openDocument: ResolutionAction = { kind: 'open_document', href: documentHref(documentId, page) };
      if (kind === 'withheld_priced_line') {
        const target = attention.withheldTargets.find((entry) => entry.physicalPageNumber === page
          && sameObservations(entry.sourceObservationIds, diagnostic.observationIds)) ?? null;
        // Reviewed, disposed or held for re-review elsewhere: not open here.
        if (target && (closedAnchors.has(target.anchorKey) || listedAnchors.has(target.anchorKey))) continue;
        if (target) listedAnchors.add(target.anchorKey);
        cases.push({
          caseId: target ? `withheld:${documentId}:${target.anchorKey}` : `diagnostic:${diagnostic.diagnosticId}`,
          kind,
          tier: 'missing_authoritative_value',
          exposureAmount: null,
          projectId: params.projectId,
          documentId,
          physicalPageNumber: page,
          title: `${diagnostic.code === 'unpriced_row' ? 'Unpriced row' : 'Withheld priced line'} · ${label}${page != null ? ` p.${page}` : ''}`,
          problem: WITHHELD_REASON_TEXT[diagnostic.code] ?? diagnostic.summary,
          finding: null,
          previousReviews: [],
          deterministicState: 'Extraction found this line and refused to publish it. It is not used in pricing.',
          originalSourceText: target?.rawText ?? diagnostic.summary,
          rootCauseKey: `withheld:${documentId}:${page ?? 'document'}`,
          evidence: target ? [currentTargetEvidence(documentId, target)] : [pageEvidence],
          suggestions: [],
          actions: target ? [
            {
              kind: 'enter_reviewed_value',
              method: 'POST',
              endpoint: regionAssertionEndpoint(documentId),
              factKey: 'contract_rate_row',
              target,
              supersedesAssertionId: chainHead(history, target.anchorKey),
            },
            dispositionAction(documentId, target, history),
            openDocument,
          ] : [openDocument],
          diagnostic: diagnosticRef,
          sourceRefs: { diagnosticId: diagnostic.diagnosticId, ...(target ? { anchorKey: target.anchorKey } : {}) },
        });
        continue;
      }
      if (kind !== 'structure_review' && kind !== 'coverage_gap' && kind !== 'pricing_withheld') continue;
      const titles = { structure_review: 'Table not interpreted', coverage_gap: 'Page not read',
        pricing_withheld: 'Page pricing withheld' } as const;
      cases.push({
        caseId: `diagnostic:${diagnostic.diagnosticId}`,
        kind,
        tier: kind === 'coverage_gap' && diagnostic.code !== 'expected_pricing_page_no_usable_evidence'
          ? 'structural' : 'affects_pricing',
        exposureAmount: null,
        projectId: params.projectId,
        documentId,
        physicalPageNumber: page,
        title: `${titles[kind]} · ${label}${page != null ? ` p.${page}` : ''}`,
        problem: diagnostic.summary,
        finding: null,
        previousReviews: [],
        deterministicState: kind === 'coverage_gap'
          ? 'EightForge has no usable reading of this page. Nothing on it is priced or checked.'
          : kind === 'pricing_withheld'
            ? 'Rows on this page were read but are withheld from pricing until their authority can be verified.'
            : 'The table on this page was read structurally but not interpreted, so nothing on it is priced.',
        originalSourceText: null,
        rootCauseKey: kind === 'coverage_gap' ? `coverage:${documentId}` : `${kind}:${documentId}:${page ?? 'document'}`,
        evidence: [pageEvidence],
        suggestions: [],
        actions: [openDocument],
        diagnostic: diagnosticRef,
        sourceRefs: { diagnosticId: diagnostic.diagnosticId },
      });
    }
    // A row reconstruction trusted, whose amount was read from a scan: the
    // amount is a candidate, withheld from pricing until a person confirms or
    // corrects it. Closed by an effective (or held) reviewed value on the row.
    for (const target of attention.reviewRequiredTargets ?? []) {
      if (closedAnchors.has(target.anchorKey) || listedAnchors.has(target.anchorKey)) continue;
      listedAnchors.add(target.anchorKey);
      cases.push({
        caseId: `review_required:${documentId}:${target.anchorKey}`,
        kind: 'review_required_value',
        tier: 'missing_authoritative_value',
        exposureAmount: null,
        projectId: params.projectId,
        documentId,
        physicalPageNumber: target.physicalPageNumber,
        title: `${target.basis === 'scanned_source' ? 'Scanned rate to confirm' : 'Unreadable rate to enter'} · ${label} p.${target.physicalPageNumber}`,
        problem: target.basis === 'scanned_source'
          ? `This rate was read from a scan as "${target.candidateRateRaw}". A scanned amount can be well formed and still wrong, so it is not used until a person confirms or corrects it.`
          : `The rate cell reads "${target.candidateRateRaw}", which is not a whole amount. It is not used until a person enters the amount the page shows.`,
        finding: null,
        previousReviews: [],
        deterministicState: 'The row was reconstructed, but its rate is withheld from pricing and from the Validator.',
        originalSourceText: target.rawText,
        rootCauseKey: `review_required:${documentId}:${target.physicalPageNumber}`,
        evidence: [currentTargetEvidence(documentId, target)],
        suggestions: [],
        actions: [
          {
            kind: 'enter_reviewed_value',
            method: 'POST',
            endpoint: regionAssertionEndpoint(documentId),
            factKey: 'contract_rate_row',
            target,
            supersedesAssertionId: chainHead(history, target.anchorKey),
          },
          dispositionAction(documentId, target, history),
          { kind: 'open_document', href: documentHref(documentId, target.physicalPageNumber) },
        ],
        sourceRefs: { anchorKey: target.anchorKey },
      });
    }
  }
  return cases;
}

function recoveryCases(params: {
  projectId: string;
  documents: ReadonlyMap<string, ResolutionDocument>;
  proposals: readonly PendingRecoveryProposal[];
}): ResolutionCase[] {
  return params.proposals.flatMap((proposal) => {
    if (proposal.reviewState !== 'pending_review') return [];
    const documentId = proposal.sourceDocumentId;
    return [{
      caseId: `recovery:${proposal.proposalId}`,
      kind: 'recovery_proposal_pending' as const,
      tier: 'affects_pricing' as const,
      exposureAmount: null,
      projectId: params.projectId,
      documentId,
      physicalPageNumber: proposal.physicalPageNumber,
      title: `Withheld priced row · ${documentLabel(params.documents, documentId)} p.${proposal.physicalPageNumber}`,
      problem: `Extraction withheld this row: ${proposal.recoveryReason}.`,
      finding: null,
      previousReviews: [],
      deterministicState: 'The row is withheld. Nothing is priced until an operator reviews it.',
      originalSourceText: proposal.evidence.map((entry) => entry.rawText).join(' ') || null,
      rootCauseKey: `recovery:${documentId}:${proposal.physicalPageNumber}`,
      evidence: [{
        documentId,
        physicalPageNumber: proposal.physicalPageNumber,
        observationIds: proposal.evidence.map((entry) => entry.observationId),
        region: null,
        label: proposal.recoveryType,
        role: 'current' as const,
        visual: proposal.sourceEvidenceUnbound
          ? null
          : proposal.selectableConfirmations.find((option) => option.proposed)?.visual ?? null,
        detail: null,
      }],
      suggestions: [{
        source: 'forgewing_recovery_proposal' as const,
        proposedValue: proposal.proposedValue,
        uncalibratedCertainty: Number.isFinite(proposal.certainty) ? proposal.certainty : null,
        proposalId: proposal.proposalId,
      }],
      actions: [
        {
          kind: 'review_recovery_proposal' as const,
          method: 'POST' as const,
          endpoint: '/api/internal/forgewing-recovery-review' as const,
          proposalId: proposal.proposalId,
          proposalDigestSha256: proposal.proposalDigestSha256,
          proposalVersion: proposal.proposalVersion,
          dispositions: ['accepted', 'modified', 'rejected', 'deferred'] as const,
          selectableConfirmations: proposal.selectableConfirmations,
          sourceEvidenceUnbound: proposal.sourceEvidenceUnbound,
        },
        { kind: 'open_document' as const, href: documentHref(documentId, proposal.physicalPageNumber) },
      ],
      sourceRefs: { proposalId: proposal.proposalId },
    }];
  });
}

function compareCases(left: ResolutionCase, right: ResolutionCase): number {
  const tier = RESOLUTION_TIER_ORDER.indexOf(left.tier) - RESOLUTION_TIER_ORDER.indexOf(right.tier);
  if (tier !== 0) return tier;
  const leftAmount = left.exposureAmount ?? -1;
  const rightAmount = right.exposureAmount ?? -1;
  if (leftAmount !== rightAmount) return rightAmount - leftAmount;
  return left.caseId.localeCompare(right.caseId, 'en-US');
}

export function buildResolutionQueue(params: {
  projectId: string;
  documents: readonly ResolutionDocument[];
  issues: readonly IssueObject[];
  /** Persisted Validator evidence for the issues' findings. */
  evidence: readonly ValidationEvidence[];
  reviewedValuesByDocument: ReadonlyMap<string, DocumentReviewedValueState>;
  recoveryProposals: readonly PendingRecoveryProposal[];
  /** Forgewing suggestion sources appear only for an organization with Forgewing enabled. */
  forgewingEnabled: boolean;
  /** Current verified pages per document, for page-level evidence. */
  documentPages?: ReadonlyMap<string, DocumentPageFrames>;
  /** Per document: diagnostics and withheld-evidence targets. EightForge Core, never gated. */
  evidenceAttentionByDocument?: ReadonlyMap<string, DocumentEvidenceAttention>;
}): ResolutionQueue {
  const documents = new Map(params.documents.map((document) => [document.id, document] as const));
  const evidenceAttentionByDocument = params.evidenceAttentionByDocument ?? new Map();
  const pendingProposalIds = new Set(params.forgewingEnabled
    ? params.recoveryProposals.filter((proposal) => proposal.reviewState === 'pending_review')
      .map((proposal) => proposal.proposalId)
    : []);
  const cases = [
    ...validatorCases({
      projectId: params.projectId, issues: params.issues, evidence: params.evidence,
      documentPages: params.documentPages ?? new Map(),
    }),
    ...reviewedValueCases({
      projectId: params.projectId, documents, reviewedValuesByDocument: params.reviewedValuesByDocument,
      evidenceAttentionByDocument,
    }),
    ...evidenceAttentionCases({
      projectId: params.projectId, documents, reviewedValuesByDocument: params.reviewedValuesByDocument,
      evidenceAttentionByDocument, pendingProposalIds,
    }),
    ...(params.forgewingEnabled
      ? recoveryCases({ projectId: params.projectId, documents, proposals: params.recoveryProposals })
      : []),
  ].sort(compareCases);

  const byRoot = new Map<string, ResolutionCase[]>();
  for (const entry of cases) byRoot.set(entry.rootCauseKey, [...(byRoot.get(entry.rootCauseKey) ?? []), entry]);
  const groups: ResolutionCaseGroup[] = [...byRoot.entries()].map(([rootCauseKey, members]) => {
    // Members are already ranked, so the first carries the group's tier.
    const amounts = members.map((member) => member.exposureAmount).filter((amount): amount is number => amount != null);
    return {
      rootCauseKey,
      tier: members[0]!.tier,
      title: members.length === 1 ? members[0]!.title : `${members[0]!.title} (+${members.length - 1} related)`,
      caseIds: members.map((member) => member.caseId),
      findingCount: members.filter((member) => member.kind === 'validator_finding').length,
      exposureAmount: amounts.length > 0 ? amounts.reduce((sum, amount) => sum + amount, 0) : null,
    };
  }).sort((left, right) => {
    const tier = RESOLUTION_TIER_ORDER.indexOf(left.tier) - RESOLUTION_TIER_ORDER.indexOf(right.tier);
    if (tier !== 0) return tier;
    const amount = (right.exposureAmount ?? -1) - (left.exposureAmount ?? -1);
    return amount !== 0 ? amount : left.rootCauseKey.localeCompare(right.rootCauseKey, 'en-US');
  });

  const countsByTier = Object.fromEntries(RESOLUTION_TIER_ORDER.map((tier) => [tier, 0])) as Record<ResolutionImpactTier, number>;
  for (const entry of cases) countsByTier[entry.tier] += 1;

  return {
    modelVersion: RESOLUTION_CASE_MODEL_VERSION,
    projectId: params.projectId,
    cases,
    groups,
    countsByTier,
    forgewingSuggestionsIncluded: params.forgewingEnabled,
  };
}
