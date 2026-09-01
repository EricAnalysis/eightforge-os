// lib/workflowReviewedSpecification.ts
// Typed reviewed-specification shapes, one per classification.
//
// Pure by construction: this imports zod and nothing else, so the review UI can
// render typed forms from the same schemas the server validates against. It
// lived under lib/server until a UI actually needed it; nothing was made
// "shared" before there was a second consumer.
//
// `accepted_specification` is jsonb in the database, which keeps the column
// versionable — but an operator must never hand the server an arbitrary object.
// The UI edits typed fields, the server validates them against these schemas,
// and the persisted JSON is constructed deterministically from the parsed
// result. The database is never asked to accept whatever was typed.
//
//   typed review form -> strict server schema
//     -> deterministically constructed acceptedSpecification -> immutable row
//
// The field names deliberately mirror the assessment's own proposal detail
// schemas rather than inventing a parallel vocabulary. A reviewed RULE and a
// proposed RULE then describe the same thing in the same words, which is what
// makes "what did the operator actually change?" answerable by comparing fields
// instead of prose.

import { z } from 'zod';

/**
 * The rule-condition vocabulary, restated rather than imported.
 *
 * The proposal side owns this list, and an architecture guard confines that
 * module to its two named production consumers. Importing it here to save six
 * lines would widen that seal for a vocabulary constant, which is a bad trade.
 * Restating it does not create a second source of truth either: the companion
 * test imports the proposal list and asserts the two are identical, so drift
 * fails loudly instead of silently. That test has already caught one.
 */
export const WORKFLOW_REVIEWED_CONDITION_TYPES = [
  'comparison', 'calculation', 'presence_check', 'date_range',
  'identity_match', 'duplicate_detection', 'precedence',
] as const;

/** Same bounds as the proposal side, so a refinement cannot exceed a proposal. */
const text = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, maxItems: number) =>
  z.array(text(max)).min(1).max(maxItems);
const optionalList = (max: number, maxItems: number) =>
  z.array(text(max)).max(maxItems);

/**
 * RULE and VERIFY share the proposal's rule shape.
 *
 * There is no field for code, an expression, SQL, or a query — the same
 * omission the proposal schema makes. A reviewed RULE is a specification an
 * operator approved, not a runtime artifact, and the absence of an executable
 * field is what keeps that true structurally rather than by convention.
 */
const reviewedRuleSpecification = z.object({
  plainLanguageRule: text(600),
  requiredFacts: list(200, 12),
  conditionType: z.enum(WORKFLOW_REVIEWED_CONDITION_TYPES),
  expectedEvidence: list(200, 12),
  expectedOutcome: text(400),
  userDescribedExceptions: optionalList(300, 12),
  unresolvedAssumptions: optionalList(300, 12),
}).strict();

const reviewedExtractionSpecification = z.object({
  describedFact: text(300),
  sourceDocument: text(200),
  deterministicExtractionPlausible: z.boolean(),
}).strict();

const reviewedRecoverySpecification = z.object({
  describedFact: text(300),
  sourceDocument: text(200),
  description: text(400),
  deterministicShortfall: text(400),
}).strict();

const reviewedHumanSpecification = z.object({
  description: text(400),
  whyHumanControlled: text(400),
}).strict();

const reviewedAdvisorySpecification = z.object({
  description: text(400),
}).strict();

/**
 * The schema that applies depends on the classification the operator settled
 * on — the reviewed classification, not the proposed one. Downgrading a RULE to
 * HUMAN means the refined specification must be a human-decision specification;
 * accepting the rule shape there would let a rejected automation survive as one.
 */
export const REVIEWED_SPECIFICATION_SCHEMAS = {
  RULE: reviewedRuleSpecification,
  VERIFY: reviewedRuleSpecification,
  EXTRACT: reviewedExtractionSpecification,
  RECOVER: reviewedRecoverySpecification,
  HUMAN: reviewedHumanSpecification,
  ADVISORY: reviewedAdvisorySpecification,
} as const;

export type ReviewedClassification = keyof typeof REVIEWED_SPECIFICATION_SCHEMAS;

export type ReviewedSpecification =
  | z.infer<typeof reviewedRuleSpecification>
  | z.infer<typeof reviewedExtractionSpecification>
  | z.infer<typeof reviewedRecoverySpecification>
  | z.infer<typeof reviewedHumanSpecification>
  | z.infer<typeof reviewedAdvisorySpecification>;

/**
 * How the review UI renders each field.
 *
 * Kept beside the schemas rather than in the UI so the form and the validator
 * cannot describe different shapes. The companion test asserts these descriptor
 * names match each schema's keys exactly, so adding a schema field without a
 * form control — or the reverse — fails loudly.
 *
 * There is no descriptor kind for code, SQL, or an expression, because no
 * schema has such a field. The form cannot offer what the contract refuses.
 */
export type ReviewedFieldKind = 'text' | 'paragraph' | 'list' | 'choice' | 'boolean';

export type ReviewedFieldDescriptor = Readonly<{
  name: string;
  label: string;
  kind: ReviewedFieldKind;
  /** Present only for 'choice'. */
  options?: readonly string[];
  optional?: boolean;
}>;

const RULE_FIELDS: readonly ReviewedFieldDescriptor[] = [
  { name: 'plainLanguageRule', label: 'Rule in plain language', kind: 'paragraph' },
  { name: 'requiredFacts', label: 'Required facts', kind: 'list' },
  { name: 'conditionType', label: 'Condition type', kind: 'choice',
    options: WORKFLOW_REVIEWED_CONDITION_TYPES },
  { name: 'expectedEvidence', label: 'Expected evidence', kind: 'list' },
  { name: 'expectedOutcome', label: 'Expected outcome', kind: 'paragraph' },
  { name: 'userDescribedExceptions', label: 'Exceptions described by the user',
    kind: 'list', optional: true },
  { name: 'unresolvedAssumptions', label: 'Unresolved assumptions',
    kind: 'list', optional: true },
];

export const REVIEWED_SPECIFICATION_FIELDS: Readonly<
  Record<ReviewedClassification, readonly ReviewedFieldDescriptor[]>
> = {
  RULE: RULE_FIELDS,
  VERIFY: RULE_FIELDS,
  EXTRACT: [
    { name: 'describedFact', label: 'Fact to extract', kind: 'paragraph' },
    { name: 'sourceDocument', label: 'Source document', kind: 'text' },
    { name: 'deterministicExtractionPlausible',
      label: 'Deterministic extraction plausible', kind: 'boolean' },
  ],
  RECOVER: [
    { name: 'describedFact', label: 'Fact to recover', kind: 'paragraph' },
    { name: 'sourceDocument', label: 'Source document', kind: 'text' },
    { name: 'description', label: 'Recovery need', kind: 'paragraph' },
    { name: 'deterministicShortfall', label: 'Why deterministic extraction is insufficient',
      kind: 'paragraph' },
  ],
  HUMAN: [
    { name: 'description', label: 'Decision required', kind: 'paragraph' },
    { name: 'whyHumanControlled', label: 'Why human authority is required',
      kind: 'paragraph' },
  ],
  ADVISORY: [
    { name: 'description', label: 'Advisory purpose', kind: 'paragraph' },
  ],
};

export type ReviewedSpecificationResult =
  | Readonly<{ ok: true; specification: Record<string, unknown> }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Validates a reviewed specification and returns the object to persist.
 *
 * The returned value is rebuilt from the parsed result, never passed through
 * from the request: unknown keys are rejected by `.strict()`, and what reaches
 * the database is only what these schemas describe.
 */
export function buildReviewedSpecification(
  classification: ReviewedClassification,
  input: unknown,
): ReviewedSpecificationResult {
  const schema = REVIEWED_SPECIFICATION_SCHEMAS[classification];
  if (!schema) return { ok: false, reason: 'unknown_classification' };

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    // Field paths only. Reviewer prose describes a visitor's business process
    // and is never echoed back through an error.
    return {
      ok: false,
      reason: parsed.error.issues.map((issue) => issue.path.join('.')).join(',')
        || 'invalid_specification',
    };
  }

  return { ok: true, specification: { ...parsed.data } as Record<string, unknown> };
}
