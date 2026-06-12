import type { SupabaseClient } from '@supabase/supabase-js';
import type { AskProjectRecord, ValidatorContext, ValidatorFinding } from '@/lib/ask/types';
import { resolveCanonicalProjectFacts } from '@/lib/projectFacts';

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

function blockedReasonFromSummary(
  blockedReasons: readonly string[],
  criticalFindings: readonly ValidatorFinding[],
): string {
  if (blockedReasons.length > 0) {
    return blockedReasons[0] ?? 'No validator blocker is currently recorded';
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
  const facts = resolveCanonicalProjectFacts({
    validationStatus: params.project.validationStatus,
    validationSummary: params.validationSummary,
  });
  const lastRun =
    facts.last_run_at
    ?? (typeof params.latestRunAt === 'string' && params.latestRunAt.trim().length > 0
      ? params.latestRunAt.trim()
      : null)
    ?? new Date(0).toISOString();

  return {
    projectStatus: projectStatusFromValidationStatus(params.project.validationStatus),
    criticalFindings: params.criticalFindings,
    blockedReason: blockedReasonFromSummary(facts.blocked_reasons, params.criticalFindings),
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
