/**
 * The triage contract for improvement signals (B8.3c), shared by the trusted
 * server and the triage page. Client-safe: vocabulary and cross-field rules
 * only. The database enforces the same rules (improvement_signal_triage_reviews).
 */

export const TRIAGE_DISPOSITIONS = ['route_to_engineering', 'customer_config_or_mapping', 'reject', 'defer'] as const;
export type TriageDisposition = (typeof TRIAGE_DISPOSITIONS)[number];
/** The engineering-review scope vocabulary, reused. */
export const TRIAGE_CAPABILITY_SCOPES = ['client_specific', 'workflow_specific', 'reusable_platform_capability'] as const;
export type TriageCapabilityScope = (typeof TRIAGE_CAPABILITY_SCOPES)[number];
export const TRIAGE_SEMANTICS_DEFECT_CLASSES = ['wording_defect', 'rule_logic_defect'] as const;
export type TriageSemanticsDefectClass = (typeof TRIAGE_SEMANTICS_DEFECT_CLASSES)[number];

/**
 * The repository-plan classification a reviewer chooses for a signal routed to
 * engineering (B8.3d). A human decision: never derived from the signal kind or
 * its root-cause category. The Plan V2 vocabulary, unchanged.
 */
export const TRIAGE_PLAN_CLASSIFICATIONS = ['RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY'] as const;
export type TriagePlanClassification = (typeof TRIAGE_PLAN_CLASSIFICATIONS)[number];

const ROUTED: ReadonlySet<TriageDisposition> = new Set(['route_to_engineering', 'customer_config_or_mapping']);

/** A routed signal names its scope. */
export function triageRequiresScope(disposition: TriageDisposition): boolean {
  return ROUTED.has(disposition);
}

/** A routed rule semantics review carries the human defect classification; nothing else may. */
export function triageRequiresDefectClass(signalKind: string, disposition: TriageDisposition): boolean {
  return ROUTED.has(disposition) && signalKind === 'rule_semantics_review';
}

/** Routed to engineering exactly when a reviewer chose the Plan V2 classification. */
export function triageRequiresPlanClassification(disposition: TriageDisposition): boolean {
  return disposition === 'route_to_engineering';
}

/** The first cross-field violation, or null. */
export function triageShapeError(params: Readonly<{
  signalKind: string;
  disposition: TriageDisposition;
  capabilityScope: string | null;
  semanticsDefectClass: string | null;
  planClassification: string | null;
}>): string | null {
  const scopeRequired = triageRequiresScope(params.disposition);
  if (scopeRequired && params.capabilityScope == null) return 'capability_scope_required';
  if (!scopeRequired && params.capabilityScope != null) return 'capability_scope_not_allowed';
  const classRequired = triageRequiresDefectClass(params.signalKind, params.disposition);
  if (classRequired && params.semanticsDefectClass == null) return 'semantics_defect_class_required';
  if (!classRequired && params.semanticsDefectClass != null) return 'semantics_defect_class_not_allowed';
  const planRequired = triageRequiresPlanClassification(params.disposition);
  if (planRequired && params.planClassification == null) return 'plan_classification_required';
  if (!planRequired && params.planClassification != null) return 'plan_classification_not_allowed';
  return null;
}
