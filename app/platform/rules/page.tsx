'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

type RuleRow = {
  id: string;
  organization_id: string | null;
  domain: string;
  document_type: string;
  rule_group: string | null;
  name: string;
  decision_type: string;
  severity: string;
  priority: number;
  status: string;
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    inactive: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[status] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
    high: 'bg-orange-500/20 text-orange-400 border border-orange-500/40',
    medium: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    low: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[severity] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {severity}
    </span>
  );
}

export default function RulesPage() {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;

  const [rules, setRules] = useState<RuleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId || orgLoading) return;

    setLoading(true);
    setListError(null);
    supabase
      .from('rules')
      .select('id, organization_id, domain, document_type, rule_group, name, decision_type, severity, priority, status')
      .or(`organization_id.eq.${organizationId},organization_id.is.null`)
      .order('priority', { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          setListError('Failed to load rules.');
          setRules([]);
        } else {
          setRules(data as RuleRow[]);
        }
        setLoading(false);
      });
  }, [organizationId, orgLoading]);

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">Rules</h2>
          <p className="text-xs text-[#8B94A3]">
            Manage deterministic rules for document evaluation. Rules are evaluated by domain and document type.
          </p>
        </div>
        <div className="shrink-0">
          <Link
            href="/platform/rules/new"
            className="inline-block rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8]"
          >
            New Rule
          </Link>
        </div>
      </section>

      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-3">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Rule list</div>

        {listError ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] font-medium text-red-400">{listError}</p>
          </div>
        ) : loading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No rules yet. Create a rule to evaluate documents.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-[11px]">
              <thead className="border-b border-[#1A1A3E] text-left text-[#8B94A3]">
                <tr>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Name</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Domain</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Document type</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Decision type</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Severity</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Priority</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Status</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Rule group</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Scope</th>
                  <th className="py-2 font-medium text-[#F5F7FA]"></th>
                </tr>
              </thead>
              <tbody className="text-[#F5F7FA]">
                {rules.map((r) => (
                  <tr key={r.id} className="border-b border-[#1A1A3E] last:border-b-0">
                    <td className="py-2 pr-3 font-medium">{r.name}</td>
                    <td className="py-2 pr-3">{r.domain}</td>
                    <td className="py-2 pr-3">{r.document_type}</td>
                    <td className="py-2 pr-3">{r.decision_type}</td>
                    <td className="py-2 pr-3">
                      <SeverityBadge severity={r.severity} />
                    </td>
                    <td className="py-2 pr-3">{r.priority}</td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="py-2 pr-3">{r.rule_group ?? '—'}</td>
                    <td className="py-2 pr-3 text-[#8B94A3]">
                      {r.organization_id ? 'Org' : 'Global'}
                    </td>
                    <td className="py-2">
                      <Link
                        href={`/platform/rules/${r.id}/edit`}
                        className="text-[#8B5CFF] hover:underline"
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
