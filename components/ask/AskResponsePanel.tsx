import Link from 'next/link';
import type { AskResponse, GuardedEvidenceItem, ValidationStateLabel } from '@/lib/ask/types';

type AskResponsePanelProps = {
  response: AskResponse;
  projectId: string;
  pending?: boolean;
  onSelectFollowup: (question: string) => void;
};

function sectionHeading(label: string) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
      {label}
    </p>
  );
}

function chipTone(state: ValidationStateLabel | string): string {
  if (state === 'Confirmed' || state === 'Approved') {
    return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
  }
  if (state === 'Approved with Warnings' || state === 'Requires Review') {
    return 'border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
  }
  if (state === 'Blocked') {
    return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]';
  }
  return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)]';
}

function nextActionHref(projectId: string, action: string, evidence: GuardedEvidenceItem[]): string | null {
  if (action === 'No action required') return null;
  if (action === 'Open Validator') return `/platform/projects/${encodeURIComponent(projectId)}#project-validator`;
  if (action === 'Create Execution Item' || action === 'Open Execution Item') return `/platform/projects/${encodeURIComponent(projectId)}#project-execution`;
  if (action === 'Mark Reviewed') return `/platform/projects/${encodeURIComponent(projectId)}#project-documents`;
  if (action === 'Override with Reason') return `/platform/projects/${encodeURIComponent(projectId)}#project-facts`;
  if (action === 'Reprocess Document') return `/platform/projects/${encodeURIComponent(projectId)}#project-documents`;
  if (action === 'Review stale snapshot') return `/platform/projects/${encodeURIComponent(projectId)}#project-validator`;
  if (action === 'Open Evidence') return evidence.find((item) => item.href)?.href ?? `/platform/projects/${encodeURIComponent(projectId)}#project-documents`;
  return `/platform/projects/${encodeURIComponent(projectId)}`;
}

function evidenceTitle(item: GuardedEvidenceItem): string {
  return [
    item.sourceDocumentName,
    item.pageNumber != null ? `Page ${item.pageNumber}` : null,
    item.factNodeKey,
  ].filter(Boolean).join(' / ') || item.layer;
}

export function AskResponsePanel({
  response,
  projectId,
  pending = false,
  onSelectFollowup,
}: AskResponsePanelProps) {
  const sections = response.sections;
  if (!sections) {
    return (
      <section className="rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-overlay)] px-4 py-4">
        <p className="text-[12px] leading-relaxed text-[var(--ef-text-primary)] whitespace-pre-line">
          {response.answer}
        </p>
      </section>
    );
  }

  const actionHref = nextActionHref(projectId, sections.nextAction, sections.evidence);
  const leadFinding = sections.validatorFindings.find((finding) => finding.severity === 'critical') ?? sections.validatorFindings[0] ?? null;
  const gateHasImpact = sections.gateImpact !== 'No gate impact.';

  return (
    <section className="rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[linear-gradient(180deg,var(--ef-surface-overlay),var(--ef-surface-overlay))] px-4 py-4">
      {sections.upstreamGap ? (
        <div className="mb-4 rounded-lg border border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] px-3 py-3">
          <p className="text-[12px] font-semibold text-[var(--ef-warning-soft)]">
            {sections.upstreamGap.message}
          </p>
          <p className="mt-2 text-[11px] text-[var(--ef-text-secondary)]">
            Missing: {sections.upstreamGap.fieldKey} - expected from {sections.upstreamGap.expectedSource}
          </p>
          <p className="mt-1 text-[11px] text-[var(--ef-text-secondary)]">
            Resolution: {sections.upstreamGap.resolutionWorkflow}
          </p>
        </div>
      ) : null}

      <div className={sections.confidenceState === 'Not Found' ? 'rounded-lg border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-3' : ''}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          {sectionHeading('Answer')}
          <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${chipTone(sections.validationState)}`}>
            {sections.confidenceState}
          </span>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--ef-text-primary)]">
          {sections.answer}
        </p>
      </div>

      <details className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] transition hover:text-[var(--ef-text-primary)]">
          Evidence - {sections.evidence.length} item{sections.evidence.length === 1 ? '' : 's'}
          {leadFinding ? ` / ${leadFinding.label}` : ''}
        </summary>

        {sections.validatorFindings.length > 0 ? (
          <div className="mt-3 space-y-2">
            {sections.validatorFindings.map((finding) => (
              <div key={finding.id} className="rounded-lg border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[11px] font-semibold text-[var(--ef-critical-soft)]">{finding.label}</p>
                  <span className={`rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] ${chipTone(finding.severity === 'critical' ? 'Blocked' : 'Requires Review')}`}>
                    {finding.severity}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-[var(--ef-text-secondary)]">Source: {finding.source}</p>
                <p className="mt-1 text-[11px] text-[var(--ef-text-secondary)]">{finding.gateImpact}</p>
                <p className="mt-1 text-[11px] font-semibold text-[var(--ef-text-primary)]">{finding.nextAction}</p>
              </div>
            ))}
          </div>
        ) : null}

        {sections.evidence.length === 0 ? (
          <p className="mt-3 text-[11px] text-[var(--ef-text-muted)]">No evidence anchored to this answer</p>
        ) : (
          <div className="mt-3 space-y-2">
            {sections.evidence.map((item) => (
              <Link
                key={item.id}
                href={item.href ?? `/platform/projects/${encodeURIComponent(projectId)}`}
                className="block rounded-lg border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-primary)] px-3 py-2 transition hover:border-[var(--ef-purple-primary-a40)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold text-[var(--ef-text-primary)]">{item.label}</p>
                  <span className="text-[10px] text-[var(--ef-text-faint)]">Trust {item.trustLevel}</span>
                </div>
                <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">{item.value}</p>
                <p className="mt-1 text-[10px] text-[var(--ef-text-faint)]">{evidenceTitle(item)}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="rounded border border-[var(--ef-border-subtle-a60)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--ef-text-muted)]">
                    {item.layer}
                  </span>
                  {item.isFallback ? (
                    <span className="rounded border border-[var(--ef-warning-a35)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--ef-warning-soft)]">
                      Unverified - raw extraction fallback
                    </span>
                  ) : null}
                  {item.isStale ? (
                    <span className="rounded border border-[var(--ef-warning-a35)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--ef-warning-soft)]">
                      Stale
                    </span>
                  ) : null}
                </div>
              </Link>
            ))}
          </div>
        )}
      </details>

      {response.conflict?.requiresReview ? (
        <div className="mt-4 rounded-lg border border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-warning-soft)]">Conflict</p>
          <p className="mt-1 text-[11px] text-[var(--ef-text-secondary)]">
            Source A - {response.conflict.sourceA.layer} - {response.conflict.sourceA.sourceId}: {response.conflict.sourceA.label}
          </p>
          <p className="mt-1 text-[11px] text-[var(--ef-text-secondary)]">
            Source B - {response.conflict.sourceB.layer} - {response.conflict.sourceB.sourceId}: {response.conflict.sourceB.label}
          </p>
        </div>
      ) : null}

      {response.override ? (
        <div className="mt-4 rounded-lg border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-3 py-2">
          <p className="text-[11px] text-[var(--ef-text-secondary)]">
            Override applied by {response.override.operator} on {response.override.appliedAt}. Overridden source: {response.override.overriddenSource}
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 border-t border-[var(--ef-border-subtle-a50)] pt-3 sm:grid-cols-3">
        <div>
          {sectionHeading('Validation State')}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className={`rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${chipTone(sections.validationState)}`}>
              {sections.validationState}
            </span>
            {sections.blockerCount > 0 ? <span className={chipTone('Blocked') + ' rounded border px-2 py-1 text-[10px]'}>{sections.blockerCount} blockers</span> : null}
            {sections.warningCount > 0 ? <span className={chipTone('Requires Review') + ' rounded border px-2 py-1 text-[10px]'}>{sections.warningCount} warnings</span> : null}
          </div>
          {sections.validationState === 'Not Evaluated' ? (
            <p className="mt-2 text-[11px] text-[var(--ef-text-muted)]">
              This topic has not been evaluated in the current validation snapshot.
            </p>
          ) : null}
        </div>

        <div>
          {sectionHeading('Gate Impact')}
          <p className={`mt-2 text-[11px] leading-relaxed ${gateHasImpact ? 'font-semibold text-[var(--ef-text-primary)]' : 'text-[var(--ef-text-muted)]'}`}>
            {sections.gateImpact}
          </p>
        </div>

        <div>
          {sectionHeading('Next Action')}
          {actionHref ? (
            <Link
              href={actionHref}
              className="mt-2 inline-flex rounded-lg border border-[var(--ef-purple-primary-a40)] bg-[var(--ef-purple-primary-a10)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-purple-glow)]"
            >
              {sections.nextAction}
            </Link>
          ) : (
            <span className="mt-2 inline-flex rounded-lg border border-[var(--ef-border-subtle-a60)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
              No action required
            </span>
          )}
        </div>
      </div>

      {response.relatedQuestions?.length ? (
        <div className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
          {sectionHeading('Follow Up')}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {response.relatedQuestions.map((question) => (
              <button
                key={question}
                type="button"
                disabled={pending}
                onClick={() => onSelectFollowup(question)}
                className="rounded border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] px-2 py-1 text-[10px] text-[var(--ef-text-muted)] transition hover:border-[var(--ef-purple-primary-a40)] hover:text-[var(--ef-purple-glow)] disabled:opacity-40"
              >
                {question}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
