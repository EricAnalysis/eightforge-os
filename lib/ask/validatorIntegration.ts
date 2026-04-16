import type { SupabaseClient } from '@supabase/supabase-js';
import type { AskProjectRecord, ValidatorContext, ValidatorFinding } from '@/lib/ask/types';

type ValidationStatus = 'NOT_READY' | 'BLOCKED' | 'VALIDATED' | 'FINDINGS_OPEN';

type ProjectValidationRow = {
  id: string;
  name: string;
  validation_status: ValidationStatus | null;
  validation_summary_json: unknown;
};

type ValidationRunRow = {
  run_at: string;
  completed_at: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
}

function blockedReasonFromSummary(
  summary: Record<string, unknown> | null,
  criticalFindings: readonly ValidatorFinding[],
): string {
  const reasons = readStringArray(summary?.blocked_reasons);
  if (reasons.length > 0) {
    return reasons[0];
  }

  if (criticalFindings.length > 0) {
    return `${criticalFindings.length} critical finding${criticalFindings.length === 1 ? '' : 's'} blocking progress`;
  }

  return 'No validator blocker is currently recorded';
}

export function projectStatusFromValidationStatus(
  status: string | null | undefined,
): ValidatorContext['projectStatus'] {
  if (status === 'BLOCKED') return 'blocked';
  if (status === 'FINDINGS_OPEN') return 'warning';
  return 'clear';
}

export function buildValidatorContext(params: {
  project: AskProjectRecord;
  validationSummary?: unknown;
  latestRunAt?: string | null;
  criticalFindings: ValidatorFinding[];
}): ValidatorContext {
  const summary = isRecord(params.validationSummary)
    ? params.validationSummary
    : null;
  const lastRun =
    readString(summary?.last_run_at)
    ?? readString(params.latestRunAt)
    ?? new Date(0).toISOString();

  return {
    projectStatus: projectStatusFromValidationStatus(params.project.validationStatus),
    criticalFindings: params.criticalFindings,
    blockedReason: blockedReasonFromSummary(summary, params.criticalFindings),
    lastRun,
  };
}

export async function loadValidatorContext(params: {
  admin: SupabaseClient;
  projectId: string;
  orgId: string;
  project?: AskProjectRecord | null;
  criticalFindings?: ValidatorFinding[];
}): Promise<ValidatorContext | null> {
  const project =
    params.project
    ?? await (async (): Promise<AskProjectRecord | null> => {
      const { data, error } = await params.admin
        .from('projects')
        .select('id, name, validation_status, validation_summary_json')
        .eq('organization_id', params.orgId)
        .eq('id', params.projectId)
        .maybeSingle();

      if (error || !data) return null;

      const row = data as ProjectValidationRow;
      return {
        id: row.id,
        name: row.name,
        validationStatus: row.validation_status,
        validationSummary: row.validation_summary_json,
      };
    })();

  if (!project) {
    return null;
  }

  const { data: latestRunData } = await params.admin
    .from('project_validation_runs')
    .select('run_at, completed_at')
    .eq('project_id', params.projectId)
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const latestRun = (latestRunData ?? null) as ValidationRunRow | null;

  return buildValidatorContext({
    project,
    validationSummary: project.validationSummary,
    latestRunAt: latestRun?.completed_at ?? latestRun?.run_at ?? null,
    criticalFindings: params.criticalFindings ?? [],
  });
}
