// lib/pipeline/workflowOrchestrator.ts
// Idempotent workflow task creation and workflow rule execution for a processed document.

import { runWorkflowEngine } from '@/lib/server/legacyWorkflowEngine';
import { createWorkflowTasksFromDecisions } from '@/lib/server/workflowTasks';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DocumentDecision } from '@/lib/types/decisions';

export async function orchestrateWorkflows(params: {
  admin: SupabaseClient;
  documentId: string;
  organizationId: string;
  decisions: DocumentDecision[];
}): Promise<{ tasksCreated: number }> {
  let tasksCreated = 0;

  try {
    const { data: openDecisions } = await params.admin
      .from('decisions')
      .select('id, decision_type, severity, status, title, summary')
      .eq('organization_id', params.organizationId)
      .eq('document_id', params.documentId)
      .eq('status', 'open');

    if (openDecisions?.length) {
      const result = await createWorkflowTasksFromDecisions(
        params.admin,
        params.organizationId,
        params.documentId,
        openDecisions,
      );
      tasksCreated = result.created;
    }
  } catch (e) {
    console.error('[workflowOrchestrator] task creation error:', e);
  }

  try {
    await runWorkflowEngine({
      documentId: params.documentId,
      organizationId: params.organizationId,
      decisions: params.decisions.map((d) => ({
        decision_type: d.decision_type,
        decision_value: d.decision_value,
      })),
    });
  } catch (e) {
    console.error('[workflowOrchestrator] workflow engine error:', e);
  }

  return { tasksCreated };
}
