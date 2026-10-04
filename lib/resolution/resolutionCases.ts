import type {
  EffectiveRegionAssertion,
  HeldRegionAssertion,
  HumanFactAssertionRow,
  RegionAssertionEntryTarget,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import { isIssueRequiringReview, type IssueObject } from '@/lib/issueObjects';
import { isApprovalBlocker } from '@/lib/validator/findingSemantics';
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

/** Where the evidence is. Source-bound only: document, page, observations, region. */
export type ResolutionEvidenceRef = Readonly<{
  documentId: string | null;
  physicalPageNumber: number | null;
  observationIds: readonly string[];
  region: RegionAssertionEntryTarget['sourceRegion'] | null;
  label: string;
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
    }>
  | Readonly<{
      kind: 'withdraw_reviewed_value';
      method: 'POST';
      endpoint: string;
      anchorKey: string;
      supersedesAssertionId: string;
    }>
  | Readonly<{
      kind: 'review_recovery_proposal';
      method: 'POST';
      endpoint: '/api/internal/forgewing-recovery-review';
      proposalId: string;
      proposalDigestSha256: string;
      dispositions: readonly ('accepted' | 'modified' | 'rejected' | 'deferred')[];
    }>
  | Readonly<{
      kind: 'link_invoice_line_rate';
      method: 'POST';
      endpoint: string;
      findingId: string;
    }>
  | Readonly<{
      kind: 'resolve_execution_item';
      method: 'POST';
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
  title: string;
  problem: string;
  /** What EightForge knows deterministically. */
  deterministicState: string;
  /** What extraction read at the source, when there is one. Never rewritten. */
  originalSourceText: string | null;
  /** Source-bound root cause. Cases sharing it are resolved together. */
  rootCauseKey: string;
  evidence: readonly ResolutionEvidenceRef[];
  suggestions: readonly ResolutionSuggestion[];
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
}>;

export type ResolutionDocument = Readonly<{
  id: string;
  title?: string | null;
  name?: string | null;
}>;

const MANUAL_RATE_LINK_RULE_IDS = new Set(['FINANCIAL_RATE_CODE_MISSING', 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS']);

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
      });
    }
    if (issue.executionItemId) {
      actions.push({
        kind: 'resolve_execution_item',
        method: 'POST',
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
    const evidence = rows.map((row) => ({
      documentId: row.source_document_id,
      physicalPageNumber: row.source_page,
      observationIds: [],
      region: null,
      label: row.note ?? row.field_name ?? row.evidence_type,
    }));
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
      title: issue.title,
      problem: issue.summary,
      deterministicState: [
        finding.expected != null ? `Expected ${finding.expected}` : null,
        finding.actual != null ? `found ${finding.actual}` : null,
      ].filter(Boolean).join(', ') || finding.rule_id,
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
}): ResolutionCase[] {
  const cases: ResolutionCase[] = [];
  for (const [documentId, state] of params.reviewedValuesByDocument) {
    const label = documentLabel(params.documents, documentId);
    const effectiveAnchors = new Set(state.effective.map((entry) => entry.anchorKey));
    const heldAnchors = new Set(state.held.flatMap((entry) => entry.anchorKey.split(',')));

    for (const target of state.entryTargets) {
      if (effectiveAnchors.has(target.anchorKey) || heldAnchors.has(target.anchorKey)) continue;
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
        deterministicState: 'No priced row exists for this line. It is not used in pricing.',
        originalSourceText: target.rawText,
        rootCauseKey: `unresolved_page:${documentId}:${target.physicalPageNumber}`,
        evidence: [{
          documentId,
          physicalPageNumber: target.physicalPageNumber,
          observationIds: target.sourceObservationIds,
          region: target.sourceRegion,
          label: target.rawText,
        }],
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
        });
      }
      if (head && chainHead(state.history, anchorKey) === head) {
        actions.push({
          kind: 'withdraw_reviewed_value',
          method: 'POST',
          endpoint: regionAssertionEndpoint(documentId),
          anchorKey,
          supersedesAssertionId: head,
        });
      }
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
        deterministicState: 'The human-reviewed value is held, not applied, until it is reviewed again.',
        originalSourceText: state.history.find((row) => held.assertionIds.includes(row.id))?.original_source_text ?? null,
        rootCauseKey: `reviewed_value:${documentId}:${anchorKey}`,
        evidence: target ? [{
          documentId,
          physicalPageNumber: target.physicalPageNumber,
          observationIds: target.sourceObservationIds,
          region: target.sourceRegion,
          label: target.rawText,
        }] : [],
        suggestions: [],
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
      deterministicState: 'The row is withheld. Nothing is priced until an operator reviews it.',
      originalSourceText: proposal.evidence.map((entry) => entry.rawText).join(' ') || null,
      rootCauseKey: `recovery:${documentId}:${proposal.physicalPageNumber}`,
      evidence: [{
        documentId,
        physicalPageNumber: proposal.physicalPageNumber,
        observationIds: proposal.evidence.map((entry) => entry.observationId),
        region: null,
        label: proposal.recoveryType,
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
          dispositions: ['accepted', 'modified', 'rejected', 'deferred'] as const,
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
}): ResolutionQueue {
  const documents = new Map(params.documents.map((document) => [document.id, document] as const));
  const cases = [
    ...validatorCases({ projectId: params.projectId, issues: params.issues, evidence: params.evidence }),
    ...reviewedValueCases({
      projectId: params.projectId, documents, reviewedValuesByDocument: params.reviewedValuesByDocument,
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
