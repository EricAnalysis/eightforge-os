import { z } from 'zod';

import { WorkflowAssessmentModelOutputSchema } from '@/lib/workflowAssessmentSchema';

/**
 * The Workflow Assessment field contract, derived from the strict validator.
 *
 * D1 moved the assessment into a single-string `assessmentJson` envelope, so the
 * provider grammar no longer enforces field types or bounds. The prompt must
 * therefore state them. This text is generated from
 * WorkflowAssessmentModelOutputSchema and embedded verbatim in
 * prompts/workflowAssessment.md between the markers below; a test fails if the
 * prompt and the schema ever disagree. The schema remains the only validator:
 * this text informs the model, it never relaxes or replaces validation.
 */
export const WORKFLOW_ASSESSMENT_FIELD_CONTRACT_BEGIN = '<!-- workflow-assessment-field-contract:begin -->';
export const WORKFLOW_ASSESSMENT_FIELD_CONTRACT_END = '<!-- workflow-assessment-field-contract:end -->';

/**
 * D4: a writing target below every hard string limit. D3 run 1 still overran three
 * limits by 3-31% after the limits were stated, so each string also carries a target
 * of 85% of its maximum. The target is guidance only; the validator still enforces
 * exactly the schema maximum.
 */
export const WORKFLOW_ASSESSMENT_WRITING_TARGET_RATIO = 0.85;

export function workflowAssessmentWritingTarget(max: number): number {
  return Math.floor(max * WORKFLOW_ASSESSMENT_WRITING_TARGET_RATIO);
}

type Line = Readonly<{ path: string; fields: string[] }>;

function count(min: number | null, max: number | null): string {
  if (max === null) throw new Error('field_contract_unbounded_array');
  return `${min ?? 0}-${max}`;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  // Refinements (whitespace checks) wrap the underlying type without changing it.
  let current = schema;
  while (current instanceof z.ZodEffects) current = current._def.schema;
  return current;
}

function describe(schema: z.ZodTypeAny, path: string, lines: Line[]): string {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodNullable) {
    return `${describe(inner._def.innerType, path, lines)} or null`;
  }
  if (inner instanceof z.ZodString) {
    let min: number | null = null;
    let max: number | null = null;
    for (const check of inner._def.checks) {
      if (check.kind === 'min') min = check.value;
      else if (check.kind === 'max') max = check.value;
      else throw new Error(`field_contract_unsupported_string_check:${check.kind}`);
    }
    if (max === null) throw new Error('field_contract_unbounded_string');
    return `string(${min ?? 0}-${max}, aim ≤${workflowAssessmentWritingTarget(max)})`;
  }
  if (inner instanceof z.ZodBoolean) return 'boolean';
  if (inner instanceof z.ZodEnum) return `enum(${(inner._def.values as string[]).join('|')})`;
  if (inner instanceof z.ZodLiteral) {
    const value = inner._def.value as unknown;
    if (typeof value !== 'boolean' && typeof value !== 'string') throw new Error(`field_contract_unsupported_literal:${path}`);
    return `const(${JSON.stringify(value)}) (exactly this value)`;
  }
  if (inner instanceof z.ZodArray) {
    const items = describe(inner._def.type, `${path}[]`, lines);
    return `array of ${items} [${count(inner._def.minLength?.value ?? null, inner._def.maxLength?.value ?? null)} items]`;
  }
  if (inner instanceof z.ZodObject) {
    // The contract promises "no other fields"; that is only true of a strict object.
    if (inner._def.unknownKeys !== 'strict') throw new Error(`field_contract_non_strict_object:${path}`);
    const fields: string[] = [];
    const entry: Line = { path, fields };
    lines.push(entry);
    for (const [key, value] of Object.entries(inner.shape as Record<string, z.ZodTypeAny>)) {
      fields.push(`${key}: ${describe(value, `${path}.${key}`, lines)}`);
    }
    return 'object';
  }
  throw new Error(`field_contract_unsupported_type:${inner.constructor.name}`);
}

/** Deterministic text block; identical input schema yields identical bytes. */
export function buildWorkflowAssessmentFieldContract(
  schema: z.ZodTypeAny = WorkflowAssessmentModelOutputSchema,
  rootName = 'assessment',
): string {
  const lines: Line[] = [];
  describe(schema, rootName, lines);
  return [
    'Field types and limits. EightForge validates every field exactly as listed; one violation rejects the whole assessment.',
    '- `string(1-N, aim ≤T)`: a non-empty JSON string of at most N characters with no leading or trailing whitespace. N is the hard limit; write to T or fewer characters so normal variation stays inside N. Where a field is an array of strings, split long content across items; otherwise state it more concisely. The exception is sourceExcerpt, an exact quotation: shorten it only by quoting a shorter contiguous passage, never by rewording.',
    '- In arrays of strings such as evidenceRequirements, requiredInputs, requiredFacts and expectedEvidence, put one requirement or fact in each item; do not combine several into one string. This applies only to items inside one array; it never means several detail records for one step.',
    '- Detail records have their own limits, often smaller than the matching workflow step field. Write each detail field for its own limit; never copy a longer step description or rationale into a detail field with a smaller limit.',
    '- `array of X [A-B items]`: a JSON array (never a single string, even for one item) holding A to B values of type X. Use [] where A is 0 and nothing applies. If more than B would apply, consolidate related items so the array stays within B.',
    '- These limits govern how each field is written. Never omit a workflow step or its required detail records to satisfy a limit.',
    '- `enum(a|b)`: exactly one of the listed strings. `object`: the record on its own line below. `or null`: the value may be JSON null.',
    '- Every listed field is required; no other fields are allowed.',
    ...lines.map((line) => `- \`${line.path}\`: ${line.fields.join('; ')}.`),
  ].join('\n');
}
