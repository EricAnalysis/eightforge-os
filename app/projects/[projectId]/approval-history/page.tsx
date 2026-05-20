/**
 * app/projects/[projectId]/approval-history/page.tsx
 * Approval history timeline page - shows complete evolution of project approval state
 */

import { notFound } from 'next/navigation';
import { ApprovalHistoryTimeline } from '@/components/ApprovalHistoryTimeline';
import { buildApprovalTimeline } from '@/lib/server/approvalTimeline';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

interface PageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ApprovalHistoryPage({ params }: PageProps) {
  const { projectId } = await params;

  // Verify project exists and user has access
  const admin = getSupabaseAdmin();
  if (!admin) {
    return notFound();
  }

  const { data: project, error: projectError } = await admin
    .from('projects')
    .select('id, name, organization_id')
    .eq('id', projectId)
    .single();

  if (projectError || !project) {
    return notFound();
  }

  // Build timeline
  const timeline = await buildApprovalTimeline(projectId, 100);

  if (!timeline) {
    return notFound();
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold mb-2">{project.name}</h1>
        <p className="text-[var(--ef-text-muted)]">
          Approval decision history and timeline
        </p>
      </div>

      {/* Timeline */}
      <div className="rounded-lg border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-6">
        <ApprovalHistoryTimeline timeline={timeline} />
      </div>

      {/* Raw JSON for debugging (optional) */}
      {process.env.NODE_ENV === 'development' && (
        <details className="rounded-lg bg-[var(--ef-surface-elevated)] p-4">
          <summary className="cursor-pointer font-mono text-sm text-[var(--ef-text-muted)]">
            Raw Timeline Data
          </summary>
          <pre className="mt-4 max-h-96 overflow-auto rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] p-4 text-xs text-[var(--ef-text-secondary)]">
            {JSON.stringify(timeline, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

// Revalidate every hour
export const revalidate = 3600;
