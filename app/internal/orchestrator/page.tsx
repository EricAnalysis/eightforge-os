import { notFound } from 'next/navigation';
import { OrchestratorClient } from '@/app/internal/orchestrator/OrchestratorClient';

export default function InternalOrchestratorPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return <OrchestratorClient />;
}
