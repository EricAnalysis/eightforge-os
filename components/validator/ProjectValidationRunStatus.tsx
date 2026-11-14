'use client';

import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabaseClient';

export function latestProjectValidationLabel(status: string | null): string {
  switch (status) {
    case 'pending': return 'Pending';
    case 'running': return 'Running';
    case 'complete': return 'Completed';
    case 'failed': return 'Failed';
    default: return 'No verified run status';
  }
}

/** Project run state only. A run is not proof that a particular assertion converged. */
export function ProjectValidationRunStatus({ projectId, refreshKey = 0 }: { projectId: string; refreshKey?: number }) {
  const [state, setState] = useState<{ status: string | null; completedAt: string | null } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const result = await supabase.from('project_validation_runs')
        .select('status, completed_at').eq('project_id', projectId).order('run_at', { ascending: false }).limit(1).maybeSingle();
      if (cancelled) return;
      if (result.error) { setError(true); return; }
      const row = result.data as { status?: unknown; completed_at?: unknown } | null;
      setState({ status: typeof row?.status === 'string' ? row.status : null,
        completedAt: typeof row?.completed_at === 'string' ? row.completed_at : null });
      setError(false);
    };
    void load();
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); window.clearInterval(timer); };
  }, [projectId, refreshKey]);
  return <p className="text-xs text-[var(--ef-text-muted)]" data-testid="project-validation-run-status">
    Latest project validation: {error ? 'Status unavailable' : state ? latestProjectValidationLabel(state.status) : 'Loading'}
    {state?.status === 'complete' && state.completedAt ? ` · ${new Date(state.completedAt).toLocaleString()}` : ''}
    . This project run does not by itself confirm that a particular reviewed value has converged.
  </p>;
}
