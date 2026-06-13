/**
 * lib/operatorGraph.ts
 * Derives operator pipeline graph data from the operational model.
 * Five stages: Documents → Truth → Decision → Enforcement → Execution
 */

import type { OperationalQueueModel } from '@/lib/server/operationalQueue';

export type OperatorGraphStage =
  | 'documents'
  | 'truth'
  | 'decision'
  | 'enforcement'
  | 'execution';

/** Visual status of a pipeline stage. */
export type OperatorGraphStatus = 'ok' | 'review' | 'blocked' | 'active' | 'loading';

export type OperatorGraphNode = {
  stage: OperatorGraphStage;
  label: string;
  sublabel: string;
  count: number | null;
  countLabel: string;
  amount: number | null;
  status: OperatorGraphStatus;
  statusLabel: string;
  href: string;
};

export type OperatorGraphData = {
  nodes: OperatorGraphNode[];
};

type PortfolioSummary = {
  totalRequiresVerification: number;
  totalAtRisk: number;
  projectsRequiringReview: number;
};

/** Loading skeleton returned when the operational model is not yet available. */
function loadingGraph(): OperatorGraphData {
  const stages: Array<Pick<OperatorGraphNode, 'stage' | 'label' | 'sublabel' | 'countLabel' | 'href'>> = [
    { stage: 'documents', label: 'Documents', sublabel: 'Uploaded', countLabel: 'recent', href: '/platform/documents' },
    { stage: 'truth', label: 'Truth', sublabel: 'Facts Extracted', countLabel: 'processed', href: '/platform/documents' },
    { stage: 'decision', label: 'Decision', sublabel: 'Open Decisions', countLabel: 'open', href: '/platform/decisions' },
    { stage: 'enforcement', label: 'Enforcement', sublabel: 'Approval Status', countLabel: 'pending', href: '/platform/decisions' },
    { stage: 'execution', label: 'Execution', sublabel: 'Tasks Created', countLabel: 'tasks', href: '/platform/decisions' },
  ];
  return {
    nodes: stages.map((s) => ({
      ...s,
      count: null,
      amount: null,
      status: 'loading',
      statusLabel: 'Loading',
    })),
  };
}

/**
 * Build graph data from the operational model and optional portfolio summary.
 * All data comes from already-fetched sources — no new API calls.
 */
export function buildOperatorGraphData(
  model: OperationalQueueModel | null,
  portfolio: PortfolioSummary | null,
): OperatorGraphData {
  if (!model) return loadingGraph();

  const { intelligence, project_rollups, recent_documents_count } = model;

  // ── Documents ──────────────────────────────────────────────────────────────
  const docCount = recent_documents_count ?? 0;
  const lowTrust = intelligence.low_trust_document_count;
  const docStatus: OperatorGraphStatus = lowTrust > 0 ? 'review' : 'ok';

  // ── Truth (Extraction) ─────────────────────────────────────────────────────
  // Sum of processed_document_count across all project rollups gives total
  // documents that have passed the extraction stage.
  const extractedCount = project_rollups.reduce(
    (sum, item) => sum + item.rollup.processed_document_count,
    0,
  );
  const truthStatus: OperatorGraphStatus = lowTrust > 0 ? 'review' : 'ok';

  // ── Decision ───────────────────────────────────────────────────────────────
  const openDecisions = intelligence.open_decisions_count;
  const blockedCount = intelligence.blocked_count;
  const needsReviewCount = intelligence.needs_review_count;
  const highRisk = intelligence.high_risk_count;
  const decisionStatus: OperatorGraphStatus =
    blockedCount > 0 ? 'blocked'
    : needsReviewCount > 0 ? 'review'
    : openDecisions > 0 ? 'active'
    : 'ok';
  const decisionStatusLabel =
    blockedCount > 0 ? `${blockedCount} blocked`
    : highRisk > 0 ? `${highRisk} high risk`
    : needsReviewCount > 0 ? `${needsReviewCount} in review`
    : openDecisions > 0 ? 'Active' : 'Clear';

  // ── Enforcement ────────────────────────────────────────────────────────────
  // Pending enforcement = items requiring review + blocked items across all projects.
  const enforcementCount = needsReviewCount + blockedCount;
  const enforcementAmount =
    portfolio !== null
      ? portfolio.totalRequiresVerification + portfolio.totalAtRisk
      : null;
  const enforcementStatus: OperatorGraphStatus =
    blockedCount > 0 ? 'blocked' : needsReviewCount > 0 ? 'review' : 'ok';
  const enforcementStatusLabel =
    blockedCount > 0 ? 'Blocked'
    : needsReviewCount > 0 ? 'Needs review'
    : 'Clear';

  // ── Execution ──────────────────────────────────────────────────────────────
  const openActions = intelligence.open_actions_count;
  const executionStatus: OperatorGraphStatus = openActions > 0 ? 'active' : 'ok';

  return {
    nodes: [
      {
        stage: 'documents',
        label: 'Documents',
        sublabel: 'Uploaded',
        count: docCount,
        countLabel: 'recent',
        amount: null,
        status: docStatus,
        statusLabel: lowTrust > 0 ? `${lowTrust} low trust` : 'Extracted',
        href: '/platform/documents',
      },
      {
        stage: 'truth',
        label: 'Truth',
        sublabel: 'Facts Extracted',
        count: extractedCount,
        countLabel: 'processed',
        amount: null,
        status: truthStatus,
        statusLabel: lowTrust > 0 ? 'Low trust surface' : 'High fidelity',
        href: '/platform/documents',
      },
      {
        stage: 'decision',
        label: 'Decision',
        sublabel: 'Open Decisions',
        count: openDecisions,
        countLabel: 'open',
        amount: null,
        status: decisionStatus,
        statusLabel: decisionStatusLabel,
        href: '/platform/decisions',
      },
      {
        stage: 'enforcement',
        label: 'Enforcement',
        sublabel: 'Approval Status',
        count: enforcementCount,
        countLabel: 'pending',
        amount: enforcementAmount,
        status: enforcementStatus,
        statusLabel: enforcementStatusLabel,
        href: '/platform/reviews',
      },
      {
        stage: 'execution',
        label: 'Execution',
        sublabel: 'Tasks Created',
        count: openActions,
        countLabel: 'tasks',
        amount: null,
        status: executionStatus,
        statusLabel: openActions > 0 ? 'In progress' : 'Clear',
        href: '/platform/decisions',
      },
    ],
  };
}
