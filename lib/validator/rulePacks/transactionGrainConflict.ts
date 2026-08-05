/**
 * Surfaces canonical ticket-grain conflicts as operator-visible findings.
 *
 * A repeated-ticket disagreement detected during canonical assembly must not
 * stay a registry-only diagnostic. This pack turns each conflict into a
 * deterministic finding using the existing finding and evidence models, so the
 * conflict reaches exposure, clearance, and the operator surfaces that already
 * consume findings. No separate conflict UI system is introduced.
 *
 * The pack does not resolve anything. Both conflicting observations are carried
 * into the evidence verbatim; no winner is chosen and no reconciled value is
 * invented. The affected quantity or amount therefore cannot be treated as
 * authoritative while the conflict stands.
 */

import { makeFinding, type ProjectValidatorInput, type ValidatorFindingResult } from '@/lib/validator/shared';

export const PACK_TRANSACTION_GRAIN_CONFLICT = 'transaction_grain_conflict';
export const RULE_TRANSACTION_GRAIN_CONFLICT = 'TRANSACTION_TICKET_GRAIN_CONFLICT';

/**
 * Conflict classification.
 *
 * A quantity or amount disagreement blocks transaction truth: every ticket-grain
 * total that would consume it is unsafe, so this is `blocking`. Anything else is
 * surfaced for review without blocking. Severity uses `critical` with a blocked
 * reason, matching how the authored-rate-row quarantine expresses a blocking
 * data-integrity defect in this repository.
 */
function isBlockingField(field: 'quantity' | 'extendedCost'): boolean {
  return field === 'quantity' || field === 'extendedCost';
}

function fieldLabel(field: 'quantity' | 'extendedCost'): string {
  return field === 'quantity' ? 'transaction_quantity' : 'extended_cost';
}

export function runTransactionGrainConflictRules(
  input: ProjectValidatorInput,
): ValidatorFindingResult[] {
  const projection = input.projectTruthAuthority?.validatorProjection;
  // Legacy mode has no canonical conflict detection, so this pack contributes
  // nothing and legacy behavior is unchanged.
  if (projection == null) return [];

  const conflicts = projection.transactions.grainConflicts;
  if (conflicts.length === 0) return [];

  // Index the projected rows so evidence can cite each conflicting observation
  // with its own source document, sheet, and row.
  const rowsById = new Map(projection.transactions.rows.map((row) => [row.transactionId, row]));

  return conflicts.map((conflict) => {
    const observed = conflict.observedValues;
    const label = fieldLabel(conflict.field);

    // One evidence entry per conflicting observation, so both survive and each
    // stays traceable to its own source row rather than being summarized away.
    const evidence = conflict.rowIds.map((rowId) => {
      const row = rowsById.get(rowId);
      const value = row == null
        ? null
        : conflict.field === 'quantity'
          ? row.quantity.value
          : row.extendedCost.value;
      return {
        evidence_type: 'canonical_transaction_grain_conflict',
        source_document_id: row?.sourceDocumentId ?? null,
        source_page: null,
        record_id: rowId,
        field_name: label,
        field_value: value,
        note:
          `Ticket-grain identity ${conflict.identity} observed ${label} `
          + `${String(value)} at sheet ${row?.sourceSheet ?? 'unknown'} row `
          + `${String(row?.sourceRow ?? 'unknown')}.`,
      };
    });

    return makeFinding({
      projectId: input.project.id,
      ruleId: RULE_TRANSACTION_GRAIN_CONFLICT,
      category: 'financial_integrity',
      severity: 'critical',
      subjectType: 'transaction',
      // Deterministic finding identity: derived from the stable conflict key, so
      // repeated runs produce the same finding rather than a new one each time.
      subjectId: conflict.conflictKey,
      field: label,
      expected: 'one agreed ticket-grain value per transaction identity',
      actual: `${String(observed.length)} conflicting values: ${observed.join(', ')}`,
      blockedReason: isBlockingField(conflict.field)
        ? `Ticket-grain ${label} conflict for ${conflict.identity}: `
          + `${observed.join(' vs ')}. Canonical authority does not select a winner; `
          + 'resolve the source disagreement.'
        : undefined,
      decisionEligible: true,
      actionEligible: true,
      evidence,
    });
  });
}
