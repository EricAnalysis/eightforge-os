'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

type WorkflowRow = {
  id: string;
  name: string;
  status: string;
  created_at: string;
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]',
    live: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    archived: 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]',
    failed: 'bg-red-500/20 text-red-400 border border-red-500/40',
  };
  const cls = map[status] ?? 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

export default function WorkflowsPage() {
  const { organization } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      if (!organizationId) {
        setLoading(false);
        return;
      }
      const { data, error } = await supabase
        .from('workflows')
        .select('id, name, status, created_at')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false });
      if (!error && data) setWorkflows(data as WorkflowRow[]);
      setLoading(false);
    };
    load();
  }, [organizationId]);

  const handleCreateWorkflow = () => {
    console.log('Create Workflow placeholder');
  };

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F1F3F5]">
            Workflows
          </h2>
          <p className="text-xs text-[#8B94A3]">
            Workflow Builder for orchestrating operational processes across
            EightForge OS.
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            onClick={handleCreateWorkflow}
            className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0]"
          >
            Create Workflow
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[11px] font-medium text-[#F1F3F5]">
            Workflow list
          </div>
          <button
            type="button"
            onClick={handleCreateWorkflow}
            className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0]"
          >
            Create Workflow
          </button>
        </div>

        {loading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : workflows.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No workflows yet. Create a workflow to get started.
          </p>
        ) : (
          <table className="w-full border-collapse text-[11px] text-[#8B94A3]">
            <thead className="border-b border-[#1A1F27] text-left">
              <tr>
                <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Workflow name</th>
                <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Status</th>
                <th className="py-2 font-medium text-[#F1F3F5]">Created date</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => (
                <tr key={w.id} className="border-b border-[#1A1F27]">
                  <td className="py-2 pr-3">{w.name}</td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={w.status} />
                  </td>
                  <td className="py-2">{new Date(w.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
