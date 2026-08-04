/**
 * Canonical pricing boundary harness — EVALUATION ONLY.
 *
 * Captures pricing rows at every boundary between source extraction and
 * canonical resolution, and attributes every row that does not survive a
 * boundary to a rejection reason.
 *
 * Hard constraints:
 *   - Imported by NO production module. Only tests and scripts may use it.
 *   - Changes no production behaviour. It calls existing functions and
 *     observes their outputs; it never patches, wraps, or re-implements them.
 *   - Rejection REASONS are derived by evaluating the documented predicate
 *     conditions read-only against a row's own values. They are an
 *     attribution model, not instrumentation of the real functions, and are
 *     labelled as such in the output (`reasonBasis`).
 *
 * Comparison identity never uses a volatile canonical id alone. See
 * `boundaryIdentity`.
 */

import { assembleContractPricingRows, type ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { ContractRateScheduleRow } from '@/lib/contracts/types';
import {
  adaptAssembledPricingRows,
  type ContractPricingAdapterContext,
} from '@/lib/canonical/contract/pricingAdapter';
import {
  buildCanonicalPricingSchedule,
  resolveCanonicalPricingRow,
} from '@/lib/canonical/contract/pricingResolution';
import type {
  CanonicalContractPricingCandidate,
  CanonicalContractPricingRow,
  CanonicalContractPricingSchedule,
} from '@/lib/canonical/contract/pricing';

// ─── Stable comparison identity ──────────────────────────────────────────────

export type BoundaryIdentity = {
  /** Human-readable composite key. Stable across boundaries. */
  readonly key: string;
  readonly documentId: string | null;
  readonly sourceAnchor: string | null;
  readonly page: number | null;
  readonly normalizedDescription: string | null;
  readonly unit: string | null;
  readonly rate: number | null;
  readonly rateCode: string | null;
  /** The upstream row id, retained for traceability but never the sole key. */
  readonly upstreamRowId: string | null;
};

function normalizeDescriptionForIdentity(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function identityKey(parts: Omit<BoundaryIdentity, 'key'>): string {
  return [
    parts.documentId ?? '-',
    parts.page ?? '-',
    parts.sourceAnchor ?? '-',
    parts.normalizedDescription ?? '-',
    parts.unit ?? '-',
    parts.rate ?? '-',
    parts.rateCode ?? '-',
  ].join('|');
}

export function rateScheduleRowIdentity(
  row: ContractRateScheduleRow,
  documentId: string | null,
): BoundaryIdentity {
  const parts = {
    documentId,
    sourceAnchor: (row.source_anchor_ids ?? []).find((a) => a && a.trim().length > 0) ?? null,
    page: typeof row.page === 'number' && Number.isFinite(row.page) ? row.page : null,
    normalizedDescription: normalizeDescriptionForIdentity(row.description ?? row.rate_raw),
    unit: row.unit ?? row.unit_type ?? null,
    rate: row.rate_amount ?? row.rate ?? null,
    rateCode: null,
    upstreamRowId: row.row_id ?? null,
  };
  return { key: identityKey(parts), ...parts };
}

export function assemblyRowIdentity(
  row: ContractPricingAssemblyRow,
  documentId: string | null,
): BoundaryIdentity {
  const parts = {
    documentId,
    sourceAnchor: row.sourceAnchor ?? null,
    page: row.page ?? null,
    normalizedDescription: normalizeDescriptionForIdentity(row.description ?? row.rawText),
    unit: row.unit ?? null,
    rate: row.rate ?? null,
    rateCode: null,
    upstreamRowId: row.id ?? null,
  };
  return { key: identityKey(parts), ...parts };
}

export function candidateIdentity(
  candidate: CanonicalContractPricingCandidate,
  documentId: string | null,
): BoundaryIdentity {
  const parts = {
    documentId: candidate.governingDocument?.documentId ?? documentId,
    sourceAnchor: candidate.evidence[0]?.sourceAnchor ?? null,
    page: candidate.evidence[0]?.page ?? null,
    normalizedDescription: candidate.normalizedDescription,
    unit: candidate.unit,
    rate: candidate.rate,
    rateCode: candidate.rateCode,
    upstreamRowId: candidate.candidateId,
  };
  return { key: identityKey(parts), ...parts };
}

// ─── Rejection ledger ────────────────────────────────────────────────────────

export type RejectionReason =
  | 'missing_page'
  | 'missing_description'
  | 'missing_unit'
  | 'missing_rate'
  | 'invalid_rate'
  | 'category_unresolved'
  | 'duplicate_content_key'
  | 'trusted_coverage_suppression'
  | 'trusted_description_slot_suppression'
  | 'junk_or_non_pricing'
  | 'source_quality_rejection'
  | 'authored_row_quarantine'
  | 'unsupported_shape'
  | 'unknown';

export type RejectionBoundary =
  | 'assembler_map_phase'
  | 'assembler_selection_phase'
  | 'assembler_merge_phase'
  | 'canonical_adapter'
  | 'canonical_resolution';

export type RejectionRecord = {
  readonly identity: BoundaryIdentity;
  readonly boundary: RejectionBoundary;
  /** Documented function believed responsible. Attribution, not instrumentation. */
  readonly rejectingFunction: string;
  readonly reason: RejectionReason;
  /** How the reason was determined. */
  readonly reasonBasis: 'observed_merge_diagnostic' | 'derived_from_documented_predicate';
  readonly rawValues: {
    readonly description: string | null;
    readonly unit: string | null;
    readonly rate: number | null;
    readonly category: string | null;
    readonly page: number | null;
    readonly rawText: string | null;
  };
  readonly sourceDocumentId: string | null;
  /** True when a surviving row carries a mergeDiagnostic naming this row. */
  readonly referencedBySurvivingMergeDiagnostic: boolean;
  /** True when any evidence for this row remains reachable in the output. */
  readonly evidenceDiscoverableElsewhere: boolean;
  /** True when canonical output could reconstruct the row after rejection. */
  readonly canonicalRecoveryPossible: boolean;
};

/**
 * Attribute a rejection reason by evaluating the documented predicate
 * conditions of `shouldKeepOperatorRow` / the map phase against the row's own
 * values, in the documented evaluation order.
 *
 * This mirrors conditions recorded in
 * `docs/audits/canonical-pricing-domain-slice-2026-08-01.md` §13. It does not
 * execute or modify the real functions.
 */
function attributeRejectionReason(row: ContractRateScheduleRow): {
  reason: RejectionReason;
  boundary: RejectionBoundary;
  rejectingFunction: string;
} {
  const description = row.description ?? row.rate_raw ?? null;
  const rate = row.rate_amount ?? row.rate ?? null;
  const unit = row.unit ?? row.unit_type ?? null;
  const page = typeof row.page === 'number' && Number.isFinite(row.page) ? row.page : null;
  const hasRawText = typeof row.rate_raw === 'string' && row.rate_raw.trim().length > 0;

  if (!description && rate == null && !hasRawText) {
    return {
      reason: 'missing_description',
      boundary: 'assembler_map_phase',
      rejectingFunction: 'assembleContractPricingRows map phase (:2076)',
    };
  }
  if (rate != null && !Number.isFinite(rate)) {
    return {
      reason: 'invalid_rate',
      boundary: 'assembler_map_phase',
      rejectingFunction: 'assembleContractPricingRows map phase',
    };
  }
  if (page == null) {
    return {
      reason: 'missing_page',
      boundary: 'assembler_selection_phase',
      rejectingFunction: 'shouldKeepOperatorRow (:1656)',
    };
  }
  if (!unit) {
    return {
      reason: 'missing_unit',
      boundary: 'assembler_selection_phase',
      rejectingFunction: 'shouldKeepOperatorRow (:1656)',
    };
  }
  if (rate == null) {
    return {
      reason: 'missing_rate',
      boundary: 'assembler_selection_phase',
      rejectingFunction: 'shouldKeepOperatorRow (:1657)',
    };
  }
  if (!row.category) {
    return {
      reason: 'category_unresolved',
      boundary: 'assembler_selection_phase',
      rejectingFunction: 'shouldKeepOperatorRow (:1645) / uncategorized drop (:1758-1768)',
    };
  }
  return {
    reason: 'unknown',
    boundary: 'assembler_selection_phase',
    rejectingFunction: 'shouldKeepOperatorRow (unattributed predicate)',
  };
}

// ─── Boundary capture ────────────────────────────────────────────────────────

export type PricingBoundaryCounts = {
  readonly sourceTables: number;
  readonly sourceTableRows: number;
  readonly rateScheduleRows: number;
  readonly assemblerInputs: number;
  readonly assemblerOutputs: number;
  readonly rowsMergedOrDeduped: number;
  readonly rowsSilentlyLost: number;
  readonly canonicalCandidates: number;
  readonly resolvedPricing: number;
  readonly needsReview: number;
  readonly excluded: number;
  readonly approvalEligible: number;
  readonly approvalIneligible: number;
};

export type PricingBoundaryReport = {
  readonly fixtureId: string;
  readonly documentId: string;
  readonly counts: PricingBoundaryCounts;
  readonly rateScheduleRows: readonly ContractRateScheduleRow[];
  readonly assemblyRows: readonly ContractPricingAssemblyRow[];
  readonly candidates: readonly CanonicalContractPricingCandidate[];
  readonly schedule: CanonicalContractPricingSchedule;
  readonly rejections: readonly RejectionRecord[];
  readonly mergeSuppressed: readonly RejectionRecord[];
};

export type RunPricingBoundariesInput = {
  readonly fixtureId: string;
  readonly documentId: string;
  /** Rows entering `assembleContractPricingRows` (boundary 3). */
  readonly rateScheduleRows: readonly ContractRateScheduleRow[];
  /** Optional counts from boundary 1, when the caller extracted a PDF. */
  readonly sourceTables?: number;
  readonly sourceTableRows?: number;
  readonly adapterContext?: ContractPricingAdapterContext;
};

/**
 * Run boundaries 3 → 8 and build the rejection ledger.
 *
 * Survivorship is determined by identity match, not by canonical id. A row
 * that does not appear in the assembler output is then SOLO-PROBED: running it
 * alone through the assembler distinguishes
 *   - "rejected by a filter"          (does not survive alone), from
 *   - "suppressed by merge/dedupe"    (survives alone, lost in the set).
 * This uses only the public function and changes nothing.
 */
export function runPricingBoundaries(
  input: RunPricingBoundariesInput,
): PricingBoundaryReport {
  const documentId = input.documentId;
  const inputRows = [...input.rateScheduleRows];

  const assemblyRows = assembleContractPricingRows(inputRows);
  const survivingKeys = new Set(
    assemblyRows.map((row) => assemblyRowIdentity(row, documentId).key),
  );
  const survivingUpstreamIds = new Set(assemblyRows.map((row) => row.id));

  const allMergeDiagnostics = assemblyRows.flatMap((row) => row.mergeDiagnostics ?? []);
  const mergeDroppedIds = new Set(allMergeDiagnostics.map((d) => d.droppedRowId));

  const rejections: RejectionRecord[] = [];
  const mergeSuppressed: RejectionRecord[] = [];

  for (const row of inputRows) {
    const identity = rateScheduleRowIdentity(row, documentId);
    // Survivorship prefers the EXACT upstream row id, because the assembler
    // carries `row_id` through to `ContractPricingAssemblyRow.id`. Content
    // identity is only a fallback: two content-identical rows share a key, so
    // keying on content alone would let a survivor mask a dropped duplicate.
    if (row.row_id) {
      if (survivingUpstreamIds.has(row.row_id)) continue;
    } else if (survivingKeys.has(identity.key)) {
      continue;
    }

    const referencedByMerge = row.row_id != null && mergeDroppedIds.has(row.row_id);
    const rawValues = {
      description: row.description ?? null,
      unit: row.unit ?? row.unit_type ?? null,
      rate: row.rate_amount ?? row.rate ?? null,
      category: row.category ?? null,
      page: typeof row.page === 'number' && Number.isFinite(row.page) ? row.page : null,
      rawText: row.rate_raw ?? null,
    };

    if (referencedByMerge) {
      const diagnostic = allMergeDiagnostics.find((d) => d.droppedRowId === row.row_id);
      mergeSuppressed.push({
        identity,
        boundary: 'assembler_merge_phase',
        rejectingFunction: 'selectOperatorFacingRows (:1710-1746)',
        reason:
          diagnostic?.reason === 'trusted_coverage_suppression'
            ? 'trusted_coverage_suppression'
            : diagnostic?.reason === 'trusted_description_slot_suppression'
              ? 'trusted_description_slot_suppression'
              : 'duplicate_content_key',
        reasonBasis: 'observed_merge_diagnostic',
        rawValues,
        sourceDocumentId: documentId,
        referencedBySurvivingMergeDiagnostic: true,
        evidenceDiscoverableElsewhere: true,
        canonicalRecoveryPossible: false,
      });
      continue;
    }

    // Solo probe: does this row survive the assembler on its own?
    const solo = assembleContractPricingRows([row]);
    if (solo.length > 0) {
      // Survives alone but not in the set, and no diagnostic names it.
      mergeSuppressed.push({
        identity,
        boundary: 'assembler_merge_phase',
        rejectingFunction: 'selectOperatorFacingRows (undiagnosed suppression)',
        reason: 'duplicate_content_key',
        reasonBasis: 'derived_from_documented_predicate',
        rawValues,
        sourceDocumentId: documentId,
        referencedBySurvivingMergeDiagnostic: false,
        evidenceDiscoverableElsewhere: false,
        canonicalRecoveryPossible: false,
      });
      continue;
    }

    const attribution = attributeRejectionReason(row);
    rejections.push({
      identity,
      boundary: attribution.boundary,
      rejectingFunction: attribution.rejectingFunction,
      reason: attribution.reason,
      reasonBasis: 'derived_from_documented_predicate',
      rawValues,
      sourceDocumentId: documentId,
      referencedBySurvivingMergeDiagnostic: false,
      evidenceDiscoverableElsewhere: false,
      canonicalRecoveryPossible: false,
    });
  }

  const candidates = adaptAssembledPricingRows(assemblyRows, input.adapterContext ?? {
    documentId,
    governingDocument: { documentId, family: 'contract', title: input.fixtureId },
  });
  const rows: CanonicalContractPricingRow[] = candidates.map((candidate) =>
    resolveCanonicalPricingRow(candidate),
  );
  const schedule = buildCanonicalPricingSchedule({ rows });

  const approvalEligible = rows.filter((row) => row.resolution.approval.eligible).length;

  return {
    fixtureId: input.fixtureId,
    documentId,
    counts: {
      sourceTables: input.sourceTables ?? 0,
      sourceTableRows: input.sourceTableRows ?? 0,
      rateScheduleRows: inputRows.length,
      assemblerInputs: inputRows.length,
      assemblerOutputs: assemblyRows.length,
      rowsMergedOrDeduped: mergeSuppressed.length,
      rowsSilentlyLost: rejections.length,
      canonicalCandidates: candidates.length,
      resolvedPricing: schedule.coverage.resolvedCount,
      needsReview: schedule.coverage.needsReviewCount,
      excluded: schedule.coverage.excludedCount,
      approvalEligible,
      approvalIneligible: rows.length - approvalEligible,
    },
    rateScheduleRows: inputRows,
    assemblyRows,
    candidates,
    schedule,
    rejections,
    mergeSuppressed,
  };
}

/** Compact, deterministic summary suitable for a report table. */
export function summarizeBoundaryReport(report: PricingBoundaryReport): string {
  const c = report.counts;
  return JSON.stringify({
    fixture: report.fixtureId,
    sourceTables: c.sourceTables,
    sourceTableRows: c.sourceTableRows,
    rateScheduleRows: c.rateScheduleRows,
    assemblerOutputs: c.assemblerOutputs,
    mergedOrDeduped: c.rowsMergedOrDeduped,
    silentlyLost: c.rowsSilentlyLost,
    candidates: c.canonicalCandidates,
    resolved: c.resolvedPricing,
    needsReview: c.needsReview,
    excluded: c.excluded,
    approvalEligible: c.approvalEligible,
    rejectionReasons: tallyReasons(report.rejections),
    suppressionReasons: tallyReasons(report.mergeSuppressed),
  });
}

export function tallyReasons(
  records: readonly RejectionRecord[],
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const record of records) {
    tally[record.reason] = (tally[record.reason] ?? 0) + 1;
  }
  return tally;
}
