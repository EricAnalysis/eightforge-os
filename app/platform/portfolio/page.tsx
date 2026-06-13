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
              className="h-24 animate-pulse rounded-2xl border border-[#2F3B52]/80 bg-[#111827]"
            />
          ))}
        </div>
        <div className="mt-6 h-96 animate-pulse rounded-2xl border border-[#2F3B52]/80 bg-[#111827]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-6 pt-8 pb-24">
        <PortfolioPageHeader />
        <div className="flex items-center justify-between gap-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
          <p className="text-[11px] font-medium text-red-300">{error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-red-500/30 px-3 py-1.5 text-[11px] font-medium text-red-300 transition hover:bg-red-500/10"
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
        <div className="flex flex-col items-center justify-center rounded-2xl border border-[#2F3B52]/80 bg-[#111827] px-6 py-16 text-center">
          <p className="text-[13px] font-medium text-[#E5EDF7]">No projects in portfolio</p>
          <p className="mt-2 text-[11px] text-[#94A3B8]">
            Projects will appear here once approval snapshots have been generated.
          </p>
          <Link
            href="/platform/projects"
            className="mt-6 rounded-xl bg-[#3B82F6] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white transition hover:bg-[#2563EB]"
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
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#94A3B8]">
          Workspace
        </p>
        <h1 className="mt-2 text-[26px] font-bold tracking-tight text-[#E5EDF7]">
          Portfolio Command Center
        </h1>
        <p className="mt-1 text-[13px] text-[#94A3B8]">
          Workspace-level triage for approval, exposure, and review work
        </p>
      </div>
      {projectCount !== undefined && (
        <div className="mt-1 shrink-0 rounded-full border border-[#2F3B52]/80 bg-[#111827] px-3 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#94A3B8]">
            {projectCount} {projectCount === 1 ? 'project' : 'projects'}
          </span>
        </div>
      )}
    </div>
  );
}
