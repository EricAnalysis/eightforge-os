export type AnalysisMode = 'disabled' | 'deterministic' | 'ai_enriched';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type JobTrigger = 'upload' | 'manual' | 'system';

export type AnalysisJob = {
  id: string;
  document_id: string;
  organization_id: string;
  analysis_mode: AnalysisMode;
  status: JobStatus;
  triggered_by: JobTrigger;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  result_extraction_id: string | null;
  created_at: string;
};
