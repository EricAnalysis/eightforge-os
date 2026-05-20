'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PortfolioCommandCenter } from '@/components/PortfolioCommandCenter';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import type { PortfolioOverview } from '@/lib/server/portfolioCommandCenter';

export default function PortfolioPage() {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const [portfolio, setPortfolio] = useState<PortfolioOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (orgLoading || !organization?.id) return;

    let cancelled = false;

    const fetchPortfolio = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/portfolio/overview?organizationId=${organization.id}`
        );
        if (!response.ok) {
          if (!cancelled) setError('Failed to load portfolio data. Try again shortly.');
          return;
        }
        const data: PortfolioOverview = await response.json();
        if (!cancelled) setPortfolio(data);
      } catch {
        if (!cancelled) setError('Failed to load portfolio data.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchPortfolio();
    return () => { cancelled = true; };
  }, [organization?.id, orgLoading]);

  if (orgLoading || loading) {
    return (
      <div className="px-6 pt-8 pb-24">
        <PortfolioPageHeader />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-secondary)]"
            />
          ))}
        </div>
        <div className="mt-6 h-96 animate-pulse rounded-2xl border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-secondary)]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-6 pt-8 pb-24">
        <PortfolioPageHeader />
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-4 py-3">
          <p className="text-[11px] font-medium text-[var(--ef-critical-soft)]">{error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-[var(--ef-critical-a30)] px-3 py-1.5 text-[11px] font-medium text-[var(--ef-critical-soft)] transition hover:bg-[var(--ef-critical-a10)]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!portfolio || portfolio.totalProjects === 0) {
    return (
      <div className="px-6 pt-8 pb-24">
        <PortfolioPageHeader />
        <div className="flex flex-col items-center justify-center rounded-2xl border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-secondary)] px-6 py-16 text-center">
          <p className="text-[13px] font-medium text-[var(--ef-text-primary)]">No projects in portfolio</p>
          <p className="mt-2 text-[11px] text-[var(--ef-text-muted)]">
            Projects will appear here once approval snapshots have been generated.
          </p>
          <Link
            href="/platform/projects"
            className="mt-6 rounded-xl bg-[var(--ef-purple-primary)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white transition hover:bg-[var(--ef-purple-glow)]"
          >
            View Projects
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 pt-8 pb-24">
      <PortfolioPageHeader projectCount={portfolio.totalProjects} />
      <PortfolioCommandCenter portfolio={portfolio} />
    </div>
  );
}

function PortfolioPageHeader({ projectCount }: { projectCount?: number }) {
  return (
    <div className="mb-8 flex items-start justify-between gap-4">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--ef-text-muted)]">
          Workspace
        </p>
        <h1 className="mt-2 text-[26px] font-bold tracking-tight text-[var(--ef-text-primary)]">
          Portfolio Command Center
        </h1>
        <p className="mt-1 text-[13px] text-[var(--ef-text-muted)]">
          Workspace-level triage for approval, exposure, and review work
        </p>
      </div>
      {projectCount !== undefined && (
        <div className="mt-1 shrink-0 rounded-full border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-secondary)] px-3 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            {projectCount} {projectCount === 1 ? 'project' : 'projects'}
          </span>
        </div>
      )}
    </div>
  );
}
