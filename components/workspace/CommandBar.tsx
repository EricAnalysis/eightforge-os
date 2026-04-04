'use client';

import Link from 'next/link';
import { AskProjectSection } from '@/components/projects/AskProjectSection';
import type { ProjectOverviewModel, ProjectRecord } from '@/lib/projectOverview';
import type { ForgeStageCounts } from '@/lib/forgeStageCounts';
import type { ProjectDecisionRow, ProjectDocumentRow, ProjectTaskRow } from '@/lib/projectOverview';

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
            {criticalFindings > 0 ? (
              <span className="font-mono tabular-nums">{criticalFindings}C</span>
            ) : (
              <span className="capitalize">{validatorStatus.replace(/_/g, ' ')}</span>
            )}
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

      {/* Status strip */}
      <StatusStrip stageCounts={stageCounts} decisions={decisions} />
    </div>
  );
}
