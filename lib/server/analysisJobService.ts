// lib/server/analysisJobService.ts
// Job queue helpers for document analysis: create, update, document status.

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { AnalysisJob } from '@/lib/types/analysisJob';
import type { JobStatus, JobTrigger } from '@/lib/types/analysisJob';

type CreateAnalysisJobParams = {
  documentId: string;
  organizationId: string;
  analysisMode: string;
  triggeredBy: JobTrigger;
};

export async function createAnalysisJob(
  params: CreateAnalysisJobParams
): Promise<AnalysisJob | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from('document_analysis_jobs')
    .insert({
      document_id: params.documentId,
      organization_id: params.organizationId,
      analysis_mode: params.analysisMode,
      status: 'queued',
      triggered_by: params.triggeredBy,
    })
    .select()
    .single();

  if (error || !data) return null;
  return data as AnalysisJob;
}

type UpdateJobStatusParams = {
  jobId: string;
  status: JobStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  errorMessage?: string | null;
  resultExtractionId?: string | null;
};

export async function updateJobStatus(params: UpdateJobStatusParams): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;

  const updates: Record<string, unknown> = {
    status: params.status,
  };
  if (params.startedAt !== undefined) updates.started_at = params.startedAt;
  if (params.completedAt !== undefined) updates.completed_at = params.completedAt;
  if (params.errorMessage !== undefined) updates.error_message = params.errorMessage;
  if (params.resultExtractionId !== undefined) updates.result_extraction_id = params.resultExtractionId;

  if (params.status === 'running') {
    const { data: current } = await admin
      .from('document_analysis_jobs')
      .select('attempt_count')
      .eq('id', params.jobId)
      .single();
    const nextCount = ((current?.attempt_count as number) ?? 0) + 1;
    updates.attempt_count = nextCount;
  }

  await admin.from('document_analysis_jobs').update(updates).eq('id', params.jobId);
}

/** Allowed values for documents.processing_status (DB check constraint). */
export type DocumentStatus =
  | 'uploaded'
  | 'processing'
  | 'extracted'
  | 'decisioned'
  | 'failed';

export async function setDocumentStatus(params: {
  documentId: string;
  status: DocumentStatus;
  processingError?: string | null;
  clearProcessingError?: boolean;
  processedAt?: string | null;
}): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;

  const updates: Record<string, unknown> = {
    processing_status: params.status,
  };
  if (params.processingError !== undefined) {
    updates.processing_error = params.processingError;
  } else if (params.clearProcessingError) {
    updates.processing_error = null;
  }
  if (params.processedAt !== undefined) {
    updates.processed_at = params.processedAt;
  }

  await admin
    .from('documents')
    .update(updates)
    .eq('id', params.documentId);
}

export async function getJob(jobId: string): Promise<AnalysisJob | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from('document_analysis_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error || !data) return null;
  return data as AnalysisJob;
}
