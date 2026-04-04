'use client';

import { AskInterface } from '@/components/ask/AskInterface';
import { buildSuggestedQueries } from '@/components/ask/SuggestedQueries';
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
  const suggestedQueries = buildSuggestedQueries({
    validatorStatus,
    criticalFindings,
    openDecisions: decisions.filter((decision) =>
      ['open', 'in_review'].includes(decision.status),
    ).length,
    documentCount: documents.length,
    processedDocumentCount: documents.filter((document) =>
      Boolean(document.processed_at)
      || ['decisioned', 'extracted', 'failed'].includes(document.processing_status),
    ).length,
    hasContractDocument: documents.some((document) =>
      (document.document_type ?? '').toLowerCase().includes('contract')
      || (document.title ?? document.name).toLowerCase().includes('contract'),
    ),
  });

  return (
    <AskInterface
      projectId={projectId}
      suggestedQueries={
        tasks.length > 0
          ? suggestedQueries
          : suggestedQueries.filter((query) => query.text !== 'What should I do next?')
      }
    />
  );
}
