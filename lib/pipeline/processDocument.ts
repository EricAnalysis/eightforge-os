// lib/pipeline/processDocument.ts
// Main orchestrator: download → extract → enrich → persist → decide → workflow.
//
// Status lifecycle enforced here:
//   uploaded → processing → extracted → decisioned  (happy path)
//                                    ↘ failed        (any error)

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  createAnalysisJob,
  updateJobStatus,
  setDocumentStatus,
} from '@/lib/server/analysisJobService';
import { extractDocument } from '@/lib/server/documentExtraction';
import { normalizeExtraction } from '@/lib/server/extractionNormalizer';
import { runAiEnrichment } from '@/lib/server/documentAiEnrichment';
import { persistAiEnrichmentDecisions } from '@/lib/server/aiDecisionPersistence';
import { generateAndPersistDecisions } from '@/lib/pipeline/decisionEngine';
import { orchestrateWorkflows } from '@/lib/pipeline/workflowOrchestrator';
import { evaluateDocument } from '@/lib/server/ruleEngine';
import { createDecisionsFromRules } from '@/lib/server/decisionEngine';
import { createTasksFromDecisions } from '@/lib/server/workflowEngine';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import type { ExtractionPayload } from '@/lib/server/documentExtraction';
import type { JobTrigger } from '@/lib/types/analysisJob';

const BUCKET = process.env.NEXT_PUBLIC_SUPABASE_DOCS_BUCKET || 'documents';

export type ProcessDocumentResult = {
  success: boolean;
  extraction?: { id: string; data: Record<string, unknown>; created_at: string };
  jobId?: string;
  processing_status?: string;
  error?: string;
};

async function markFailed(
  jobId: string,
  documentId: string,
  errorMessage: string,
): Promise<void> {
  await updateJobStatus({ jobId, status: 'failed', errorMessage });
  await setDocumentStatus({ documentId, status: 'failed' });
}

export async function processDocument(params: {
  documentId: string;
  organizationId: string;
  analysisMode: string;
  triggeredBy: JobTrigger;
}): Promise<ProcessDocumentResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { success: false, error: 'Server not configured' };

  const job = await createAnalysisJob({
    documentId: params.documentId,
    organizationId: params.organizationId,
    analysisMode: params.analysisMode,
    triggeredBy: params.triggeredBy,
  });
  if (!job) return { success: false, error: 'Failed to create analysis job' };

  try {
    // ── 1. Load document row (include domain for deterministic engine) ───────
    const { data: docRow, error: docError } = await admin
      .from('documents')
      .select('id, title, name, document_type, domain, status, storage_path, organization_id')
      .eq('id', params.documentId)
      .eq('organization_id', params.organizationId)
      .single();

    if (docError || !docRow) {
      await markFailed(job.id, params.documentId, 'Document not found');
      return { success: false, error: 'Document not found', jobId: job.id };
    }

    const storagePath = docRow.storage_path as string | null;
    if (!storagePath) {
      await markFailed(job.id, params.documentId, 'storage_path missing');
      return { success: false, error: 'Storage path missing', jobId: job.id };
    }

    // ── 2. Mark processing ───────────────────────────────────────────────────
    await updateJobStatus({ jobId: job.id, status: 'running', startedAt: new Date().toISOString() });
    await setDocumentStatus({ documentId: params.documentId, status: 'processing' });

    // ── 3. Download file ─────────────────────────────────────────────────────
    const { data: fileData, error: downloadError } = await admin.storage
      .from(BUCKET)
      .download(storagePath);

    if (downloadError || !fileData) {
      await markFailed(job.id, params.documentId, 'Unable to download file from storage');
      return { success: false, error: 'Unable to download file', jobId: job.id };
    }

    const bytes = await fileData.arrayBuffer();
    const fileName = (docRow.name as string) ?? storagePath.split('/').pop() ?? 'file';
    const mimeType = (fileData as Blob & { type?: string }).type ?? null;
    const metadata = {
      id: docRow.id as string,
      title: (docRow.title as string | null) ?? null,
      name: (docRow.name as string) ?? fileName,
      document_type: (docRow.document_type as string | null) ?? null,
      storage_path: storagePath,
    };

    // ── 4. Extract text and fields ───────────────────────────────────────────
    let payload = (await extractDocument(
      metadata,
      bytes,
      mimeType,
      fileName,
    )) as ExtractionPayload & { ai_enrichment?: unknown };

    if (params.analysisMode === 'ai_enriched') {
      const aiResult = await runAiEnrichment({
        organizationId: params.organizationId,
        documentMetadata: {
          id: metadata.id,
          title: metadata.title,
          name: metadata.name,
          document_type: metadata.document_type,
        },
        extractedText: payload.extraction?.text_preview ?? null,
        heuristicFields: (payload.fields ?? {}) as Record<string, unknown>,
      });
      payload.ai_enrichment = aiResult;

      await persistAiEnrichmentDecisions({
        supabase: admin,
        organizationId: params.organizationId,
        documentId: params.documentId,
        jobId: job.id,
        enrichment: { ...aiResult, confidence_note: aiResult.confidence_note ?? null },
      });
    }

    // ── 5. Persist raw extraction row ────────────────────────────────────────
    const { data: inserted, error: insertError } = await admin
      .from('document_extractions')
      .insert({
        document_id: params.documentId,
        organization_id: params.organizationId,
        data: payload,
      })
      .select('id, data, created_at')
      .single();

    if (insertError) {
      await markFailed(job.id, params.documentId, insertError.message);
      return { success: false, error: 'Failed to persist extraction', jobId: job.id };
    }

    // ── 6. Normalize into document_extractions field rows ────────────────────
    await normalizeExtraction({
      documentId: params.documentId,
      organizationId: params.organizationId,
      payload: payload as unknown as Parameters<typeof normalizeExtraction>[0]['payload'],
    });

    // ── 7. Mark extracted — extraction is complete, decisioning starts next ──
    await setDocumentStatus({ documentId: params.documentId, status: 'extracted' });

    // ── 8. Run deterministic rule engine (if domain + document_type are set) ─
    const domain = (docRow.domain as string | null) ?? null;
    const documentType = (docRow.document_type as string | null) ?? null;

    if (domain && documentType) {
      try {
        const { matched, facts } = await evaluateDocument({
          documentId: params.documentId,
          organizationId: params.organizationId,
          domain,
          documentType,
        });

        if (matched.length > 0) {
          const deterministicResult = await createDecisionsFromRules({
            documentId: params.documentId,
            organizationId: params.organizationId,
            matchedResults: matched,
            facts,
          });

          // Create workflow tasks for newly detected decisions
          let tasksCreated = 0;
          if (deterministicResult.decisions.length > 0) {
            const taskResult = await createTasksFromDecisions({
              organizationId: params.organizationId,
              decisions: deterministicResult.decisions,
            });
            tasksCreated = taskResult?.created ?? 0;
          }

          // Audit trail — one activity event per processing run (best-effort)
          try {
            await logActivityEvent({
              organization_id: params.organizationId,
              entity_type: 'decision',
              entity_id: params.documentId,
              event_type: 'created',
              changed_by: null,
              new_value: {
                action: 'pipeline_processing',
                domain,
                document_type: documentType,
                rules_matched: matched.length,
                decisions_created: deterministicResult.created,
                decisions_updated: deterministicResult.updated,
                tasks_created: tasksCreated,
              },
            });
          } catch {
            // Activity logging is best-effort — never fail the pipeline
          }

          console.log('[processDocument] deterministic engine:', {
            rulesMatched: matched.length,
            decisionsCreated: deterministicResult.created,
            decisionsUpdated: deterministicResult.updated,
            tasksCreated,
          });
        }
      } catch (ruleErr) {
        // Rule engine failure is non-fatal — log and continue to heuristic fallback
        console.error('[processDocument] deterministic engine error (non-fatal):', ruleErr);
      }
    }

    // ── 9. Heuristic decision engine (runs for all documents as supplement) ──
    const heuristicDecisions = await generateAndPersistDecisions({
      admin,
      documentId: params.documentId,
      organizationId: params.organizationId,
      documentType,
      extraction: payload as unknown as {
        fields: Record<string, unknown>;
        extraction?: { mode: string; text_preview: string | null };
        ai_enrichment?: Record<string, unknown>;
      },
    });

    // ── 10. Orchestrate workflows for heuristic decisions ────────────────────
    await orchestrateWorkflows({
      admin,
      documentId: params.documentId,
      organizationId: params.organizationId,
      decisions: heuristicDecisions,
    });

    // ── 11. Finalize ─────────────────────────────────────────────────────────
    await updateJobStatus({
      jobId: job.id,
      status: 'completed',
      completedAt: new Date().toISOString(),
      resultExtractionId: inserted?.id ?? null,
    });
    await setDocumentStatus({ documentId: params.documentId, status: 'decisioned' });

    return {
      success: true,
      extraction: inserted,
      jobId: job.id,
      processing_status: 'decisioned',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Processing failed';
    await markFailed(job.id, params.documentId, message);
    return { success: false, error: message, jobId: job.id };
  }
}
