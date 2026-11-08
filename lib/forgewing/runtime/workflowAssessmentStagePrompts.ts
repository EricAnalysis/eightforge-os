import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { buildWorkflowAssessmentFieldContract } from '@/lib/forgewing/runtime/workflowAssessmentFieldContract';
import { STAGE_A_SCHEMA, STAGE_B_DETAIL_SCHEMAS } from '@/lib/forgewing/runtime/workflowAssessmentStageGrammars';

/**
 * Decomposed Workflow Assessment prompts (P2 of DECOMPOSITION-PLAN.md).
 *
 * Each stage prompt is assembled from three parts so that nothing is maintained
 * twice:
 *   1. a short stage header (prompts/workflowAssessmentStage{A,B}.md);
 *   2. the field contract generated from that stage's own strict schema;
 *   3. the shared workflow rules, taken verbatim from the canonical v7 prompt
 *      from SHARED_RULES_ANCHOR to the end (the single source of those rules).
 * The v7 single-call prompt itself is not modified.
 */
export const FORGEWING_WORKFLOW_ASSESSMENT_DECOMPOSED_PROMPT_ID = 'forgewing-workflow-assessment-decomposed' as const;
export const FORGEWING_WORKFLOW_ASSESSMENT_DECOMPOSED_PROMPT_VERSION = 'v2' as const;

export const SHARED_RULES_ANCHOR = "You are reading a person's plain-English description of how their team works.";

const read = (name: string) => readFileSync(new URL(`../prompts/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

export function loadSharedWorkflowAssessmentRules(): string {
  const canonical = read('workflowAssessment.md');
  const at = canonical.indexOf(SHARED_RULES_ANCHOR);
  if (at < 0 || canonical.indexOf(SHARED_RULES_ANCHOR, at + 1) >= 0) throw new Error('shared_rules_anchor_not_unique');
  return canonical.slice(at).trim();
}

const join = (...parts: string[]) => `${parts.map((part) => part.trim()).join('\n\n')}\n`;

export function loadWorkflowAssessmentStageAPrompt(): string {
  return join(read('workflowAssessmentStageA.md'), buildWorkflowAssessmentFieldContract(STAGE_A_SCHEMA, 'stageA'),
    loadSharedWorkflowAssessmentRules());
}

/** One contract for all six record shapes; each listed step uses the shape of its classification. */
export function loadWorkflowAssessmentStageBPrompt(): string {
  const records = z.object(STAGE_B_DETAIL_SCHEMAS).strict();
  return join(read('workflowAssessmentStageB.md'), buildWorkflowAssessmentFieldContract(records, 'recordByClassification'),
    loadSharedWorkflowAssessmentRules());
}
