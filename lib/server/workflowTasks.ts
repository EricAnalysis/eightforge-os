// lib/server/workflowTasks.ts
// Creates workflow tasks from qualifying decisions. Server-only; use getSupabaseAdmin().
// Uses workflow_trigger_rules when present; falls back to hardcoded logic when no rules exist.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkflowTriggerRule } from '@/lib/types/workflow';

/** Decision row from public.decisions (subset needed for task creation). */
export type DecisionForWorkflow = {
  id: string;
  decision_type: string;
  severity: string;
  status: string;
  title: string;
  summary: string | null;
};

const FALLBACK_TASK_TYPE = 'review_decision';

/** Check if an open task already exists for (org, decision_id, task_type). */
async function hasExistingOpenTask(
  admin: SupabaseClient,
  organizationId: string,
  decisionId: string,
  taskType: string
): Promise<boolean> {
  const { data, error } = await admin
    .from('workflow_tasks')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('decision_id', decisionId)
    .eq('task_type', taskType)
    .not('status', 'in', '(resolved,cancelled)')
    .limit(1);

  if (error || !data?.length) return false;
  return true;
}

/** Load active trigger rules for the organization. */
async function loadActiveTriggerRules(
  admin: SupabaseClient,
  organizationId: string
): Promise<WorkflowTriggerRule[]> {
  const { data, error } = await admin
    .from('workflow_trigger_rules')
    .select('id, organization_id, is_active, decision_type, severity, decision_status, task_type, title_template, description_template, priority, conditions')
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[workflowTasks] load trigger rules failed:', error.message);
    return [];
  }
  return (data ?? []) as WorkflowTriggerRule[];
}

/** Match decision against rule: null in rule means "any". */
function decisionMatchesRule(decision: DecisionForWorkflow, rule: WorkflowTriggerRule): boolean {
  if (rule.decision_type != null && rule.decision_type !== decision.decision_type) return false;
  if (rule.severity != null && rule.severity !== decision.severity) return false;
  if (rule.decision_status != null && rule.decision_status !== decision.status) return false;
  return true;
}

/** Simple template replace: {{title}}, {{summary}}, {{decision_type}}, {{severity}}. */
function applyTemplate(template: string, decision: DecisionForWorkflow): string {
  return template
    .replace(/\{\{title\}\}/g, decision.title ?? '')
    .replace(/\{\{summary\}\}/g, decision.summary ?? '')
    .replace(/\{\{decision_type\}\}/g, decision.decision_type ?? '')
    .replace(/\{\{severity\}\}/g, decision.severity ?? '');
}

/** Hardcoded fallback: same criteria as before (open + critical | contract_gap | compliance_alert). */
function isFallbackQualifying(d: DecisionForWorkflow): boolean {
  if (d.status !== 'open') return false;
  if (d.severity === 'critical') return true;
  if (d.decision_type === 'contract_gap') return true;
  if (d.decision_type === 'compliance_alert') return true;
  return false;
}

/**
 * Create workflow tasks from decisions. When workflow_trigger_rules exist for the org,
 * matches decisions to rules and creates tasks from matched rules. When no rules exist,
 * uses hardcoded qualifying criteria and task shape (fallback). Dedupes by
 * (organization_id, decision_id, task_type) where status is not resolved/cancelled.
 * Inserts workflow_task_events for each created task. Does not throw.
 */
export async function createWorkflowTasksFromDecisions(
  admin: SupabaseClient,
  organizationId: string,
  documentId: string,
  decisions: DecisionForWorkflow[]
): Promise<{ created: number }> {
  if (decisions.length === 0) return { created: 0 };

  const rules = await loadActiveTriggerRules(admin, organizationId);
  const useRules = rules.length > 0;

  let created = 0;
  const now = new Date().toISOString();

  if (useRules) {
    for (const d of decisions) {
      const matchingRules = rules.filter((r) => decisionMatchesRule(d, r));
      for (const rule of matchingRules) {
        try {
          const exists = await hasExistingOpenTask(admin, organizationId, d.id, rule.task_type);
          if (exists) continue;

          const title = applyTemplate(rule.title_template, d);
          const description = applyTemplate(rule.description_template, d);

          const { data: taskRow, error: insertError } = await admin
            .from('workflow_tasks')
            .insert({
              organization_id: organizationId,
              decision_id: d.id,
              document_id: documentId,
              task_type: rule.task_type,
              title: title || 'Workflow task',
              description: description ?? '',
              priority: rule.priority,
              status: 'open',
              source: 'decision_engine',
              source_metadata: {
                decision_type: d.decision_type,
                severity: d.severity,
                trigger_rule_id: rule.id,
              },
              details: rule.conditions ?? {},
              created_at: now,
              updated_at: now,
            })
            .select('id')
            .single();

          if (insertError) {
            console.error('[workflowTasks] insert task failed:', insertError.message);
            continue;
          }

          const taskId = (taskRow as { id: string } | null)?.id;
          if (!taskId) continue;

          const { error: eventError } = await admin.from('workflow_task_events').insert({
            task_id: taskId,
            event_type: 'task_created',
            new_status: 'open',
            metadata: { decision_id: d.id, trigger_rule_id: rule.id },
            created_at: now,
          });

          if (eventError) {
            console.error('[workflowTasks] insert event failed:', eventError.message);
          } else {
            created += 1;
          }
        } catch (e) {
          console.error('[workflowTasks] error for decision', d.id, 'rule', rule.id, e);
        }
      }
    }
  } else {
    const fallbackDecisions = decisions.filter(isFallbackQualifying);
    for (const d of fallbackDecisions) {
      try {
        const exists = await hasExistingOpenTask(admin, organizationId, d.id, FALLBACK_TASK_TYPE);
        if (exists) continue;

        const { data: taskRow, error: insertError } = await admin
          .from('workflow_tasks')
          .insert({
            organization_id: organizationId,
            decision_id: d.id,
            document_id: documentId,
            task_type: FALLBACK_TASK_TYPE,
            title: 'Review critical finding',
            description: d.summary ?? d.title,
            priority: 'critical',
            status: 'open',
            source: 'decision_engine',
            source_metadata: {
              decision_type: d.decision_type,
              severity: d.severity,
            },
            details: {},
            created_at: now,
            updated_at: now,
          })
          .select('id')
          .single();

        if (insertError) {
          console.error('[workflowTasks] insert task failed:', insertError.message);
          continue;
        }

        const taskId = (taskRow as { id: string } | null)?.id;
        if (!taskId) continue;

        const { error: eventError } = await admin.from('workflow_task_events').insert({
          task_id: taskId,
          event_type: 'task_created',
          new_status: 'open',
          metadata: { decision_id: d.id },
          created_at: now,
        });

        if (eventError) {
          console.error('[workflowTasks] insert event failed:', eventError.message);
        } else {
          created += 1;
        }
      } catch (e) {
        console.error('[workflowTasks] error for decision', d.id, e);
      }
    }
  }

  return { created };
}
