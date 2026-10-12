/**
 * Human classification of a Validator rule semantics review (B6.4). Client-safe.
 *
 * A `rule_semantics_review` friction signal arrives in the Improvement
 * Orchestrator with its defect class `undetermined`. EightForge never decides
 * whether the deficiency is in the wording or in the rule logic, and no AI
 * decides it either: a person must choose before the request can be submitted.
 */

export const SEMANTICS_DEFECT_CLASSES = ['wording', 'rule_logic'] as const;
export type SemanticsDefectClass = (typeof SEMANTICS_DEFECT_CLASSES)[number];

/** The prefill query parameter and its only value: the classification is still owed. */
export const SEMANTICS_DEFECT_CLASS_PARAM = 'defectClass';
export const SEMANTICS_DEFECT_CLASS_UNDETERMINED = 'undetermined';

export const SEMANTICS_DEFECT_CLASS_LABEL: Readonly<Record<SemanticsDefectClass, string>> = {
  wording: 'Wording defect (explanation or action text is incomplete, stale or misleading)',
  rule_logic: 'Rule-logic defect (the rule fires when it should not, or compares the wrong thing)',
};

export function isSemanticsDefectClass(value: unknown): value is SemanticsDefectClass {
  return typeof value === 'string' && (SEMANTICS_DEFECT_CLASSES as readonly string[]).includes(value);
}

/** The submitted question carries the person's classification, stated as theirs. */
export function withHumanDefectClass(question: string, defectClass: SemanticsDefectClass): string {
  return `${question.trimEnd()}\n\nHuman classification: ${SEMANTICS_DEFECT_CLASS_LABEL[defectClass]}.`;
}
