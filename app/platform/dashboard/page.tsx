'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

type DashboardCounts = {
  documents: number;
  liveWorkflows: number;
  decisionPolicies: number;
};

function StatusTile({
  title,
  value,
  note,
  href,
}: {
  title: string;
  value: string;
  note: string;
  href?: string;
}) {
  const content = (
    <>
      <div className="text-[11px] font-medium text-[#F1F3F5]">{title}</div>
      <div className="mt-2 text-2xl font-semibold text-[#F1F3F5]">{value}</div>
      <div className="mt-1 text-[11px] text-[#8B94A3]">{note}</div>
    </>
  );
  const className =
    'rounded-lg border border-[#1A1F27] bg-[#0F1115] px-3 py-3 block' +
    (href ? ' cursor-pointer hover:border-[#252a33] hover:bg-[#13161c] transition-colors' : '');
  if (href) {
    return <Link href={href} className={className}>{content}</Link>;
  }
  return <div className={className}>{content}</div>;
}

export default function DashboardPage() {
  const { organization, loading: orgLoading } = useCurrentOrg();

  const [counts, setCounts] = useState<DashboardCounts>({
    documents: 0,
    liveWorkflows: 0,
    decisionPolicies: 0,
  });

  const [loadingCounts, setLoadingCounts] = useState(true);

  useEffect(() => {
    const fetchCounts = async () => {
      if (!organization?.id) {
        setLoadingCounts(false);
        return;
      }

      try {
        const [documentsResult, workflowsResult, decisionsResult] =
          await Promise.all([
            supabase
              .from('documents')
              .select('*', { count: 'exact', head: true })
              .eq('organization_id', organization.id),

            supabase
              .from('workflows')
              .select('*', { count: 'exact', head: true })
              .eq('organization_id', organization.id)
              .eq('status', 'live'),

            supabase
              .from('decision_policies')
              .select('*', { count: 'exact', head: true })
              .eq('organization_id', organization.id),
          ]);

        if (documentsResult.error) {
          console.error('Documents count error:', documentsResult.error.message);
        }

        if (workflowsResult.error) {
          console.error('Workflows count error:', workflowsResult.error.message);
        }

        if (decisionsResult.error) {
          console.error('Decision policies count error:', decisionsResult.error.message);
        }

        setCounts({
          documents: documentsResult.count ?? 0,
          liveWorkflows: workflowsResult.count ?? 0,
          decisionPolicies: decisionsResult.count ?? 0,
        });
      } catch (err) {
        console.error('Unexpected dashboard count error:', err);
      } finally {
        setLoadingCounts(false);
      }
    };

    fetchCounts();
  }, [organization?.id]);

  const isLoading = orgLoading || loadingCounts;

  return (
    <div className="space-y-6">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F1F3F5]">
            Dashboard
          </h2>
          <p className="text-xs text-[#8B94A3]">
            Operations Command Center for EightForge OS. This view surfaces workflows,
            decisions, and operational risk in real time.
          </p>
          <p className="mt-1 text-[11px] text-[#8B94A3]">
            Organization: {organization?.name ?? 'No organization found'}
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            className="rounded-md bg-[#1A1F27] px-3 py-2 text-[11px] font-medium text-[#F1F3F5] hover:bg-[#252a33]"
          >
            Refresh
          </button>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-5">
        <StatusTile
          title="Documents Ingested"
          value={isLoading ? '...' : counts.documents.toString()}
          note="Live count from Supabase"
          href="/platform/documents"
        />

        <StatusTile
          title="Workflows Running"
          value={isLoading ? '...' : counts.liveWorkflows.toString()}
          note="Live workflows only"
          href="/platform/workflows"
        />

        <StatusTile
          title="Decision Policies"
          value={isLoading ? '...' : counts.decisionPolicies.toString()}
          note="Live count from Supabase"
          href="/platform/decisions"
        />

        <StatusTile
          title="Compliance Alerts"
          value="—"
          note="Mocked for now"
        />

        <StatusTile
          title="SLA Risks"
          value="—"
          note="Mocked for now"
        />
      </section>

      <section className="grid gap-4 md:grid-cols-[2fr,1.4fr]">
        <div className="space-y-3">
          <div className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
            <div className="text-[11px] font-medium text-[#F1F3F5]">
              Workflow Map
            </div>
            <div className="mt-2 text-[11px] text-[#8B94A3]">
              Ticket Intake → QA Review → Compliance Validation → Approval → Billing
            </div>
          </div>

          <div className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
            <div className="text-[11px] font-medium text-[#F1F3F5]">
              Human Work Queue
            </div>
            <div className="mt-2 text-[11px] text-[#8B94A3]">
              Items requiring human review will appear here: approvals, rule
              conflicts, and data mismatches.
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
            <div className="text-[11px] font-medium text-[#F1F3F5]">
              Automated Decisions Summary
            </div>
            <div className="mt-2 text-[11px] text-[#8B94A3]">
              Decision volume, override rate, and confidence scores will be shown here.
            </div>
          </div>

          <div className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
            <div className="text-[11px] font-medium text-[#F1F3F5]">
              Operational Insights
            </div>
            <div className="mt-2 text-[11px] text-[#8B94A3]">
              Exception trends, SLA risk, and optimization opportunities will surface here.
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
