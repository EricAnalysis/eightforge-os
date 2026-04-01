'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ValidatorEvidenceDrawer } from '@/components/validator/ValidatorEvidenceDrawer';
import {
  ValidatorFindingsTable,
  type ValidatorFindingFilters,
} from '@/components/validator/ValidatorFindingsTable';
import { ValidatorStatusChip } from '@/components/validator/ValidatorStatusChip';
import { supabase } from '@/lib/supabaseClient';
import type {
  ValidationEvidence,
  ValidationFinding,
  ValidationRun,
  ValidationStatus,
  ValidationSummary,
  ValidationTriggerSource,
} from '@/types/validator';

type ValidatorTabProps = {
  projectId: string;
};

type ValidatorProjectRow = {
  validation_status: ValidationStatus | null;
  validation_summary_json: unknown;
};

type ValidatorRunRow = Pick<
  ValidationRun,
  'id' | 'run_at' | 'completed_at' | 'triggered_by' | 'rules_applied' | 'status'
>;

const DEFAULT_FILTERS: ValidatorFindingFilters = {
  severity: 'all',
  category: 'all',
  status: 'all',
};

const EMPTY_SUMMARY: ValidationSummary = {
  status: 'NOT_READY',
  last_run_at: null,
  critical_count: 0,
  warning_count: 0,
  info_count: 0,
  open_count: 0,
  blocked_reasons: [],
  trigger_source: null,
};

const STATUS_LABELS: Record<ValidationStatus, string> = {
  NOT_READY: 'Not Ready',
  BLOCKED: 'Blocked',
  VALIDATED: 'Validated',
  FINDINGS_OPEN: 'Findings Open',
};

const TRIGGER_SOURCE_LABELS: Record<ValidationTriggerSource, string> = {
  document_processed: 'Document Processed',
  fact_override: 'Fact Override',
  relationship_change: 'Relationship Change',
  manual: 'Manual',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
}

function isValidationStatus(value: unknown): value is ValidationStatus {
  return (
    value === 'NOT_READY' ||
    value === 'BLOCKED' ||
    value === 'VALIDATED' ||
    value === 'FINDINGS_OPEN'
  );
}

function isTriggerSource(value: unknown): value is ValidationTriggerSource {
  return (
    value === 'document_processed' ||
    value === 'fact_override' ||
    value === 'relationship_change' ||
    value === 'manual'
  );
}

function blockedReasonsFromFindings(findings: ValidationFinding[]): string[] {
  return Array.from(
    new Set(
      findings
        .map((finding) => finding.blocked_reason)
        .filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        ),
    ),
  );
}

function buildFallbackSummary(
  status: ValidationStatus,
  findings: ValidationFinding[],
): ValidationSummary {
  return {
    status,
    last_run_at: null,
    critical_count: findings.filter((finding) => finding.severity === 'critical').length,
    warning_count: findings.filter((finding) => finding.severity === 'warning').length,
    info_count: findings.filter((finding) => finding.severity === 'info').length,
    open_count: findings.filter((finding) => finding.status === 'open').length,
    blocked_reasons: blockedReasonsFromFindings(findings),
    trigger_source: null,
  };
}

function parseSummary(
  raw: unknown,
  fallbackStatus: ValidationStatus,
  findings: ValidationFinding[],
): ValidationSummary {
  const fallback = buildFallbackSummary(fallbackStatus, findings);
  if (!isRecord(raw)) {
    return fallback;
  }

  return {
    status: isValidationStatus(raw.status) ? raw.status : fallbackStatus,
    last_run_at: readString(raw.last_run_at),
    critical_count: readNumber(raw.critical_count) ?? fallback.critical_count,
    warning_count: readNumber(raw.warning_count) ?? fallback.warning_count,
    info_count: readNumber(raw.info_count) ?? fallback.info_count,
    open_count: readNumber(raw.open_count) ?? fallback.open_count,
    blocked_reasons: readStringArray(raw.blocked_reasons),
    trigger_source: isTriggerSource(raw.trigger_source) ? raw.trigger_source : null,
  };
}

function sortFindings(findings: ValidationFinding[]): ValidationFinding[] {
  const categoryRank: Record<ValidationFinding['category'], number> = {
    required_sources: 0,
    identity_consistency: 1,
    financial_integrity: 2,
    ticket_integrity: 3,
  };
  const severityRank: Record<ValidationFinding['severity'], number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  return [...findings].sort((left, right) => {
    const categoryDelta = categoryRank[left.category] - categoryRank[right.category];
    if (categoryDelta !== 0) {
      return categoryDelta;
    }

    const severityDelta = severityRank[left.severity] - severityRank[right.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const ruleDelta = left.rule_id.localeCompare(right.rule_id, 'en-US');
    if (ruleDelta !== 0) {
      return ruleDelta;
    }

    return left.subject_id.localeCompare(right.subject_id, 'en-US');
  });
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'Not available';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Not available';
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function formatTriggerSource(source: ValidationTriggerSource | null): string {
  if (!source) {
    return 'Automatic';
  }

  return TRIGGER_SOURCE_LABELS[source];
}

function statusPanelClassName(status: ValidationStatus): string {
  return status === 'BLOCKED'
    ? 'border-[#EF4444]/35 bg-[#2A1016]'
    : 'border-[#2F3B52]/70 bg-[#111827]';
}

function isRunInProgress(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'running';
}

export function ValidatorTab({ projectId }: ValidatorTabProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ValidationSummary>(EMPTY_SUMMARY);
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [latestRun, setLatestRun] = useState<ValidatorRunRow | null>(null);
  const [filters, setFilters] = useState<ValidatorFindingFilters>(DEFAULT_FILTERS);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [evidenceByFindingId, setEvidenceByFindingId] = useState<
    Record<string, ValidationEvidence[]>
  >({});
  const [evidenceLoadingId, setEvidenceLoadingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadValidatorState = useCallback(
    async (showLoading = true) => {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);

      const [projectResult, findingsResult, runResult] = await Promise.all([
        supabase
          .from('projects')
          .select('validation_status, validation_summary_json')
          .eq('id', projectId)
          .maybeSingle(),
        supabase
          .from('project_validation_findings')
          .select('*')
          .eq('project_id', projectId)
          .eq('status', 'open'),
        supabase
          .from('project_validation_runs')
          .select('id, run_at, completed_at, triggered_by, rules_applied, status')
          .eq('project_id', projectId)
          .order('run_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (projectResult.error) {
        throw new Error(projectResult.error.message);
      }
      if (findingsResult.error) {
        throw new Error(findingsResult.error.message);
      }
      if (runResult.error) {
        throw new Error(runResult.error.message);
      }

      const validatorProject = (projectResult.data ?? {
        validation_status: 'NOT_READY',
        validation_summary_json: null,
      }) as ValidatorProjectRow;
      const loadedFindings = sortFindings((findingsResult.data ?? []) as ValidationFinding[]);
      const status = isValidationStatus(validatorProject.validation_status)
        ? validatorProject.validation_status
        : 'NOT_READY';
      const nextSummary = parseSummary(
        validatorProject.validation_summary_json,
        status,
        loadedFindings,
      );

      setSummary({
        ...nextSummary,
        status,
        blocked_reasons:
          nextSummary.blocked_reasons.length > 0
            ? nextSummary.blocked_reasons
            : blockedReasonsFromFindings(loadedFindings),
      });
      setFindings(loadedFindings);
      setLatestRun((runResult.data ?? null) as ValidatorRunRow | null);
      setSelectedFindingId((current) => {
        if (!current) {
          return current;
        }

        return loadedFindings.some((finding) => finding.id === current)
          ? current
          : null;
      });
      setLoading(false);
    },
    [projectId],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        await loadValidatorState(true);
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Failed to load validator data.',
        );
        setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [loadValidatorState]);

  const validationInProgress = isRunInProgress(latestRun?.status);

  useEffect(() => {
    if (!validationInProgress) {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void loadValidatorState(false).catch((pollError) => {
        if (cancelled) {
          return;
        }

        setError(
          pollError instanceof Error
            ? pollError.message
            : 'Failed to refresh validator data.',
        );
      });
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [loadValidatorState, validationInProgress]);

  useEffect(() => {
    if (!selectedFindingId || evidenceByFindingId[selectedFindingId]) {
      return;
    }

    let cancelled = false;
    setEvidenceLoadingId(selectedFindingId);

    const loadEvidence = async () => {
      try {
        const { data, error: evidenceError } = await supabase
          .from('project_validation_evidence')
          .select('*')
          .eq('finding_id', selectedFindingId);

        if (cancelled) {
          return;
        }
        if (evidenceError) {
          setNotice('Evidence could not be loaded for the selected finding.');
          setEvidenceLoadingId(null);
          return;
        }

        setEvidenceByFindingId((current) => ({
          ...current,
          [selectedFindingId]: (data ?? []) as ValidationEvidence[],
        }));
        setEvidenceLoadingId(null);
      } catch {
        if (cancelled) {
          return;
        }

        setNotice('Evidence could not be loaded for the selected finding.');
        setEvidenceLoadingId(null);
      }
    };

    void loadEvidence();

    return () => {
      cancelled = true;
    };
  }, [evidenceByFindingId, selectedFindingId]);

  const status = summary.status;
  const blockedFindings = useMemo(
    () => findings.filter((finding) => Boolean(finding.blocked_reason)),
    [findings],
  );
  const selectedFinding = useMemo(
    () => findings.find((finding) => finding.id === selectedFindingId) ?? null,
    [findings, selectedFindingId],
  );
  const selectedEvidence = selectedFindingId
    ? evidenceByFindingId[selectedFindingId] ?? []
    : [];
  const lastRunAt = summary.last_run_at ?? latestRun?.completed_at ?? latestRun?.run_at ?? null;
  const triggerSource = summary.trigger_source ?? latestRun?.triggered_by ?? null;
  const rulesAppliedCount = Array.isArray(latestRun?.rules_applied)
    ? latestRun.rules_applied.length
    : 0;

  const handleRecheck = async () => {
    setNotice(
      'Automatic validation is enabled. Manual re-check is not wired yet, so this button refreshes the current validator view only.',
    );

    try {
      await loadValidatorState(false);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : 'Failed to refresh validator data.',
      );
    }
  };

  const handlePlaceholderAction = (
    action:
      | 'create_decision'
      | 'create_action'
      | 'resolve'
      | 'dismiss'
      | 'mute'
      | 'view_document',
    finding: ValidationFinding,
  ) => {
    switch (action) {
      case 'create_decision':
        setNotice(
          finding.decision_eligible
            ? 'Decision creation is not wired yet for validator findings.'
            : 'This finding is not decision eligible yet.',
        );
        break;
      case 'create_action':
        setNotice(
          finding.action_eligible
            ? 'Action creation is not wired yet for validator findings.'
            : 'This finding is not action eligible yet.',
        );
        break;
      case 'resolve':
        setNotice('Resolve is not wired yet for validator findings.');
        break;
      case 'dismiss':
        setNotice('Dismiss is not wired yet for validator findings.');
        break;
      case 'mute':
        setNotice('Mute is not wired yet for validator findings.');
        break;
      case 'view_document':
        setNotice(`Document deep-linking is not wired yet for ${finding.rule_id}.`);
        break;
      default:
        setNotice('This validator action is not wired yet.');
        break;
    }
  };

  return (
    <div className="space-y-6">
      <section className={`rounded-sm border p-5 ${statusPanelClassName(status)}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
              Validator
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-[#E5EDF7]">
              Project validation
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-[#C7D2E3]">
              Deterministic checks compare structured project records, document relationships, and extracted facts for internal consistency.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              void handleRecheck();
            }}
            className="rounded-sm border border-[#2F3B52] bg-[#111827] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#E5EDF7] transition-colors hover:border-[#3B82F6] hover:text-[#3B82F6]"
          >
            Re-check
          </button>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <ValidatorStatusChip
            status={status}
            criticalCount={summary.critical_count}
            warningCount={summary.warning_count}
          />
          {validationInProgress ? (
            <div className="rounded-sm border border-[#38BDF8]/30 bg-[#10283A] px-3 py-2 text-xs text-[#7DD3FC]">
              Validation in progress...
            </div>
          ) : null}
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
            <span className="font-bold text-[#E5EDF7]">{summary.info_count}</span> info
          </div>
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
            <span className="font-bold text-[#E5EDF7]">{formatTimestamp(lastRunAt)}</span> last run
          </div>
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
            <span className="font-bold text-[#E5EDF7]">{formatTriggerSource(triggerSource)}</span> trigger source
          </div>
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
            <span className="font-bold text-[#E5EDF7]">{summary.open_count}</span> open findings
          </div>
        </div>
      </section>

      {notice ? (
        <div className="rounded-sm border border-[#3B82F6]/30 bg-[#15233A] px-4 py-3 text-sm text-[#BFDBFE]">
          {notice}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-sm border border-[#EF4444]/30 bg-[#45141B] px-4 py-3 text-sm text-[#FCA5A5]">
          {error}
        </div>
      ) : null}

      {status === 'BLOCKED' && blockedFindings.length > 0 ? (
        <section className="rounded-sm border border-[#EF4444]/35 bg-[#2A1016] p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#FCA5A5]">
                Blocked reasons
              </p>
              <h3 className="mt-2 text-lg font-bold text-[#FDE2E2]">
                Validation is blocked until required project sources are available.
              </h3>
            </div>
            <span className="rounded-sm border border-[#EF4444]/35 bg-[#45141B] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#FCA5A5]">
              {STATUS_LABELS[status]}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            {blockedFindings.map((finding) => (
              <div
                key={finding.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-sm border border-[#EF4444]/25 bg-[#3A1117] px-4 py-4"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-[#EF4444]" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#FDE2E2]">
                      {finding.blocked_reason}
                    </p>
                    <p className="mt-1 text-xs text-[#FECACA]">
                      {finding.rule_id} - {finding.subject_type}:{finding.subject_id}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <span
                    className={`rounded-sm px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${
                      finding.action_eligible
                        ? 'bg-[#31230F] text-[#FCD34D]'
                        : 'bg-[#182132] text-[#94A3B8]'
                    }`}
                  >
                    {finding.action_eligible ? 'Action eligible' : 'Review required'}
                  </span>
                  <button
                    type="button"
                    disabled={!finding.action_eligible}
                    onClick={() => handlePlaceholderAction('create_action', finding)}
                    className={`rounded-sm border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] ${
                      finding.action_eligible
                        ? 'border-[#EF4444]/35 bg-[#45141B] text-[#FDE2E2] transition-colors hover:border-[#FCA5A5]'
                        : 'cursor-not-allowed border-[#2F3B52]/50 bg-[#1A2333] text-[#6B7C93]'
                    }`}
                  >
                    Create Action
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {loading ? (
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] px-4 py-5 text-sm text-[#94A3B8]">
          Loading validator findings...
        </div>
      ) : status === 'VALIDATED' && findings.length === 0 ? (
        <section className="rounded-sm border border-[#22C55E]/30 bg-[#0F2417] p-6">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#86EFAC]">
            Validated
          </p>
          <h3 className="mt-2 text-xl font-bold text-[#E5EDF7]">
            Project data is internally consistent.
          </h3>
          <p className="mt-2 text-sm text-[#C7D2E3]">
            No open validator findings are currently present for this project.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <div className="rounded-sm border border-[#22C55E]/20 bg-[#0B1720] px-3 py-2 text-xs text-[#C7D2E3]">
              Last run: <span className="font-bold text-[#E5EDF7]">{formatTimestamp(lastRunAt)}</span>
            </div>
            {rulesAppliedCount > 0 ? (
              <div className="rounded-sm border border-[#22C55E]/20 bg-[#0B1720] px-3 py-2 text-xs text-[#C7D2E3]">
                Rules applied: <span className="font-bold text-[#E5EDF7]">{rulesAppliedCount}</span>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void handleRecheck();
              }}
              className="rounded-sm border border-[#2F3B52] bg-[#111827] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#E5EDF7] transition-colors hover:border-[#3B82F6] hover:text-[#3B82F6]"
            >
              Re-check
            </button>
          </div>
        </section>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.95fr)]">
          <div className="space-y-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
                Findings
              </p>
              <h3 className="mt-2 text-lg font-bold text-[#E5EDF7]">
                Open validator findings
              </h3>
              <p className="mt-2 text-sm text-[#94A3B8]">
                Review findings by severity, category, or status, then open a row to inspect the evidence payload.
              </p>
            </div>

            <ValidatorFindingsTable
              findings={findings}
              filters={filters}
              selectedFindingId={selectedFindingId}
              onFiltersChange={setFilters}
              onSelectFinding={(finding) => {
                setSelectedFindingId(finding.id);
              }}
            />
          </div>

          <ValidatorEvidenceDrawer
            finding={selectedFinding}
            evidence={selectedEvidence}
            loading={evidenceLoadingId === selectedFindingId}
            notice={notice}
            onClose={() => setSelectedFindingId(null)}
            onPlaceholderAction={handlePlaceholderAction}
          />
        </div>
      )}
    </div>
  );
}
