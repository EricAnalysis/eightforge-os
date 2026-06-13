/**
 * contractTaskGeneration.ts — Batch 9: map triggered OperationalDecisions to tasks.
 *
 * Pure mapping function. No side effects, no persistence, no external calls.
 * Same input always produces the same task array in the same fixed rule order.
 *
 * Scope: critical and high severity decisions only.
 * Medium and info decisions do not generate tasks in this batch.
 *
 * Task ID: deterministic, derived from source_rule_id. Since each rule fires
 * at most once per evaluation, `task_${rule_id}` is stable and unique per run.
 */

import type {
  GeneratedOperationalTask,
  OperationalDecision,
} from './types';

interface TaskTemplate {
  title: string;
  assignee_role: string;
  priority: GeneratedOperationalTask['priority'];
  due_logic: GeneratedOperationalTask['due_logic'];
  category: string;
}

// Fixed mapping from rule_id to task shape.
// Only rules listed here generate tasks; all others are skipped.
const TASK_TEMPLATES: Record<string, TaskTemplate> = {
  bafo_block: {
    title: 'Verify document status — BAFO detected',
    assignee_role: 'contract_admin',
    priority: 'urgent',
    due_logic: 'immediate',
    category: 'classification_review',
  },
  invoice_overrun: {
    title: 'Invoice quantity exceeds authorization',
    assignee_role: 'finance',
    priority: 'urgent',
    due_logic: 'immediate',
    category: 'financial_control',
  },
  missing_authorization: {
    title: 'Missing task order — billing authorization unconfirmed',
    assignee_role: 'contract_admin',
    priority: 'high',
    due_logic: '24_hours',
    category: 'authorization_review',
  },
  signature_verify: {
    title: 'Signature verification required',
    assignee_role: 'contract_admin',
    priority: 'high',
    due_logic: '24_hours',
    category: 'compliance_review',
  },
  // domain_mismatch is medium severity — no task in this batch.
};

/**
 * Map triggered OperationalDecisions to operator-facing task objects.
 *
 * Filters to critical and high severity only.
 * Returns tasks in the same order as the input decisions array.
 * Does not deduplicate or persist — caller is responsible for those concerns.
 */
export function generateOperationalTasks(
  decisions: OperationalDecision[],
): GeneratedOperationalTask[] {
  const tasks: GeneratedOperationalTask[] = [];

  for (const decision of decisions) {
    // Only critical and high severity generate tasks in this batch.
    if (decision.severity !== 'critical' && decision.severity !== 'high') {
      continue;
    }

    const template = TASK_TEMPLATES[decision.rule_id];
    if (!template) {
      // Rule has no task template — skip silently.
      // This handles future rules that may be critical/high but not yet mapped.
      continue;
    }

    tasks.push({
      task_id: `task_${decision.rule_id}`,
      source_rule_id: decision.rule_id,
      source_decision: decision,
      title: template.title,
      description: decision.operator_message,
      assignee_role: template.assignee_role,
      priority: template.priority,
      due_logic: template.due_logic,
      category: template.category,
      evidence_links: decision.evidence,
      status: 'pending',
    });
  }

  return tasks;
}
