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
        <p className="text-gray-600 dark:text-gray-400">
          Approval decision history and timeline
        </p>
      </div>

      {/* Timeline */}
      <div className="bg-white dark:bg-gray-950 rounded-lg border border-gray-200 dark:border-gray-800 p-6">
        <ApprovalHistoryTimeline timeline={timeline} />
      </div>

      {/* Raw JSON for debugging (optional) */}
      {process.env.NODE_ENV === 'development' && (
        <details className="bg-gray-100 dark:bg-gray-900 rounded-lg p-4">
          <summary className="cursor-pointer font-mono text-sm text-gray-600 dark:text-gray-400">
            Raw Timeline Data
          </summary>
          <pre className="mt-4 overflow-auto max-h-96 text-xs bg-white dark:bg-gray-950 p-4 rounded border border-gray-300 dark:border-gray-700">
            {JSON.stringify(timeline, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

// Revalidate every hour
export const revalidate = 3600;
