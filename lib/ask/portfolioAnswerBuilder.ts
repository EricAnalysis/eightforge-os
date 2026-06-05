// ASK BOUNDARY FILE — reads canonical truth, never produces it.
// No summation, scoring, risk creation, severity assignment, or pattern
// inference in this layer. Any change must pass scripts/ask/phase3Diagnostic.ts
// at 22/22, 0 gaps. See Ask workstream closeout.
import type { AskAnswerContract, AskPortfolioSections, PortfolioSignalState } from '@/lib/ask/globalCommand';
import {
  buildPortfolioHandoffContext,
  encodePortfolioHandoffContext,
} from '@/lib/ask/portfolioHandoffContext';
import type { PortfolioOverview } from '@/lib/server/portfolioCommandCenter';
import type { OperationalQueueModel } from '@/lib/server/operationalQueue';
import type { PortfolioStalenessState } from '@/lib/ask/portfolioStalenessCheck';
import { selectPortfolioProjectStatus } from '@/lib/ask/selectors';
import { buildPortfolioProjectStatusAggregate } from '@/lib/ask/portfolioProjectStatusAggregate';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}

type PortfolioProjectSignal = AskPortfolioSections['projectsAffected'][number] & {
  activeApprovalRequest: boolean;
  recentActivityAt: string;
  systemOrder: number;
};

function statusTier(signal: PortfolioProjectSignal): number {
  if (signal.blockerCount > 0 || signal.validationState.toLowerCase().includes('blocked')) return 0;
  if (signal.warningCount > 0 || signal.validationState.toLowerCase().includes('review')) return 1;
  return 2;
}

function rankPortfolioSignals(signals: PortfolioProjectSignal[]): PortfolioProjectSignal[] {
  return [...signals].sort((left, right) => {
    const statusDelta = statusTier(left) - statusTier(right);
    if (statusDelta !== 0) return statusDelta;

    const exposureDelta = right.atRiskAmount - left.atRiskAmount;
    if (exposureDelta !== 0) return exposureDelta;

    if (left.activeApprovalRequest !== right.activeApprovalRequest) {
      return left.activeApprovalRequest ? -1 : 1;
    }

    const executionDelta = right.openExecutionItemCount - left.openExecutionItemCount;
    if (executionDelta !== 0) return executionDelta;

    const activityDelta = new Date(right.recentActivityAt).getTime() - new Date(left.recentActivityAt).getTime();
    if (activityDelta !== 0) return activityDelta;

    return left.systemOrder - right.systemOrder;
  });
}

function signalReason(signal: Pick<PortfolioProjectSignal, 'blockerCount' | 'warningCount' | 'atRiskAmount' | 'openExecutionItemCount' | 'isStale'>): string {
  if (signal.isStale) return 'stale validation snapshot';
  if (signal.blockerCount > 0) return 'blocked validation state';
  if (signal.warningCount > 0) return 'open warning state';
  if (signal.atRiskAmount > 0) return 'financial exposure';
  if (signal.openExecutionItemCount > 0) return 'open execution need';
  return 'portfolio signal';
}

function portfolioSignalStateFromAggregate(portfolio: PortfolioOverview): PortfolioSignalState {
  if (portfolio.totalProjects === 0) return 'No Verified Data';
  if (portfolio.projectsByStatus.blocked > 0 || portfolio.totalBlocked > 0) return 'Portfolio Blocked';
  if (portfolio.projectsByStatus.requires_review > 0 || portfolio.totalRequiresVerification > 0) return 'Portfolio Needs Review';
  if (portfolio.projectsByStatus.at_risk > 0 || portfolio.totalAtRisk > 0) return 'Portfolio Exposure';
  return 'Portfolio Ready';
}

export function buildPortfolioAskAnswer(params: {
  question: string;
  portfolio: PortfolioOverview;
  operations: OperationalQueueModel;
  stalenessByProjectId: Map<string, PortfolioStalenessState>;
  promptVersion: string;
}): AskAnswerContract {
  const metricsByProjectId = new Map(params.portfolio.topRiskProjects.map((project) => [project.projectId, project] as const));
  const signals = params.operations.project_rollups.map((item, index): PortfolioProjectSignal => {
    const metrics = metricsByProjectId.get(item.project.id);
    const staleness = params.stalenessByProjectId.get(item.project.id);
    const base = {
      projectId: item.project.id,
      projectName: item.project.name,
      readinessState: item.rollup.status.label,
      validationState: item.project.validation_status ?? item.rollup.status.label,
      atRiskAmount: metrics?.atRiskAmount ?? 0,
      blockerCount: item.rollup.blocked_count,
      warningCount: item.rollup.unresolved_finding_count,
      openExecutionItemCount: item.rollup.open_document_action_count,
      isStale: staleness?.isStale ?? false,
      stalenessLabel: staleness?.label ?? 'Current',
      activeApprovalRequest: (metrics?.requiresVerificationAmount ?? 0) > 0,
      recentActivityAt: metrics?.lastActivityAt ?? item.project.created_at,
      systemOrder: index,
    };
    const reason = signalReason(base);
    const handoffContext = buildPortfolioHandoffContext({
      originalPortfolioQuery: params.question,
      projectId: base.projectId,
      projectName: base.projectName,
      signalReason: reason,
      validationState: base.validationState,
      atRiskAmount: base.atRiskAmount,
      openBlockerCount: base.blockerCount,
      openWarningCount: base.warningCount,
      openExecutionItemCount: base.openExecutionItemCount,
      snapshotIsStale: base.isStale,
    });

    return {
      ...base,
      signalReason: reason,
      handoffHref: `/platform/projects/${encodeURIComponent(base.projectId)}?portfolioHandoff=${encodePortfolioHandoffContext(handoffContext)}#ask-project`,
    };
  });

  const affected = rankPortfolioSignals(
    signals.filter((signal) =>
      signal.blockerCount > 0 ||
      signal.warningCount > 0 ||
      signal.atRiskAmount > 0 ||
      signal.openExecutionItemCount > 0 ||
      signal.isStale,
    ),
  ).slice(0, 5);
  const totalExposure = params.portfolio.totalAtRisk;
  const top = affected[0] ?? null;
  const repeatedIssueType = params.portfolio.issueTypeRanking.find((issue) => issue.count > 1) ?? null;
  const patternExists = repeatedIssueType != null;
  const pattern = repeatedIssueType
    ? `Repeated ${repeatedIssueType.type.replace(/_/g, ' ')} aggregate across ${repeatedIssueType.count} canonical finding signals.`
    : 'No cross project pattern provided by portfolio aggregates.';
  const workflowName = top
    ? top.isStale
      ? 'Review stale snapshot'
      : top.blockerCount > 0
        ? 'Open Validator'
        : top.openExecutionItemCount > 0
          ? 'Open Execution Queue'
          : 'Open Ask Project'
    : 'No action required';
  const portfolioSignalState = portfolioSignalStateFromAggregate(params.portfolio);
  const recommendedAction = top
    ? `${workflowName} for ${top.projectName} because it ranks first by validation state, exposure, and execution need.`
    : 'No action required.';
  const portfolioSignal = affected.length > 0
    ? `${affected.length} project${affected.length === 1 ? '' : 's'} require portfolio attention from current aggregate truth. Total exposure is ${formatCurrency(totalExposure)}.`
    : `No portfolio attention signal was found across ${params.portfolio.totalProjects} project${params.portfolio.totalProjects === 1 ? '' : 's'}.`;
  const projectsAffected = affected.length > 0
    ? affected.map((signal, index) =>
        `${index + 1}. ${signal.projectName} - readiness ${signal.readinessState}; validation ${signal.validationState}; at risk ${formatCurrency(signal.atRiskAmount)}; blockers ${signal.blockerCount}; warnings ${signal.warningCount}; open execution items ${signal.openExecutionItemCount}; staleness ${signal.stalenessLabel}.`,
      ).join('\n')
    : 'No affected projects found in portfolio safe aggregates.';
  const exposureBreakdown = affected.length > 1
    ? affected.map((signal) => `${signal.projectName}: ${formatCurrency(signal.atRiskAmount)}`).join('\n')
    : top
      ? `${top.projectName}: ${formatCurrency(top.atRiskAmount)}`
      : 'No financial exposure found.';
  const sections: AskPortfolioSections = {
    portfolioSignal,
    projectsAffected: affected.map((signal) => ({
      projectId: signal.projectId,
      projectName: signal.projectName,
      readinessState: signal.readinessState,
      validationState: signal.validationState,
      atRiskAmount: signal.atRiskAmount,
      blockerCount: signal.blockerCount,
      warningCount: signal.warningCount,
      openExecutionItemCount: signal.openExecutionItemCount,
      isStale: signal.isStale,
      stalenessLabel: signal.stalenessLabel,
      signalReason: signal.signalReason,
      handoffHref: signal.handoffHref,
    })),
    financialExposure: {
      totalAtRiskAmount: totalExposure,
      perProject: affected.map((signal) => ({
        projectId: signal.projectId,
        projectName: signal.projectName,
        atRiskAmount: signal.atRiskAmount,
      })),
    },
    patternDetected: {
      label: pattern,
      affectedProjects: [],
      exists: patternExists,
    },
    recommendedAction: {
      label: recommendedAction,
      projectName: top?.projectName ?? null,
      workflowName,
      reason: top ? 'Ranks first by deterministic portfolio precedence.' : 'No affected project was found.',
      href: top?.handoffHref,
    },
  };

  const base: AskAnswerContract = {
    scope: 'portfolio',
    question: params.question,
    answer: [
      'Portfolio Signal:',
      portfolioSignal,
      '',
      'Projects Affected:',
      projectsAffected,
      '',
      'Financial Exposure:',
      `Total at risk amount: ${formatCurrency(totalExposure)}.`,
      exposureBreakdown,
      '',
      'Pattern Detected:',
      pattern,
      '',
      'Recommended Action:',
      recommendedAction,
    ].join('\n'),
    evidence: affected.map((signal) => ({
      label: signal.projectName,
      href: signal.handoffHref,
      source: [
        `validation ${signal.validationState}`,
        `readiness ${signal.readinessState}`,
        `at risk ${formatCurrency(signal.atRiskAmount)}`,
        `blockers ${signal.blockerCount}`,
        `warnings ${signal.warningCount}`,
        `execution ${signal.openExecutionItemCount}`,
        `staleness ${signal.stalenessLabel}`,
      ].join(' / '),
    })),
    validationState: params.portfolio.totalProjects > 0 ? 'Confirmed' : 'Not Found',
    portfolioSignalState,
    gateImpact: 'No approval, execution, or override state was changed.',
    pattern,
    recommendedAction,
    sources: ['portfolio command center aggregates', 'operational queue project rollups'],
    checkedSources: [
      'project approval snapshots',
      'project validation summaries',
      'project readiness states',
      'at risk amount summaries',
      'open execution item counts',
      'open blocker and warning counts',
      'portfolio staleness check',
    ],
    nextActions: top
      ? [
          { label: workflowName, href: top.handoffHref },
          { label: 'Open Ask Project', href: top.handoffHref },
        ]
      : [{ label: 'No action required' }],
    availability: params.portfolio.totalProjects > 0 || params.operations.project_rollups.length > 0 ? 'available' : 'unavailable',
    dataFound: params.portfolio.totalProjects > 0 || params.operations.project_rollups.length > 0,
    generatedBy: 'deterministic_aggregate',
    promptVersion: params.promptVersion,
    portfolioSections: sections,
  };

  const projectStatusAggregate = buildPortfolioProjectStatusAggregate(
    params.operations.project_rollups.map((item) => ({
      project_id: item.project.id,
      project_name: item.project.name,
      validation_status: item.project.validation_status,
      validation_summary: item.project.validation_summary_json,
      validation_snapshot_stale: params.stalenessByProjectId.get(item.project.id)?.isStale ?? false,
    })),
  );

  return selectPortfolioProjectStatus({
    question: params.question,
    portfolio: params.portfolio,
    operations: params.operations,
    stalenessByProjectId: params.stalenessByProjectId,
    projectStatusAggregate,
    base,
  }) ?? base;
}
