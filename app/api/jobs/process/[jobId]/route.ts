// app/api/jobs/process/[jobId]/route.ts
// Processes a single document analysis job: download, extract, optional AI enrich, persist.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getJob, updateJobStatus, setDocumentStatus } from '@/lib/server/analysisJobService';
import { extractDocument } from '@/lib/server/documentExtraction';
import { runAiEnrichment } from '@/lib/server/documentAiEnrichment';
import { persistAiEnrichmentDecisions } from '@/lib/server/aiDecisionPersistence';
import { runDecisionEngine } from '@/lib/server/decisionEngine';
import { runWorkflowEngine } from '@/lib/server/workflowEngine';
import type { ExtractionPayload } from '@/lib/server/documentExtraction';

const BUCKET = process.env.NEXT_PUBLIC_SUPABASE_DOCS_BUCKET || 'documents';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function markJobFailed(jobId: string, documentId: string, errorMessage: string): Promise<void> {
  await updateJobStatus({
    jobId,
    status: 'failed',
    errorMessage,
  });
  await setDocumentStatus({ documentId, status: 'failed' });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  let jobId: string | null = null;
  let job: Awaited<ReturnType<typeof getJob>> = null;
  try {
    const resolved = await params;
    jobId = resolved.jobId ?? null;
    if (!jobId) {
      return jsonError('Job not found', 404);
    }

    job = await getJob(jobId);
    if (!job) {
      return jsonError('Job not found', 404);
    }
    if (job.status !== 'queued') {
      return NextResponse.json(
        { error: 'Job is not in queued state' },
        { status: 409 }
      );
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return jsonError('Server not configured', 503);
    }

    const { data: docRow, error: docError } = await admin
      .from('documents')
      .select('id, title, name, document_type, status, storage_path, organization_id')
      .eq('id', job.document_id)
      .single();

    if (docError || !docRow) {
      await markJobFailed(jobId, job.document_id, 'Document not found');
      return jsonError('Document not found', 404);
    }

    const storagePath = docRow.storage_path;
    if (!storagePath || typeof storagePath !== 'string') {
      await markJobFailed(jobId, job.document_id, 'storage_path missing');
      return jsonError('storage_path missing', 400);
    }

    await updateJobStatus({
      jobId,
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    await setDocumentStatus({ documentId: job.document_id, status: 'processing' });

    const { data: fileData, error: downloadError } = await admin.storage
      .from(BUCKET)
      .download(storagePath);

    if (downloadError || !fileData) {
      await markJobFailed(jobId, job.document_id, 'Unable to download file from storage');
      await setDocumentStatus({ documentId: job.document_id, status: 'failed' });
      return jsonError('Unable to download file from storage', 502);
    }

    const bytes = await fileData.arrayBuffer();
    const fileName = docRow.name ?? storagePath.split('/').pop() ?? 'file';
    const mimeType = (fileData as Blob & { type?: string }).type ?? null;
    const metadata = {
      id: docRow.id,
      title: docRow.title ?? null,
      name: docRow.name ?? fileName,
      document_type: docRow.document_type ?? null,
      storage_path: storagePath,
    };

    let payload = (await extractDocument(
      metadata,
      bytes,
      mimeType,
      fileName
    )) as ExtractionPayload & { ai_enrichment?: unknown };

    if (job.analysis_mode === 'ai_enriched') {
      const aiResult = await runAiEnrichment({
        organizationId: job.organization_id,
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

      const aiDecisionResult = await persistAiEnrichmentDecisions({
        supabase: admin,
        organizationId: job.organization_id,
        documentId: job.document_id,
        jobId,
        enrichment: {
          ...aiResult,
          confidence_note: aiResult.confidence_note ?? null,
        },
      });
      console.log('AI decision persistence result', aiDecisionResult);
    }

    const { data: inserted, error: insertError } = await admin
      .from('document_extractions')
      .insert({ document_id: job.document_id, data: payload })
      .select('id, data, created_at')
      .single();

    if (insertError) {
      await markJobFailed(jobId, job.document_id, insertError.message);
      return jsonError('Analysis failed. Please try again.', 500);
    }

    try {
      const decisions = await runDecisionEngine({
        documentId: job.document_id,
        organizationId: job.organization_id,
        extraction: payload as unknown as {
          fields: Record<string, unknown>;
          extraction?: { mode: string; text_preview: string | null };
          ai_enrichment?: Record<string, unknown>;
        },
      });

      try {
        await runWorkflowEngine({
          documentId: job.document_id,
          organizationId: job.organization_id,
          decisions: (decisions ?? []).map((d) => ({
            decision_type: d.decision_type,
            decision_value: d.decision_value,
          })),
        });
      } catch (e) {
        console.error('[jobs/process] workflow engine error:', e);
      }
    } catch (e) {
      console.error('[jobs/process] decision engine error:', e);
    }

    await updateJobStatus({
      jobId,
      status: 'completed',
      completedAt: new Date().toISOString(),
      resultExtractionId: inserted?.id ?? null,
    });
    await setDocumentStatus({ documentId: job.document_id, status: 'processed' });

    return NextResponse.json({
      success: true,
      extraction: inserted,
      jobId,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (job?.document_id) {
      await setDocumentStatus({ documentId: job.document_id, status: 'failed' });
    }
    if (jobId) {
      await updateJobStatus({
        jobId,
        status: 'failed',
        errorMessage,
      });
    }

    return NextResponse.json({ error: 'Job processing failed' }, { status: 500 });
  }
}
