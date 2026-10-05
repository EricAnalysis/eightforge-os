import {
  formatReviewedValue,
  openRegionAssertionEntryTargets,
  type EffectiveRegionAssertion,
  type HeldRegionAssertion,
  type HumanFactAssertionRow,
  type RegionAssertionEntryTarget,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import { getIssueDisplayLabel } from '@/lib/issueDisplayFormatter';
import { isIssueRequiringReview, type IssueObject } from '@/lib/issueObjects';
import { pageFrameVisual, type DocumentPageFrames } from '@/lib/recovery/diagnosticVisualEvidence';
import type { VisualSourceEvidence } from '@/lib/recovery/visualSourceEvidence';
import { isApprovalBlocker } from '@/lib/validator/findingSemantics';
import { isHumanReviewedEvidenceNote } from '@/lib/validator/humanReviewedEvidence';
import type { ValueReadingLifecycle } from '@/lib/resolution/valueReadingLifecycle';
import type {
  ValueReadingOutcomeCode,
  ValueReadingOutcomeReason,
  ValueReadingOutcomeRecord,
  ValueReadingProposalRecord,
} from '@/lib/server/valueReadingProposals';
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
 *   when the caller says Forgewing is enabled for the organization).
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
  | 'recovery_proposal_pending';

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
export type ResolutionSuggestion =
  | Readonly<{
      source: 'forgewing_recovery_proposal';
      /** The proposal's own value, verbatim. Shown beside the decision, never pre-filled as truth. */
      proposedValue: string;
      /** Model self-report. Uncalibrated; renderers must not present it as accuracy. */
      uncalibratedCertainty: number | null;
      proposalId: string;
    }>
  | Readonly<{
      /** A Forgewing value reading (B4). AI_PROPOSED: shown beside the operator's input, never inside it. */
      source: 'forgewing_value_reading';
      proposalId: string;
      /** What Forgewing read, verbatim; or that it could not read the value. */
      reading:
        | Readonly<{ kind: 'value'; description: string; unitType: string; rateAmount: number; category: string | null }>
        | Readonly<{ kind: 'unreadable' }>;
      rationale: string;
      /** Always shown as an unverified visual reading. No numeric confidence exists or is shown. */
      basis: 'visual_reading';
      verification: 'unverified';
      /** The operator deferred it earlier; it is still current. */
      deferred: boolean;
      createdAt: string;
    }>;

/** The last time an operator asked Forgewing to read this line, and what happened. */
export type ValueReadingStatus = Readonly<{
  lastOutcome: Readonly<{ code: ValueReadingOutcomeCode; reason: ValueReadingOutcomeReason; observedAt: string }> | null;
}>;

/** Value readings for one document, as the server read them. */
export type DocumentValueReadings = Readonly<{
  proposals: readonly ValueReadingProposalRecord[];
  lifecycle: readonly ValueReadingLifecycle[];
  outcomes: readonly ValueReadingOutcomeRecord[];
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
      /**
       * Value-reading proposals the operator may cite when they use a
       * suggestion. The database verifies the citation and decides whether
       * the value was used unchanged or edited; the client never says which.
       */
      citableProposalIds: readonly string[];
    }>
  | Readonly<{
      /** Ask Forgewing to read this line. Records one durable outcome; never writes truth. */
      kind: 'request_value_reading';
      method: 'POST';
      endpoint: string;
      caseId: string;
    }>
  | Readonly<{
      /** Reject or defer a value reading. Neither authorizes a value: use is a reviewed value. */
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
  /** Forgewing value reading for an unread line; null when not offered (Core, or other kinds). */
  valueReading: ValueReadingStatus | null;
  actions: readonly ResolutionAction[];
  /** Ids of the records this case was derived from. */
  sourceRefs: Readonly<{
    findingId?: string;
    assertionIds?: readonly string[];
    proposalId?: string;
    anchorKey?: string;
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

const UNRESOLVED_REASON_TEXT: Record<string, string> = {
  multiple_priced_headers: 'The page holds more than one priced table, so it was not read as one.',
  ambiguous_header_candidates: 'More than one line could be the table header; none was chosen.',
  header_not_found: 'Priced lines were found, but no table header.',
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

/** The single head of a chain, or null when there is none or it is ambiguous. */
function chainHead(history: readonly HumanFactAssertionRow[], anchorKey: string): string | null {
  const chain = history.filter((row) => row.anchor_key === anchorKey);
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
      valueReading: null,
      actions,
      sourceRefs: { findingId: finding.id },
    }];
  });
}

function valueReadingEndpoint(projectId: string): string {
  return `/api/projects/${projectId}/resolution-cases/value-reading`;
}

/**
 * The Forgewing slot for one unread line: the current suggestion (a value
 * reading that is neither stale, rejected nor used), the last request outcome,
 * and the actions the operator may take. Only for an entitled organization.
 */
function valueReadingSlot(params: {
  projectId: string;
  caseId: string;
  documentId: string;
  target: RegionAssertionEntryTarget;
  readings: DocumentValueReadings | null;
}): Readonly<{ suggestions: ResolutionSuggestion[]; status: ValueReadingStatus; actions: ResolutionAction[];
  citableProposalIds: string[] }> {
  const readings = params.readings;
  const lifecycle = new Map((readings?.lifecycle ?? []).map((entry) => [entry.proposalId, entry]));
  // Current for this exact line: same anchor and page representation, not stale, rejected or used.
  const current = (readings?.proposals ?? [])
    .filter((proposal) => proposal.binding.sourceDocumentId === params.documentId
      && proposal.binding.anchorKey === params.target.anchorKey
      && proposal.binding.pageRepresentationDigest === params.target.pageRepresentationDigest)
    .filter((proposal) => {
      const state = lifecycle.get(proposal.proposalId)?.state;
      return state === 'pending' || state === 'deferred';
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt, 'en-US')
      || left.proposalId.localeCompare(right.proposalId, 'en-US'));
  const shown = current.find((proposal) => proposal.reading.kind === 'value') ?? current[0] ?? null;
  const last = (readings?.outcomes ?? []).filter((outcome) => outcome.sourceDocumentId === params.documentId
    && outcome.anchorKey === params.target.anchorKey).at(-1) ?? null;

  const suggestions: ResolutionSuggestion[] = shown ? [{
    source: 'forgewing_value_reading',
    proposalId: shown.proposalId,
    reading: shown.reading.kind === 'value' ? {
      kind: 'value',
      description: shown.reading.rateRow.description,
      unitType: shown.reading.rateRow.unit_type,
      rateAmount: shown.reading.rateRow.rate_amount,
      category: shown.reading.rateRow.category,
    } : { kind: 'unreadable' },
    rationale: shown.rationale,
    basis: 'visual_reading',
    verification: 'unverified',
    deferred: lifecycle.get(shown.proposalId)?.state === 'deferred',
    createdAt: shown.createdAt,
  }] : [];
  const actions: ResolutionAction[] = [];
  // Asking again for a line with a current reading would only return that reading.
  if (!shown) {
    actions.push({ kind: 'request_value_reading', method: 'POST',
      endpoint: valueReadingEndpoint(params.projectId), caseId: params.caseId });
  }
  if (shown && shown.reading.kind === 'value') {
    actions.push({ kind: 'review_value_reading', method: 'POST',
      endpoint: `${valueReadingEndpoint(params.projectId)}/review`,
      proposalId: shown.proposalId, proposalDigestSha256: shown.proposalDigestSha256,
      dispositions: ['rejected', 'deferred'] });
  }
  return {
    suggestions,
    status: { lastOutcome: last ? { code: last.outcomeCode, reason: last.sanitizedReason, observedAt: last.observedAt } : null },
    actions,
    citableProposalIds: shown && shown.reading.kind === 'value' ? [shown.proposalId] : [],
  };
}

function reviewedValueCases(params: {
  projectId: string;
  documents: ReadonlyMap<string, ResolutionDocument>;
  reviewedValuesByDocument: ReadonlyMap<string, DocumentReviewedValueState>;
  forgewingEnabled: boolean;
  valueReadingsByDocument: ReadonlyMap<string, DocumentValueReadings>;
}): ResolutionCase[] {
  const cases: ResolutionCase[] = [];
  for (const [documentId, state] of params.reviewedValuesByDocument) {
    const label = documentLabel(params.documents, documentId);

    for (const target of openRegionAssertionEntryTargets(state)) {
      const caseId = `unreadable:${documentId}:${target.anchorKey}`;
      const forgewing = params.forgewingEnabled ? valueReadingSlot({
        projectId: params.projectId, caseId, documentId, target,
        readings: params.valueReadingsByDocument.get(documentId) ?? null,
      }) : null;
      cases.push({
        caseId,
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
        suggestions: forgewing?.suggestions ?? [],
        valueReading: forgewing?.status ?? null,
        actions: [
          {
            kind: 'enter_reviewed_value',
            method: 'POST',
            endpoint: regionAssertionEndpoint(documentId),
            factKey: 'contract_rate_row',
            target,
            supersedesAssertionId: chainHead(state.history, target.anchorKey),
            citableProposalIds: forgewing?.citableProposalIds ?? [],
          },
          ...(forgewing?.actions ?? []),
          { kind: 'open_document', href: documentHref(documentId, target.physicalPageNumber) },
        ],
        sourceRefs: { anchorKey: target.anchorKey },
      });
    }

    for (const held of state.held) {
      const anchorKey = held.anchorKey;
      const target = state.entryTargets.find((entry) => entry.anchorKey === anchorKey) ?? null;
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
          citableProposalIds: [],
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
      valueReading: null,
        actions,
        sourceRefs: { assertionIds: held.assertionIds, anchorKey },
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
      valueReading: null,
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
  /** Value readings per document; read only for an organization with Forgewing enabled. */
  valueReadingsByDocument?: ReadonlyMap<string, DocumentValueReadings>;
  /** Current verified pages per document, for page-level evidence. */
  documentPages?: ReadonlyMap<string, DocumentPageFrames>;
}): ResolutionQueue {
  const documents = new Map(params.documents.map((document) => [document.id, document] as const));
  const cases = [
    ...validatorCases({
      projectId: params.projectId, issues: params.issues, evidence: params.evidence,
      documentPages: params.documentPages ?? new Map(),
    }),
    ...reviewedValueCases({
      projectId: params.projectId, documents, reviewedValuesByDocument: params.reviewedValuesByDocument,
      forgewingEnabled: params.forgewingEnabled, valueReadingsByDocument: params.valueReadingsByDocument ?? new Map(),
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
