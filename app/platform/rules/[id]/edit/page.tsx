'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { RuleForm, type RuleFormPayload } from '@/components/rules/RuleForm';

type RuleRecord = {
  id: string;
  organization_id: string | null;
  domain: string;
  document_type: string;
  rule_group: string | null;
  name: string;
  description: string | null;
  decision_type: string;
  severity: string;
  priority: number;
  status: string;
  condition_json: RuleFormPayload['condition_json'];
  action_json: RuleFormPayload['action_json'];
};

export default function EditRulePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const [rule, setRule] = useState<RuleRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('rules')
      .select('id, organization_id, domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json')
      .eq('id', id)
      .single()
      .then(({ data, error: e }) => {
        if (e || !data) {
          setNotFound(true);
        } else {
          setRule(data as RuleRecord);
        }
        setLoading(false);
      });
  }, [id]);

  const handleSubmit = async (payload: RuleFormPayload) => {
    setSaving(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError('Authentication required');
        return;
      }

      const res = await fetch(`/api/rules/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          domain: payload.domain,
          document_type: payload.document_type,
          rule_group: payload.rule_group,
          name: payload.name,
          description: payload.description,
          decision_type: payload.decision_type,
          severity: payload.severity,
          priority: payload.priority,
          status: payload.status,
          condition_json: payload.condition_json,
          action_json: payload.action_json,
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? 'Failed to save rule');
      router.push('/platform/rules');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  if (orgLoading || loading) {
    return (
      <div className="space-y-3">
        <Link href="/platform/rules" className="text-[11px] text-[#8B5CFF] hover:underline">
          ← Rules
        </Link>
        <p className="text-[11px] text-[#8B94A3]">Loading…</p>
      </div>
    );
  }

  if (notFound || !rule) {
    return (
      <div className="space-y-3">
        <Link href="/platform/rules" className="text-[11px] text-[#8B5CFF] hover:underline">
          ← Rules
        </Link>
        <p className="text-[11px] text-[#8B94A3]">Rule not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/platform/rules" className="text-[11px] text-[#8B5CFF] hover:underline">
          ← Rules
        </Link>
        <h2 className="mt-1 text-sm font-semibold text-[#F5F7FA]">Edit Rule</h2>
        <p className="text-[11px] text-[#8B94A3]">{rule.name}</p>
      </div>

      {error && (
        <p className="text-[11px] text-red-400">{error}</p>
      )}

      <div className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
        <RuleForm
          initial={{
            domain: rule.domain,
            document_type: rule.document_type,
            rule_group: rule.rule_group,
            name: rule.name,
            description: rule.description,
            decision_type: rule.decision_type,
            severity: rule.severity,
            priority: rule.priority,
            status: rule.status,
            condition_json:
              rule.condition_json && Array.isArray((rule.condition_json as { conditions?: unknown[] }).conditions)
                ? rule.condition_json
                : { match_type: 'all' as const, conditions: [] },
            action_json: rule.action_json && typeof rule.action_json === 'object' ? rule.action_json : {},
            organization_id: rule.organization_id,
          }}
          organizationId={organizationId}
          onSubmit={handleSubmit}
          onCancel={() => router.push('/platform/rules')}
          submitLabel="Save changes"
          loading={saving}
        />
      </div>
    </div>
  );
}
