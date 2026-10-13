// lib/pipeline/decisionEngine.ts
// Pipeline wrapper: generates decisions and persists them to the decisions table.

import { runDecisionEngine } from '@/lib/server/heuristicDecisionEngine';
import {
  persistDecisions,
  documentDecisionsToPersisted,
} from '@/lib/server/decisionPersistence';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DocumentDecision } from '@/lib/types/decisions';

export { runDecisionEngine };

/**
 * Model-origin (`ai_enriched`) detections are evidence: they stay in
 * `document_decisions` with their source, and never become operator decisions
 * or workflow inputs. Only deterministic detections reach `decisions` and the
 * workflow engine, so AI enrichment cannot open a finding or create a task
 * without a human.
 */
export function deterministicDecisionsOnly(
  decisions: readonly DocumentDecision[] | null | undefined,
): DocumentDecision[] {
  return (decisions ?? []).filter((decision) => decision.source !== 'ai_enriched');
}

export async function generateAndPersistDecisions(params: {
  admin: SupabaseClient;
  documentId: string;
  organizationId: string;
  projectId?: string | null;
  documentType: string | null;
  extraction: {
    fields: Record<string, unknown>;
    extraction?: { mode: string; text_preview: string | null };
    ai_enrichment?: Record<string, unknown>;
  };
}): Promise<DocumentDecision[]> {
  const decisions = deterministicDecisionsOnly(await runDecisionEngine({
    documentId: params.documentId,
    organizationId: params.organizationId,
    extraction: params.extraction,
  }));

  if (decisions.length) {
    const toPersist = documentDecisionsToPersisted(decisions, {
      document_type: params.documentType,
    });
    await persistDecisions(params.admin, {
      organization_id: params.organizationId,
      document_id: params.documentId,
      project_id: params.projectId ?? null,
      decisions: toPersist,
      source: 'system',
    });
  }

  return decisions;
}
