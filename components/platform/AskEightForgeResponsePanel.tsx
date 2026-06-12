'use client';

import Link from 'next/link';
import { scopeLabel, type AskAnswerContract } from '@/lib/ask/globalCommand';

type AskEightForgeResponsePanelProps = {
  contract: AskAnswerContract;
  onDismiss: () => void;
  className?: string;
};

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}

function chipTone(value: string, kind: 'state' | 'count' = 'state'): string {
  const normalized = value.toLowerCase();
  if (normalized.includes('blocked') || (kind === 'count' && Number(value) > 0)) {
    return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]';
  }
  if (normalized.includes('warning') || normalized.includes('review')) {
    return 'border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
  }
  if (normalized.includes('clear') || normalized.includes('approved') || normalized.includes('confirmed')) {
    return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
  }
  return 'border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)]';
}

function sectionHeading(label: string) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
      {label}
    </p>
  );
}

function statusCopy(contract: AskAnswerContract): string {
  if (contract.availability === 'available') return 'Routed safely';
  if (contract.availability === 'not_wired') return 'Answer backend not wired';
  return 'Unavailable';
}

function PortfolioResponse({ contract }: { contract: AskAnswerContract }) {
  const sections = contract.portfolioSections;
  if (!sections) return null;

  return (
    <div className="mt-3 space-y-3 text-[12px] text-[var(--ef-text-secondary)]">
      <div className="rounded-xl border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] p-3">
        {sectionHeading('Portfolio Signal')}
        <p className="mt-1 text-[13px] font-semibold leading-relaxed text-[var(--ef-text-primary)]">
          {sections.portfolioSignal}
        </p>
      </div>

      <div className="rounded-xl border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] p-3">
        {sectionHeading('Projects Affected')}
        {sections.projectsAffected.length === 0 ? (
          <p className="mt-2 text-[var(--ef-text-muted)]">No affected projects found.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {sections.projectsAffected.map((project, index) => (
              <Link
                key={project.projectId}
                href={project.handoffHref}
                className="block rounded-lg border border-[var(--ef-border-subtle-a50)] bg-[var(--ef-background-primary)] px-3 py-2 transition hover:border-[var(--ef-purple-primary-a50)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[12px] font-semibold text-[var(--ef-text-primary)]">
                    {index + 1}. {project.projectName}
                  </p>
                  {project.isStale ? (
                    <span className="rounded border border-[var(--ef-warning-a35)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--ef-warning-soft)]">
                      {project.stalenessLabel}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className={`rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] ${chipTone(project.readinessState)}`}>
                    {project.readinessState}
                  </span>
                  <span className={`rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] ${chipTone(project.validationState)}`}>
                    {project.validationState}
                  </span>
                  <span className="rounded border border-[var(--ef-border-subtle-a60)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--ef-text-muted)]">
                    {formatCurrency(project.atRiskAmount)}
                  </span>
                  <span className={`rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] ${project.blockerCount > 0 ? chipTone('blocked') : chipTone('0')}`}>
                    {project.blockerCount} blockers
                  </span>
                  <span className={`rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] ${project.warningCount > 0 ? chipTone('review') : chipTone('0')}`}>
                    {project.warningCount} warnings
                  </span>
                  <span className="rounded border border-[var(--ef-border-subtle-a60)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--ef-text-muted)]">
                    {project.openExecutionItemCount} execution
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] p-3">
        {sectionHeading('Financial Exposure')}
        <p className="mt-1 text-[16px] font-semibold text-[var(--ef-text-primary)]">
          {formatCurrency(sections.financialExposure.totalAtRiskAmount)}
        </p>
        {sections.financialExposure.perProject.length > 1 ? (
          <div className="mt-2 space-y-1">
            {sections.financialExposure.perProject.map((project) => (
              <p key={project.projectId} className="text-[11px] text-[var(--ef-text-muted)]">
                {project.projectName}: {formatCurrency(project.atRiskAmount)}
              </p>
            ))}
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] p-3">
        {sectionHeading('Pattern Detected')}
        <p className={`mt-1 ${sections.patternDetected.exists ? 'text-[var(--ef-text-primary)]' : 'text-[var(--ef-text-muted)]'}`}>
          {sections.patternDetected.label}
        </p>
        {sections.patternDetected.affectedProjects.length > 0 ? (
          <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
            {sections.patternDetected.affectedProjects.join(', ')}
          </p>
        ) : null}
      </div>

      <div className="rounded-xl border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] p-3">
        {sectionHeading('Recommended Action')}
        <p className="mt-1 text-[12px] text-[var(--ef-text-primary)]">
          {sections.recommendedAction.label}
        </p>
        <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
          {sections.recommendedAction.reason}
        </p>
        {sections.recommendedAction.href ? (
          <Link
            href={sections.recommendedAction.href}
            className="mt-3 inline-flex rounded-lg border border-[var(--ef-purple-primary-a40)] bg-[var(--ef-purple-primary-a10)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-purple-glow)]"
          >
            {sections.recommendedAction.workflowName}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function AskEightForgeResponsePanel({
  contract,
  onDismiss,
  className = '',
}: AskEightForgeResponsePanelProps) {
  const portfolioRendered = contract.scope === 'portfolio' && contract.portfolioSections;

  return (
    <div className={`rounded-2xl border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-primary)] p-4 shadow-[0_28px_110px_-60px_var(--ef-shadow-deep)] ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-text-muted)]">
            Ask EightForge
          </p>
          <h2 className="mt-1 text-[13px] font-semibold text-[var(--ef-text-primary)]">
            Scope: {scopeLabel(contract.scope)}
          </h2>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-full border border-[var(--ef-border-subtle-a60)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-text-muted)] transition hover:text-[var(--ef-text-primary)]"
        >
          Close
        </button>
      </div>

      <div className="mt-4 rounded-xl border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] p-3">
        {sectionHeading('Question')}
        <p className="mt-1 text-[12px] text-[var(--ef-text-primary)]">{contract.question}</p>
      </div>

      {portfolioRendered ? (
        <PortfolioResponse contract={contract} />
      ) : (
        <div className="mt-3 space-y-3 text-[12px] text-[var(--ef-text-secondary)]">
          <div className="rounded-xl border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] p-3">
            {sectionHeading('Status')}
            <p className="mt-1 text-[var(--ef-text-primary)]">{statusCopy(contract)}</p>
            {contract.answer ? <p className="mt-2 whitespace-pre-line">{contract.answer}</p> : null}
            {contract.signal ? <p className="mt-2">{contract.signal}</p> : null}
            {contract.pattern ? <p className="mt-2">{contract.pattern}</p> : null}
            {contract.operationalImpact ? <p className="mt-2">{contract.operationalImpact}</p> : null}
          </div>
        </div>
      )}
    </div>
  );
}
