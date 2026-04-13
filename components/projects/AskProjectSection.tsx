'use client';

import { AskInterface } from '@/components/ask/AskInterface';
import type { ProjectDecisionRow, ProjectDocumentRow, ProjectTaskRow } from '@/lib/projectOverview';
import type { ValidationStatus } from '@/types/validator';

interface AskProjectSectionProps {
  projectId: string;
  validatorStatus?: ValidationStatus;
  criticalFindings?: number;
  documents?: ProjectDocumentRow[];
  decisions?: ProjectDecisionRow[];
  tasks?: ProjectTaskRow[];
}

export function AskProjectSection({
  projectId,
  validatorStatus = 'NOT_READY',
  criticalFindings = 0,
  documents = [],
  decisions = [],
  tasks = [],
}: AskProjectSectionProps) {
  return (
    <AskInterface
      projectId={projectId}
      context={{
        validatorStatus,
        criticalFindings,
        documents,
        decisions,
        tasks,
      }}
    />
  );
}
