'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { AskScopeEntry } from '@/components/platform/AskScopeEntry';
import {
  summarizeFeedbackReasons,
  summarizeLowTrustModes,
  summarizeReviewDocumentTypes,
  type AggregateCount,
} from '@/lib/ask/aggregateSummaries';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOperationalModel } from '@/lib/useOperationalModel';

export default function ReviewsPage() {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const { data: operationalModel, loading, error } =
    useOperationalModel(!orgLoading && !!organization?.id);

  const lowTrustModes = useMemo(
    () => summarizeLowTrustModes(operationalModel?.intelligence.low_trust_documents ?? []),
    [operationalModel],
  );

  const feedbackReasons = useMemo(
    () => summarizeFeedbackReasons(operationalModel?.intelligence.recent_feedback_exceptions ?? []),
    [operationalModel],
  );

  const documentTypesNeedingReview = useMemo(
    () => summarizeReviewDocumentTypes(operationalModel?.intelligence.needs_review_documents ?? []),
    [operationalModel],
  );

  return (
    <div className="space-y-6">
      <section className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ef-text-muted)]">
            Macro intelligence
          </p>
          <h2 className="mt-1 text-sm font-semibold text-[var(--ef-text-primary)]">Intelligence</h2>
          <p className="mt-1 text-xs text-[var(--ef-text-muted)]">
            Pattern, quality, override, and improvement signals derived only from available operational records.
          </p>
        </div>
      </section>

      <AskScopeEntry
        scope="intelligence"
        scopeLabel="Intelligence"
        placeholder="Ask about patterns, recurring rule failures, extraction quality, overrides, and system improvement signals."
        chips={[
          'What issues keep recurring?',
          'Which rule fails most often?',
          'Which document type needs the most review?',
          'Where are humans overriding facts?',
          'What extraction mode is least reliable?',
          'What should we improve first?',
        ]}
      />

      {error ? (
        <div className="rounded-lg border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-4 py-3">
          <p className="text-[11px] font-medium text-[var(--ef-critical)]">{error}</p>
        </div>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-2">
        <PatternSection
          title="Document Extraction Quality Signals"
          description="Current low-trust extraction modes from documents already flagged by the operational model."
          loading={loading}
          items={lowTrustModes}
          emptyCopy="No extraction reliability trend is available yet because extraction confidence history is incomplete."
        />

        <PatternSection
          title="Human Override And Feedback Patterns"
          description="Recent correction, escalation, and review-error categories from persisted feedback exceptions."
          loading={loading}
          items={feedbackReasons}
          emptyCopy="No human override trend is available yet because no override or correction events were found."
        />

        <PatternSection
          title="Review Bottlenecks By Document Type"
          description="Current document types represented in records waiting for review."
          loading={loading}
          items={documentTypesNeedingReview}
          emptyCopy="No document-type review bottleneck can be calculated yet because no linked documents currently need review."
        />

        <EmptyPatternSection
          title="Rule Failure Leaderboard"
          description="No recurring validation pattern can be calculated yet because validator history is unavailable to this page."
        />

        <EmptyPatternSection
          title="Project Trend Signals"
          description="No project trend signal is shown because historical validation or readiness snapshots are not wired here."
        />

        <EmptyPatternSection
          title="Audit Driven Operational Recommendations"
          description="No recommendation is generated because this pass does not derive recommendations beyond deterministic exposed aggregates."
        />
      </section>

      <section className="rounded-lg border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-secondary)] p-4">
        <h3 className="text-sm font-semibold text-[var(--ef-text-primary)]">Operational Triage Moved</h3>
        <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
          Open decisions, open actions, needs review documents, blocked documents, low trust document queues, high risk counts, and recent feedback exceptions now live in Portfolio diagnostics.
        </p>
        <Link
          href="/platform/portfolio#portfolio-diagnostics-heading"
          className="mt-3 inline-flex text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-primary)] transition hover:text-[var(--ef-purple-glow)]"
        >
          Open Portfolio Diagnostics
        </Link>
      </section>
    </div>
  );
}

function PatternSection({
  title,
  description,
  loading,
  items,
  emptyCopy,
}: {
  title: string;
  description: string;
  loading: boolean;
  items: AggregateCount[];
  emptyCopy: string;
}) {
  return (
    <section className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
      <div className="mb-3 border-b border-[var(--ef-surface-elevated)] pb-3">
        <h3 className="text-sm font-semibold text-[var(--ef-text-primary)]">{title}</h3>
        <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">{description}</p>
      </div>

      {loading ? (
        <p className="text-[11px] text-[var(--ef-text-muted)]">Loading...</p>
      ) : items.length === 0 ? (
        <p className="text-[11px] text-[var(--ef-text-muted)]">{emptyCopy}</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.label}
              className="flex items-center justify-between gap-3 rounded-md border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-3 py-3"
            >
              <span className="text-[12px] font-medium capitalize text-[var(--ef-text-primary)]">{item.label}</span>
              <span className="rounded-full border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-purple-glow)]">
                {item.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyPatternSection({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
      <div className="mb-3 border-b border-[var(--ef-surface-elevated)] pb-3">
        <h3 className="text-sm font-semibold text-[var(--ef-text-primary)]">{title}</h3>
      </div>
      <p className="text-[11px] text-[var(--ef-text-muted)]">{description}</p>
    </section>
  );
}
