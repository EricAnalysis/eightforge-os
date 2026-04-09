'use client';

import { ContextSidebar } from '@/components/workspace/ContextSidebar';
import { DecisionActionQueue } from '@/components/workspace/DecisionActionQueue';
import { ProjectTruthSnapshot } from '@/components/workspace/ProjectTruthSnapshot';
import type { ProjectOverviewModel, ProjectDecisionRow, ProjectDocumentRow, ProjectTaskRow } from '@/lib/projectOverview';

type WorkTabProps = {
  projectId: string;
  model: ProjectOverviewModel;
  documents: ProjectDocumentRow[];
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
  uploadHref: string;
};

export function WorkTab({
  projectId,
  model,
  documents,
  decisions,
  tasks,
  uploadHref,
}: WorkTabProps) {
  return (
    <div className="flex min-h-0 flex-1">
      {/* Left 70%: unified work queue */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ flexBasis: '70%' }}>
        <ProjectTruthSnapshot projectId={projectId} model={model} decisions={decisions} />
        <DecisionActionQueue
          decisions={decisions}
          tasks={tasks}
          documents={documents}
          uploadHref={uploadHref}
        />
      </div>

      {/* Right 30%: context sidebar */}
      <ContextSidebar model={model} documents={documents} projectId={projectId} />
    </div>
  );
}
