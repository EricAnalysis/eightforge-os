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
    active: 'bg-[var(--ef-success-a20)] text-[var(--ef-success)] border border-[var(--ef-success-a40)]',
    inactive: 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]',
  };
  const cls = map[status] ?? 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: 'bg-[var(--ef-critical-a20)] text-[var(--ef-critical)] border border-[var(--ef-critical-a40)]',
    high: 'bg-[var(--ef-warning-a20)] text-[var(--ef-warning)] border border-[var(--ef-warning-a40)]',
    medium: 'bg-[var(--ef-warning-a20)] text-[var(--ef-warning)] border border-[var(--ef-warning-a40)]',
    low: 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]',
  };
  const cls = map[severity] ?? 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]';
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
          <h2 className="mb-1 text-sm font-semibold text-[var(--ef-text-primary)]">Rules</h2>
          <p className="text-xs text-[var(--ef-text-muted)]">
            Manage deterministic rules for document evaluation. Rules are evaluated by domain and document type.
          </p>
        </div>
        <div className="shrink-0">
          <Link
            href="/platform/rules/new"
            className="inline-block rounded-md bg-[var(--ef-purple-primary)] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-primary)] hover:bg-[var(--ef-purple-glow)]"
          >
            New Rule
          </Link>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-3">
        <div className="mb-3 text-[11px] font-medium text-[var(--ef-text-primary)]">Rule list</div>

        {listError ? (
          <div className="rounded-md border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-3 py-2">
            <p className="text-[11px] font-medium text-[var(--ef-critical)]">{listError}</p>
          </div>
        ) : loading ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">
            No rules yet. Create a rule to evaluate documents.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-[11px]">
              <thead className="border-b border-[var(--ef-surface-elevated)] text-left text-[var(--ef-text-muted)]">
                <tr>
                  <th className="py-2 pr-3 font-medium text-[var(--ef-text-primary)]">Name</th>
                  <th className="py-2 pr-3 font-medium text-[var(--ef-text-primary)]">Domain</th>
                  <th className="py-2 pr-3 font-medium text-[var(--ef-text-primary)]">Document type</th>
                  <th className="py-2 pr-3 font-medium text-[var(--ef-text-primary)]">Decision type</th>
                  <th className="py-2 pr-3 font-medium text-[var(--ef-text-primary)]">Severity</th>
                  <th className="py-2 pr-3 font-medium text-[var(--ef-text-primary)]">Priority</th>
                  <th className="py-2 pr-3 font-medium text-[var(--ef-text-primary)]">Status</th>
                  <th className="py-2 pr-3 font-medium text-[var(--ef-text-primary)]">Rule group</th>
                  <th className="py-2 pr-3 font-medium text-[var(--ef-text-primary)]">Scope</th>
                  <th className="py-2 font-medium text-[var(--ef-text-primary)]"></th>
                </tr>
              </thead>
              <tbody className="text-[var(--ef-text-primary)]">
                {rules.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--ef-surface-elevated)] last:border-b-0">
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
                    <td className="py-2 pr-3 text-[var(--ef-text-muted)]">
                      {r.organization_id ? 'Org' : 'Global'}
                    </td>
                    <td className="py-2">
                      <Link
                        href={`/platform/rules/${r.id}/edit`}
                        className="text-[var(--ef-purple-primary)] hover:underline"
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
