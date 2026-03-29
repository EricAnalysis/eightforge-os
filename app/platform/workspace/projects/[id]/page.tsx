'use client';

import Link from 'next/link';
import { use, useMemo } from 'react';
import { ForgeWorkspace, type ForgeWorkspaceModel } from '@/components/workspace/ForgeWorkspace';
import { ProjectOverviewBand } from '@/components/workspace/ProjectOverviewBand';
import { ProjectPageShell } from '@/components/workspace/ProjectPageShell';
import { buildForgeStageCounts } from '@/lib/forgeStageCounts';
import { buildProjectOverviewModel } from '@/lib/projectOverview';
import { useProjectWorkspaceData } from '@/lib/useProjectWorkspaceData';

export default function WorkspaceProjectForgePage({
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

  const forgeModel = useMemo<ForgeWorkspaceModel | null>(() => {
    if (!model) return null;
    return {
      ...model,
      decisions: data.generatedDecisions,
      decision_total: data.generatedDecisions.length,
      decision_empty_state: data.documents.length === 0
        ? model.decision_empty_state
        : 'No operator decisions were generated from the current extracted facts.',
    };
  }, [data.documents.length, data.generatedDecisions, model]);

  const stageCounts = useMemo(() => {
    if (!model) return null;
    return buildForgeStageCounts({
      documents: data.documents,
      decisions: data.decisions,
      tasks: data.tasks,
      auditSurfaceCount: model.audit.length,
      decisionCountOverride: data.generatedDecisions.length,
    });
  }, [data.decisions, data.documents, data.generatedDecisions.length, data.tasks, model]);

  if (data.loading || data.orgLoading) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/workspace" className="text-[11px] text-[#3B82F6] hover:underline">
          Back to workspace
        </Link>
        <p className="text-[11px] text-[#94A3B8]">Loading project…</p>
      </div>
    );
  }

  if (data.pageError) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/workspace" className="text-[11px] text-[#3B82F6] hover:underline">
          Back to workspace
        </Link>
        <div className="rounded-sm border border-[#EF4444]/30 bg-[#EF4444]/10 px-4 py-3 text-[11px] text-[#EF4444]">
          {data.pageError}
        </div>
      </div>
    );
  }

  if (data.notFound || !model || !forgeModel || !stageCounts) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/workspace" className="text-[11px] text-[#3B82F6] hover:underline">
          Back to workspace
        </Link>
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] px-4 py-4 text-[11px] text-[#94A3B8]">
          Project not found, or you no longer have access to it.
        </div>
      </div>
    );
  }

  const uploadHref = `/platform/documents?projectId=${encodeURIComponent(id)}&openUpload=1`;

  return (
    <ProjectPageShell
      project={model.project}
      uploadHref={uploadHref}
      legacyProjectHref={`/platform/projects/${id}`}
      onProjectRefresh={data.refetch}
    >
      {data.loadIssue ? (
        <div className="border-b border-[#F59E0B]/30 bg-[#F59E0B]/10 px-4 py-2 text-[11px] text-[#FBBF24]">
          {data.loadIssue}
        </div>
      ) : null}
      <ProjectOverviewBand model={model} stageCounts={stageCounts} />
      <ForgeWorkspace
        model={forgeModel}
        documents={data.documents}
        decisions={data.decisions}
        tasks={data.tasks}
        onProjectDataRefresh={data.refetch}
      />
    </ProjectPageShell>
  );
}
