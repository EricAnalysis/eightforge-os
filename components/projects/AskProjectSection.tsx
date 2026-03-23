'use client';

import { AskDocumentSection } from '@/components/document-intelligence/AskDocumentSection';
import type { SuggestedQuestion } from '@/lib/types/documentIntelligence';

const PROJECT_QUESTIONS: SuggestedQuestion[] = [
  {
    id: 'project:invoice-ceiling',
    question: 'What invoices exceed contract ceiling',
    intent: 'risk',
  },
  {
    id: 'project:ticket-quantity',
    question: 'Which tickets are missing quantity support',
    intent: 'risk',
  },
  {
    id: 'project:pending-review',
    question: 'What documents in this project are still pending review',
    intent: 'action',
  },
];

interface AskProjectSectionProps {
  projectId: string;
}

export function AskProjectSection({ projectId }: AskProjectSectionProps) {
  return (
    <AskDocumentSection
      title="Ask This Project"
      questions={PROJECT_QUESTIONS}
      projectId={projectId}
      endpoint="/api/ask/project"
    />
  );
}
