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

export async function generateAndPersistDecisions(params: {
  admin: SupabaseClient;
  documentId: string;
  organizationId: string;
  documentType: string | null;
  extraction: {
    fields: Record<string, unknown>;
    extraction?: { mode: string; text_preview: string | null };
    ai_enrichment?: Record<string, unknown>;
  };
}): Promise<DocumentDecision[]> {
  const decisions = await runDecisionEngine({
    documentId: params.documentId,
    organizationId: params.organizationId,
    extraction: params.extraction,
  });

  if (decisions?.length) {
    const toPersist = documentDecisionsToPersisted(decisions, {
      document_type: params.documentType,
    });
    await persistDecisions(params.admin, {
      organization_id: params.organizationId,
      document_id: params.documentId,
      decisions: toPersist,
      source: 'system',
    });
  }

  return decisions ?? [];
}
