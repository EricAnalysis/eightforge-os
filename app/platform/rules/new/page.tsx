'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { RuleForm, type RuleFormPayload } from '@/components/rules/RuleForm';

export default function NewRulePage() {
  const router = useRouter();
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (payload: RuleFormPayload) => {
    setSaving(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError('Authentication required');
        return;
      }

      const res = await fetch('/api/rules', {
        method: 'POST',
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

  if (orgLoading) {
    return (
      <div className="space-y-3">
        <Link href="/platform/rules" className="text-[11px] text-[#8B5CFF] hover:underline">
          ← Rules
        </Link>
        <p className="text-[11px] text-[#8B94A3]">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/platform/rules" className="text-[11px] text-[#8B5CFF] hover:underline">
          ← Rules
        </Link>
        <h2 className="mt-1 text-sm font-semibold text-[#F5F7FA]">New Rule</h2>
      </div>

      {error && (
        <p className="text-[11px] text-red-400">{error}</p>
      )}

      <div className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
        <RuleForm
          organizationId={organizationId}
          onSubmit={handleSubmit}
          onCancel={() => router.push('/platform/rules')}
          submitLabel="Create rule"
          loading={saving}
        />
      </div>
    </div>
  );
}
