'use client';

import Link from 'next/link';
import { use, useMemo } from 'react';
import { ProjectOverview } from '@/components/projects/ProjectOverview';
import { ValidatorTab } from '@/components/projects/ValidatorTab';
import { buildProjectOverviewModel } from '@/lib/projectOverview';
import { useProjectWorkspaceData } from '@/lib/useProjectWorkspaceData';

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const data = useProjectWorkspaceData(id);

  const model = useMemo(() => {
    if (!data.project) return null;
    return buildProjectOverviewModel({
      project: data.project,
      documents: data.documents,
      documentReviews: data.documentReviews,
      decisions: data.decisions,
      tasks: data.tasks,
      activityEvents: data.activityEvents,
      members: data.members,
      validationFindings: data.validationFindings,
    });
  }, [
    data.activityEvents,
    data.decisions,
    data.documentReviews,
    data.documents,
    data.members,
    data.project,
    data.tasks,
    data.validationFindings,
  ]);

  if (data.loading || data.orgLoading) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/projects" className="text-[11px] text-[var(--ef-purple-primary)] hover:underline">
          Back to projects
        </Link>
        <p className="text-[11px] text-[var(--ef-text-muted)]">Loading project overview...</p>
      </div>
    );
  }

  if (data.pageError) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/projects" className="text-[11px] text-[var(--ef-purple-primary)] hover:underline">
          Back to projects
        </Link>
        <div className="rounded-sm border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-4 py-3 text-[11px] text-[var(--ef-critical)]">
          {data.pageError}
        </div>
      </div>
    );
  }

  if (data.notFound || !model) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/projects" className="text-[11px] text-[var(--ef-purple-primary)] hover:underline">
          Back to projects
        </Link>
        <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-4 py-4 text-[11px] text-[var(--ef-text-muted)]">
          Project not found, or you no longer have access to it.
        </div>
      </div>
    );
  }

  return (
    <ProjectOverview
      model={model}
      documents={data.documents}
      documentRelationships={data.documentRelationships}
      transactionDatasets={data.transactionDatasets}
      transactionSummary={data.transactionSummary}
      validationFindings={data.validationFindings}
      validationEvidence={data.validationEvidence}
      executionItems={data.executionItems}
      decisions={data.decisions}
      tasks={data.tasks}
      activityEvents={data.activityEvents}
      loadIssue={data.loadIssue}
      onProjectRefresh={data.refetch}
      validatorTab={(issueObjects) => (
        <ValidatorTab
          projectId={id}
          documents={data.documents}
          transactionDatasets={data.transactionDatasets}
          validationEvidence={data.validationEvidence}
          issueObjects={issueObjects}
          findingsEmptyState={model.decision_empty_state}
          onProjectRefresh={data.refetch}
        />
      )}
    />
  );
}
