/**
 * The single canonical-to-validator projection.
 *
 * Rule packs keep consuming the existing `RateScheduleItem` interface. In
 * canonical mode those items are derived here, once, from the frozen canonical
 * Project Truth registry instead of from legacy fact rows. No rule pack knows
 * which authority produced its input, and this mapping exists in exactly one
 * place so it cannot drift per pack (see the authority cutover amendment).
 *
 * Only value-bearing canonical states project a value. A canonical row whose
 * rate never resolved projects `rate_amount: null` rather than reaching back
 * into legacy truth for a rescue — canonical mode has no fallback.
 */

import type { CanonicalContractPricingSchedule } from '@/lib/canonical/contract/pricing';
import type { CanonicalContractPricingRow } from '@/lib/canonical/contract/pricing';
import { isValueBearingState } from '@/lib/canonical/truth/envelope';
import type { TruthEnvelope } from '@/lib/canonical/truth/envelope';
import { authoredRateRowQuarantine } from '@/lib/contracts/authoredRowQuarantine';
import { deriveBillingKeysForRateScheduleItem } from '@/lib/validator/billingKeys';
import type { CanonicalTransaction } from '@/lib/canonical/transaction/transaction';
import type { RateScheduleItem, ValidatorTransactionDataRow } from '@/lib/validator/shared';

import type { CanonicalTruthDomain } from './canonicalDomainCoverage';
import type {
  CanonicalInvoiceIdentity,
  CanonicalInvoiceIdentityConflict,
  CanonicalInvoiceLineIdentity,
  CanonicalInvoiceLineIdentityIssue,
} from './canonicalInvoiceAuthority';
import type { CanonicalRelationship } from './canonicalRelationshipAuthority';
import {
  projectProvenanceEvidence,
  type CanonicalFindingEvidence,
} from './canonicalProvenance';

/**
 * Reads a canonical envelope as an authoritative value.
 *
 * Non-value-bearing states (absent, not applicable, unresolved conflict)
 * project `null`. `observedRaw` is deliberately NOT substituted: a raw
 * observation that canonical interpretation declined to resolve is evidence,
 * not truth.
 */
function authoritativeValue<T>(envelope: TruthEnvelope<T> | null | undefined): T | null {
  if (envelope == null) return null;
  if (!isValueBearingState(envelope.state)) return null;
  return envelope.value;
}

function authoritativeString(envelope: TruthEnvelope<string> | null | undefined): string | null {
  const value = authoritativeValue(envelope);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function authoritativeNumber(envelope: TruthEnvelope<number> | null | undefined): number | null {
  const value = authoritativeValue(envelope);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * True when a canonical row carries no operator-meaningful dimension.
 *
 * Mirrors the legacy emptiness gate in `normalizeRateScheduleItem` so canonical
 * mode does not introduce phantom rate rows that legacy mode would have
 * dropped, which would change Golden finding counts for a non-truth reason.
 */
function isProjectableRow(item: {
  readonly rate_code: string | null;
  readonly unit_type: string | null;
  readonly rate_amount: number | null;
  readonly material_type: string | null;
  readonly description: string | null;
}): boolean {
  return !(
    item.rate_code == null &&
    item.unit_type == null &&
    item.rate_amount == null &&
    item.material_type == null &&
    item.description == null
  );
}

function projectRow(
  row: CanonicalContractPricingRow,
  fallbackDocumentId: string | null,
): RateScheduleItem | null {
  const sourceDocumentId =
    row.governingDocument?.documentId
    ?? row.rateSchedule.governingSource?.documentId
    ?? fallbackDocumentId;

  // A rate row with no attributable source document is not authoritative
  // truth; provenance is mandatory, never inferred.
  if (sourceDocumentId == null) return null;

  const rateCode = authoritativeString(row.rateCode);
  const unitType = authoritativeString(row.unit);
  const rateAmount = authoritativeNumber(row.rate);
  const materialType = authoritativeString(row.materialType);
  const description = authoritativeString(row.description);
  const serviceItem = authoritativeString(row.serviceType);
  const sourceCategory = authoritativeString(row.category);

  const core = {
    rate_code: rateCode,
    unit_type: unitType,
    rate_amount: rateAmount,
    material_type: materialType,
    description,
  };
  if (!isProjectableRow(core)) return null;

  const keys = deriveBillingKeysForRateScheduleItem({
    rate_code: rateCode,
    description,
    material_type: materialType,
    unit_type: unitType,
    service_item: serviceItem,
  });

  const authoredQuarantine = authoredRateRowQuarantine({
    row_id: row.rowId,
    source_kind: row.sourceFamily.adapterId,
    authoredValueCorrection: row.authoredCorrection,
  });

  return {
    source_document_id: sourceDocumentId,
    // Canonical row identity is the authoritative record id so evidence
    // anchors and downstream matching stay traceable to the registry.
    record_id: row.rowId,
    rate_code: rateCode,
    unit_type: unitType,
    rate_amount: rateAmount,
    material_type: materialType,
    description,
    service_item: serviceItem,
    source_category: sourceCategory,
    canonical_category: sourceCategory,
    category_confidence: row.category.confidence,
    source_kind: row.sourceFamily.adapterId,
    source_quality: row.resolution.state,
    confidence: row.rate.state,
    authoredValueCorrection: row.authoredCorrection,
    authored_unverified: authoredQuarantine?.authoredUnverified ?? false,
    authored_quarantine: authoredQuarantine,
    raw_value: row.rawValues,
    ...keys,
  } satisfies RateScheduleItem;
}

/**
 * Projects canonical pricing schedules into validator rate schedule items.
 *
 * Ordering is deterministic: schedule order, then canonical row ordinal, then
 * row id. Two runs over the same frozen registry produce an identical array.
 */
export function projectCanonicalRateScheduleItems(
  schedules: readonly CanonicalContractPricingSchedule[],
): RateScheduleItem[] {
  const items: RateScheduleItem[] = [];
  for (const schedule of schedules) {
    const fallbackDocumentId = schedule.governingDocument?.documentId ?? null;
    const ordered = [...schedule.rows].sort((left, right) => {
      if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
      return left.rowId.localeCompare(right.rowId, 'en-US');
    });
    for (const row of ordered) {
      const projected = projectRow(row, fallbackDocumentId);
      if (projected != null) items.push(projected);
    }
  }
  return items;
}

/**
 * Projects canonical transactions into the existing validator row interface.
 *
 * This is the single reroute point for transaction truth. Because exposure,
 * reconciliation, and the transaction rule packs all read
 * `ProjectValidatorInput.transactionData.rows`, swapping this one array moves
 * every consumer onto canonical truth without rewriting any rule pack.
 *
 * Row grain is preserved exactly: one canonical transaction projects to one row.
 * Nothing is merged, summed, or deduplicated here — ticket-grain aggregation is
 * the consumer's concern, and collapsing rows would destroy the repeated-row
 * evidence that makes a grain conflict visible.
 */
export function projectCanonicalTransactionRows(
  transactions: readonly CanonicalTransaction[],
  fallbackProjectId: string,
): ValidatorTransactionDataRow[] {
  return transactions.map((transaction) => ({
    id: transaction.transactionId,
    document_id: transaction.sourceDocumentId ?? '',
    project_id: fallbackProjectId,
    invoice_number: authoritativeString(transaction.invoiceNumber),
    transaction_number: authoritativeString(transaction.transactionNumber),
    rate_code: authoritativeString(transaction.rateCode),
    billing_rate_key: transaction.matchingKeys.billingRateKey,
    description_match_key: transaction.matchingKeys.descriptionMatchKey,
    site_material_key: transaction.matchingKeys.siteMaterialKey,
    invoice_rate_key: transaction.matchingKeys.invoiceRateKey,
    transaction_quantity: authoritativeNumber(transaction.quantity),
    extended_cost: authoritativeNumber(transaction.extendedCost),
    invoice_date: authoritativeString(transaction.occurredAt),
    source_sheet_name: transaction.sourceSheet ?? '',
    source_row_number: transaction.sourceRow ?? 0,
    // Raw observation retained verbatim so evidence stays traceable to source.
    record_json: transaction.rawRowEvidence as Record<string, unknown>,
    raw_row_json: transaction.rawRowEvidence as Record<string, unknown>,
    created_at: '',
  }));
}

/**
 * A deterministic, evidence-carrying canonical integrity signal.
 *
 * Signals are produced here, once, during the single assembly. The rule pack
 * that renders them makes no authority decision of its own — it maps a signal
 * to a finding. That keeps the "does this block clearance?" decision in the
 * authority layer while leaving exposure, reconciliation, and clearance
 * algorithms exactly where they already live.
 */
export type CanonicalIntegritySignal = {
  /** Stable across runs, so a persisted finding keeps its identity. */
  readonly signalKey: string;
  readonly kind:
    | 'invoice_identity_conflict'
    | 'invoice_line_identity_unresolved'
    | 'relationship_unresolved'
    | 'relationship_conflicting';
  readonly affectedDomain: CanonicalTruthDomain;
  /** True when the signal must prevent clearance of the affected domain. */
  readonly blocking: boolean;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly field: string | null;
  readonly expected: string;
  readonly actual: string;
  readonly detail: string;
  readonly evidence: readonly CanonicalFindingEvidence[];
};

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en-US');
}

/**
 * Projects canonical identity and relationship state into integrity signals.
 *
 * Every signal carries canonical provenance for each competing observation, so
 * a duplicate invoice number names both source documents and a conflicting
 * governing relationship names every candidate. Nothing is summarized away.
 */
export function projectCanonicalIntegritySignals(input: {
  readonly invoiceIdentities: readonly CanonicalInvoiceIdentity[];
  readonly invoiceIdentityConflicts: readonly CanonicalInvoiceIdentityConflict[];
  readonly invoiceLineIdentities: readonly CanonicalInvoiceLineIdentity[];
  readonly invoiceLineIdentityIssues: readonly CanonicalInvoiceLineIdentityIssue[];
  readonly relationships: readonly CanonicalRelationship[];
}): readonly CanonicalIntegritySignal[] {
  const signals: CanonicalIntegritySignal[] = [];
  const identityById = new Map(
    input.invoiceIdentities.map((identity) => [identity.canonicalInvoiceId, identity]),
  );

  for (const conflict of input.invoiceIdentityConflicts) {
    signals.push({
      signalKey: `canonical_invoice_identity:${conflict.conflictKey}`,
      kind: 'invoice_identity_conflict',
      affectedDomain: 'invoices',
      // Two documents claiming one invoice number makes every invoice-scoped
      // total ambiguous, so it must not clear.
      blocking: true,
      subjectType: 'invoice',
      subjectId: conflict.conflictKey,
      field: 'invoice_number',
      expected: 'one source document per invoice number',
      actual: `${String(conflict.sourceDocumentIds.length)} source documents claim ${conflict.invoiceNumber}`,
      detail: conflict.detail,
      // One evidence entry per competing source, so each stays traceable.
      evidence: conflict.canonicalInvoiceIds.map((invoiceId) => {
        const identity = identityById.get(invoiceId);
        return projectProvenanceEvidence({
          evidenceType: 'canonical_invoice_identity_conflict',
          recordId: invoiceId,
          fieldName: 'invoice_number',
          fieldValue: conflict.invoiceNumber,
          provenance: identity!.provenance,
          note: `Competing observation of invoice number ${conflict.invoiceNumber}.`,
        });
      }),
    });
  }

  const lineIdentityById = new Map(
    input.invoiceLineIdentities.map((identity) => [identity.canonicalLineId, identity]),
  );
  for (const issue of input.invoiceLineIdentityIssues) {
    signals.push({
      signalKey: `canonical_invoice_line_identity:${issue.issueKey}`,
      kind: 'invoice_line_identity_unresolved',
      affectedDomain: 'invoiceLines',
      // Unresolved line identity is reported, not blocking: the lines were
      // preserved distinctly, so no total is wrong — only unattributable.
      blocking: false,
      subjectType: 'invoice_line',
      subjectId: issue.issueKey,
      field: 'line_id',
      expected: 'deterministic source-backed line identity',
      actual: `${String(issue.canonicalLineIds.length)} line(s) with ${issue.reason}`,
      detail: issue.detail,
      evidence: issue.canonicalLineIds.map((lineId) => projectProvenanceEvidence({
        evidenceType: 'canonical_invoice_line_identity_unresolved',
        recordId: lineId,
        fieldName: 'line_id',
        fieldValue: lineId,
        provenance: lineIdentityById.get(lineId)!.provenance,
        note: `Line identity ${issue.reason}; the line was preserved, never merged.`,
      })),
    });
  }

  for (const relationship of input.relationships) {
    if (relationship.state === 'unresolved' && relationship.required) {
      signals.push({
        signalKey: `canonical_relationship:${relationship.relationshipId}:unresolved`,
        kind: 'relationship_unresolved',
        affectedDomain: relationship.affectedDomain,
        blocking: true,
        subjectType: 'document_relationship',
        subjectId: relationship.relationshipId,
        field: relationship.kind,
        expected: 'one established governing relationship',
        actual: 'no candidate could be established',
        detail: relationship.detail,
        evidence: [projectProvenanceEvidence({
          evidenceType: 'canonical_relationship_unresolved',
          recordId: relationship.relationshipId,
          fieldName: relationship.kind,
          fieldValue: relationship.from.id,
          provenance: relationship.provenance,
          note: 'Canonical authority left this relationship unresolved rather than selecting a governing source.',
        })],
      });
      continue;
    }
    if (relationship.state !== 'conflicting') continue;
    signals.push({
      signalKey: `canonical_relationship:${relationship.relationshipId}:conflicting`,
      kind: 'relationship_conflicting',
      affectedDomain: relationship.affectedDomain,
      // A conflicting governing candidate prevents clearance whether or not the
      // relationship is required: an unsettled conflict is never a pass.
      blocking: true,
      subjectType: 'document_relationship',
      subjectId: relationship.relationshipId,
      field: relationship.kind,
      expected: 'one governing candidate',
      actual: `${String(relationship.candidateIds.length)} competing candidates: ${relationship.candidateIds.join(', ')}`,
      detail: relationship.detail,
      // Every candidate is preserved as its own evidence entry; none is dropped
      // and none is promoted to a winner.
      evidence: relationship.candidateIds.map((candidateId) => projectProvenanceEvidence({
        evidenceType: 'canonical_relationship_conflict',
        recordId: `${relationship.relationshipId}:candidate:${candidateId}`,
        fieldName: relationship.kind,
        fieldValue: candidateId,
        provenance: relationship.provenance,
        note: `Competing ${relationship.kind} candidate for ${relationship.from.id}.`,
      })),
    });
  }

  return signals.sort((left, right) => compareText(left.signalKey, right.signalKey));
}
