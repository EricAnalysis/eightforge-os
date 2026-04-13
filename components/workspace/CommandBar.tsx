'use client';

import Link from 'next/link';
import { AskProjectSection } from '@/components/projects/AskProjectSection';
import { ProjectIntelligenceSnapshot } from '@/components/projects/ProjectIntelligenceSnapshot';
import type { ProjectOverviewModel, ProjectRecord } from '@/lib/projectOverview';
import type { ForgeStageCounts } from '@/lib/forgeStageCounts';
import type { ProjectDecisionRow, ProjectDocumentRow, ProjectTaskRow } from '@/lib/projectOverview';
import {
  approvalGateImpact,
  approvalNextAction,
  operatorApprovalLabel,
  type TruthValidationState,
} from '@/lib/truthToAction';

type CommandBarProps = {
  project: ProjectRecord;
  uploadHref: string;
  legacyProjectHref: string;
  model: ProjectOverviewModel;
  stageCounts: ForgeStageCounts;
  projectId: string;
  documents: ProjectDocumentRow[];
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
};

function validatorSignalClass(status: string): string {
  // ValidationStatus values: 'NOT_READY' | 'BLOCKED' | 'VALIDATED' | 'FINDINGS_OPEN'
  if (status === 'BLOCKED') {
    return 'text-[#F87171] ring-[#EF4444]/40 bg-[#EF4444]/8';
  }
  if (status === 'FINDINGS_OPEN') {
    return 'text-[#FBBF24] ring-[#F59E0B]/35 bg-[#F59E0B]/8';
  }
  if (status === 'VALIDATED') {
    return 'text-[#34D399] ring-[#22C55E]/30 bg-[#22C55E]/8';
  }
  return 'text-[#94A3B8] ring-[#475569]/30 bg-transparent';
}

function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function readinessPillClass(value: string): string {
  if (value === 'Requires Verification') return 'text-[#FCA5A5] ring-[#EF4444]/40 bg-[#EF4444]/8';
  if (value === 'Approved') return 'text-[#86EFAC] ring-[#22C55E]/30 bg-[#22C55E]/8';
  if (value === 'Needs Review' || value === 'Approved with Notes') return 'text-[#FCD34D] ring-[#F59E0B]/35 bg-[#F59E0B]/8';
  return 'text-[#94A3B8] ring-[#475569]/30 bg-transparent';
}

function StatusStrip({
  stageCounts,
  decisions,
}: {
  stageCounts: ForgeStageCounts;
  decisions: ProjectDecisionRow[];
}) {
  const extractionActive = stageCounts.extract > 0;
  const intakeWaiting = stageCounts.intake > 0;
  const structureReady = stageCounts.structure > 0;
  const decideOpen = stageCounts.decide > 0;
  const actOpen = stageCounts.act > 0;
  const criticalCount = decisions.filter(
    (d) =>
      d.severity === 'critical' &&
      !['resolved', 'dismissed', 'suppressed'].includes(d.status),
  ).length;

  const signals: Array<{ label: string; tone: 'ok' | 'warn' | 'active' | 'muted' }> = [
    {
      label: intakeWaiting
        ? `Intake (${stageCounts.intake})`
        : extractionActive
          ? `Extracting (${stageCounts.extract})`
          : 'Extraction ✓',
      tone: intakeWaiting || extractionActive ? 'active' : 'ok',
    },
    {
      label: structureReady ? `Structure (${stageCounts.structure})` : 'Structure ✓',
      tone: structureReady ? 'active' : 'ok',
    },
    {
      label: criticalCount > 0
        ? `Decide ⚠ ${criticalCount} critical`
        : decideOpen
          ? `Decide (${stageCounts.decide})`
          : 'Decide ✓',
      tone: criticalCount > 0 ? 'warn' : decideOpen ? 'active' : 'ok',
    },
    {
      label: actOpen ? `${stageCounts.act} action${stageCounts.act !== 1 ? 's' : ''} pending` : 'Actions clear',
      tone: actOpen ? 'active' : 'ok',
    },
  ];

  const toneClass = (tone: 'ok' | 'warn' | 'active' | 'muted') => {
    if (tone === 'ok') return 'text-[#34D399]';
    if (tone === 'warn') return 'text-[#FBBF24]';
    if (tone === 'active') return 'text-[#60A5FA]';
    return 'text-[#475569]';
  };

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-[#2F3B52]/40 pt-2 mt-2">
      {signals.map((s) => (
        <span key={s.label} className={`font-mono text-[10px] tracking-[0.06em] ${toneClass(s.tone)}`}>
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function CommandBar({
  project,
  uploadHref,
  legacyProjectHref,
  model,
  stageCounts,
  projectId,
  documents,
  decisions,
  tasks,
}: CommandBarProps) {
  const code = project.code?.trim();
  const criticalCount = decisions.filter(
    (d) =>
      d.severity === 'critical' &&
      !['resolved', 'dismissed', 'suppressed'].includes(d.status),
  ).length;
  const validatorStatus = model.validator_status;
  const validatorSummary = model.validator_summary;
  const criticalFindings = validatorSummary.critical_count;
  const governingContract = documents.find(
    (document) =>
      document.document_type?.toLowerCase().includes('contract') ||
      document.title?.toLowerCase().includes('contract') ||
      document.name.toLowerCase().includes('contract'),
  ) ?? documents[0] ?? null;
  const validatorLabel = operatorApprovalLabel(validatorStatus);
  const approvalLabel = operatorApprovalLabel(
    validatorSummary.validator_readiness ?? validatorStatus,
  );

  let headerValidation: TruthValidationState = 'Unknown';
  if (validatorStatus === 'VALIDATED') {
    headerValidation = 'Verified';
  } else if (validatorStatus === 'BLOCKED') {
    headerValidation = 'Requires Verification';
  } else if (validatorStatus === 'FINDINGS_OPEN') {
    headerValidation = 'Needs Review';
  }

  const headerSource = governingContract
    ? `Validator summary + ${governingContract.title || governingContract.name}`
    : 'Validator summary + linked project records';
  const headerGate = validatorSummary.requires_verification_amount != null
    && validatorSummary.requires_verification_amount > 0
    ? `Blocks approval on ${formatMoney(validatorSummary.requires_verification_amount)} requiring verification.`
    : validatorSummary.total_at_risk != null && validatorSummary.total_at_risk > 0
      ? `Shows ${formatMoney(validatorSummary.total_at_risk)} of at-risk variance awaiting confirmation.`
      : approvalGateImpact(approvalLabel);
  const headerAction = validatorSummary.requires_verification_amount != null
    && validatorSummary.requires_verification_amount > 0
    ? 'Open Validator to resolve approval-gated findings.'
    : validatorSummary.total_at_risk != null && validatorSummary.total_at_risk > 0
      ? 'Open Work to review at-risk variance and confirm support.'
      : stageCounts.decide > 0 || stageCounts.act > 0
        ? 'Open Work to clear queued operator items.'
        : approvalNextAction(approvalLabel);

  return (
    <div>
      {/* Identity + Signals + Actions row */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* Left: breadcrumb + title */}
        <div className="min-w-0">
          <nav className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#64748B]">
            <Link href="/platform/workspace" className="text-[#3B82F6] hover:underline">
              Workspace
            </Link>
            <span className="mx-2 text-[#2F3B52]">/</span>
            <span className="text-[#94A3B8]">Project</span>
          </nav>
          <div className="mt-0.5 flex items-baseline gap-2.5">
            <h1 className="truncate text-[17px] font-bold tracking-tight text-[#E5EDF7]">
              {project.name}
            </h1>
            {code ? (
              <span className="shrink-0 font-mono text-[11px] text-[#475569]">{code}</span>
            ) : null}
          </div>
        </div>

        {/* Right: signal badges + actions */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Critical signal */}
          {criticalCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#F87171] ring-1 ring-[#EF4444]/40 bg-[#EF4444]/8">
              <span className="font-mono tabular-nums">{criticalCount}</span>
              <span>Critical</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#34D399] ring-1 ring-[#22C55E]/30 bg-[#22C55E]/8">
              Operationally Clear
            </span>
          )}

          {/* Validator signal */}
            <span
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] ring-1 ${validatorSignalClass(validatorStatus)}`}
            >
              <span>Validator</span>
              <span className="capitalize">{validatorLabel}</span>
              {criticalFindings > 0 ? (
                <span className="font-mono tabular-nums">{criticalFindings}</span>
              ) : null}
            </span>

            {/* Validator readiness (operator-facing) */}
            <span
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] ring-1 ${readinessPillClass(approvalLabel)}`}
              title="Operator readiness state derived from validator summary"
            >
              <span>Approval</span>
              <span>{approvalLabel}</span>
            </span>

          {/* Upload */}
          <Link
            href={uploadHref}
            className="rounded-lg border border-[#3B82F6]/50 bg-[#3B82F6]/15 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#93C5FD] transition hover:bg-[#3B82F6]/25"
          >
            Upload Document
          </Link>

          {/* Classic view */}
          <Link
            href={legacyProjectHref}
            className="rounded-lg border border-[#2F3B52]/80 bg-[#111827] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#64748B] transition hover:border-[#3B82F6]/40 hover:text-[#94A3B8]"
          >
            Classic
          </Link>
        </div>
      </div>

      <div className="mt-2 rounded-lg border border-[#2F3B52]/60 bg-[#0D1526]/80 px-3 py-2.5">
        <div className="grid gap-1.5 text-[10px] uppercase tracking-[0.14em] sm:grid-cols-2 xl:grid-cols-5">
          <p className="text-[#64748B]">
            Value: <span className="font-semibold text-[#E5EDF7]">{approvalLabel}</span>
          </p>
          <p className="text-[#64748B]">
            Source: <span className="font-semibold text-[#94A3B8]">{headerSource}</span>
          </p>
          <p className="text-[#64748B]">
            Validation: <span className="font-semibold text-[#C7D2E3]">{headerValidation}</span>
          </p>
          <p className="text-[#64748B]">
            Gate: <span className="font-semibold text-[#C7D2E3]">{headerGate}</span>
          </p>
          <p className="text-[#64748B]">
            Next: <span className="font-semibold text-[#C7D2E3]">{headerAction}</span>
          </p>
        </div>
      </div>

      {/* Ask This Project */}
      <div className="mt-3">
        <AskProjectSection
          projectId={projectId}
          validatorStatus={validatorStatus}
          criticalFindings={criticalFindings}
          documents={documents}
          decisions={decisions}
          tasks={tasks}
        />
      </div>

      <ProjectIntelligenceSnapshot model={model} documents={documents} />

      {/* Status strip */}
      <StatusStrip stageCounts={stageCounts} decisions={decisions} />
    </div>
  );
}
