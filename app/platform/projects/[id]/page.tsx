'use client';

import Link from 'next/link';
import { use, useMemo } from 'react';
import { ValidatorTab } from '@/app/platform/workspace/projects/[id]/ValidatorTab';
import { ProjectOverview } from '@/components/projects/ProjectOverview';
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
    });
  }, [
    data.activityEvents,
    data.decisions,
    data.documentReviews,
    data.documents,
    data.members,
    data.project,
    data.tasks,
  ]);

  if (data.loading || data.orgLoading) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/projects" className="text-[11px] text-[#3B82F6] hover:underline">
          Back to projects
        </Link>
        <p className="text-[11px] text-[#94A3B8]">Loading project overview...</p>
      </div>
    );
  }

  if (data.pageError) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/projects" className="text-[11px] text-[#3B82F6] hover:underline">
          Back to projects
        </Link>
        <div className="rounded-sm border border-[#EF4444]/30 bg-[#EF4444]/10 px-4 py-3 text-[11px] text-[#EF4444]">
          {data.pageError}
        </div>
      </div>
    );
  }

  if (data.notFound || !model) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/projects" className="text-[11px] text-[#3B82F6] hover:underline">
          Back to projects
        </Link>
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] px-4 py-4 text-[11px] text-[#94A3B8]">
          Project not found, or you no longer have access to it.
        </div>
      </div>
    );
  }

  return (
    <ProjectOverview
      model={model}
      loadIssue={data.loadIssue}
      onProjectRefresh={data.refetch}
      validatorTab={<ValidatorTab projectId={id} />}
    />
  );
}
