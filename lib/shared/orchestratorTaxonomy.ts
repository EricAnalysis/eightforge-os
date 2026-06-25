export const ORCHESTRATOR_ROOT_CAUSE_CATEGORIES = [
  { key: 'extraction_issue', label: 'Extraction Issue' },
  { key: 'ocr_corruption', label: 'OCR Corruption' },
  { key: 'mapping_issue', label: 'Mapping Issue' },
  { key: 'canonical_persistence_issue', label: 'Canonical Persistence Issue' },
  { key: 'ui_consumption_issue', label: 'UI Consumption Issue' },
  { key: 'duplicate_derivation_issue', label: 'Duplicate Derivation Issue' },
  { key: 'lifecycle_coupling_issue', label: 'Lifecycle Coupling Issue' },
  { key: 'validation_rule_issue', label: 'Validation Rule Issue' },
  { key: 'operator_review_persistence_issue', label: 'Operator Review Persistence Issue' },
  { key: 'state_synchronization_issue', label: 'State Synchronization Issue' },
  { key: 'totals_reconciliation_issue', label: 'Totals Reconciliation Issue' },
  { key: 'evidence_trace_issue', label: 'Evidence Trace Issue' },
  { key: 'performance_issue', label: 'Performance Issue' },
  { key: 'relationship_governance_issue', label: 'Relationship Governance Issue' },
] as const;

export type OrchestratorRootCauseCategoryKey =
  (typeof ORCHESTRATOR_ROOT_CAUSE_CATEGORIES)[number]['key'];

export function getOrchestratorRootCauseCategory(
  key: string | null | undefined,
): (typeof ORCHESTRATOR_ROOT_CAUSE_CATEGORIES)[number] | null {
  if (!key) return null;
  return ORCHESTRATOR_ROOT_CAUSE_CATEGORIES.find((category) => category.key === key) ?? null;
}

export function isOrchestratorRootCauseCategoryKey(
  key: string | null | undefined,
): key is OrchestratorRootCauseCategoryKey {
  return getOrchestratorRootCauseCategory(key) != null;
}
