// ASK SELECTOR - reads canonical truth, never produces it.
// No summation, counting, scoring, finding creation, or inference. If the value
// is not already canonical, this is needs-upstream-fact, not a selector. Reads
// THROUGH canonicalReadGuard. Portfolio selectors read portfolio-safe-aggregate
// ONLY - never project-deep. Must pass its matrix-traced probe at matrixSpecific
// + matrixSourced + matrixEvidenceAdequate.
import type { AskAnswerContract } from '@/lib/ask/globalCommand';
import type { PortfolioSelectorParams } from '@/lib/ask/selectors';
import type { PortfolioProjectStatusAggregateProject } from '@/lib/ask/portfolioProjectStatusAggregate';

function projectLine(project: PortfolioProjectStatusAggregateProject, label: string): string {
  return `${project.project_name} - ${label}; readiness ${project.readiness_state}; aggregate source.`;
}

function projectSignal(params: {
  project: PortfolioProjectStatusAggregateProject;
  signalReason: string;
  stalenessLabel?: string;
}) {
  return {
    projectId: params.project.project_id,
    projectName: params.project.project_name,
    readinessState: params.project.readiness_state,
    validationState: params.project.readiness_state,
    atRiskAmount: 0,
    blockerCount: 0,
    warningCount: 0,
    openExecutionItemCount: 0,
    isStale: params.signalReason === 'stale validation snapshot',
    stalenessLabel: params.stalenessLabel ?? 'Current',
    signalReason: params.signalReason,
    handoffHref: `/platform/projects/${encodeURIComponent(params.project.project_id)}#ask-project`,
  };
}

export function selectPortfolioProjectStatus(params: PortfolioSelectorParams): AskAnswerContract | null {
  const text = params.question.toLowerCase();
  if (!text.includes('blocked') && !text.includes('ready for approval') && !text.includes('stale validation')) {
    return null;
  }

  const base = params.base;
  const aggregate = params.projectStatusAggregate;
  const missingField = text.includes('ready for approval')
    ? 'Portfolio aggregate approval_ready_projects[] and approval_ready_project_count'
    : text.includes('stale validation')
      ? 'Portfolio aggregate stale_validation_projects[] and stale_validation_project_count'
      : 'Portfolio aggregate blocked_projects[] and blocked_project_count';

  if (!aggregate) {
    return {
      ...base,
      answer: [
        'Portfolio Signal:',
        'No verified data found for this portfolio selector.',
        '',
        'Projects Affected:',
        `This cannot be answered from current canonical system truth. Missing upstream field: ${missingField}.`,
      ].join('\n'),
      evidence: [],
      sources: ['portfolio-safe aggregate selector gap'],
      checkedSources: Array.from(new Set([...(base.checkedSources ?? []), missingField])),
      nextActions: [{ label: 'No action required' }],
      availability: 'unavailable',
      dataFound: false,
      portfolioSignalState: 'No Verified Data',
      portfolioSections: undefined,
    };
  }

  const selected = text.includes('ready for approval')
    ? {
        projects: aggregate.approval_ready_projects,
        count: aggregate.approval_ready_project_count,
        label: 'ready for approval',
        title: 'Approval Ready Projects',
        evidenceLabel: 'ready status',
        state: 'Portfolio Ready' as const,
        reason: 'approval ready aggregate',
        checked: 'Portfolio aggregate approval_ready_projects[] and approval_ready_project_count',
        action: 'Open Ask Project',
      }
    : text.includes('stale validation')
      ? {
          projects: aggregate.stale_validation_projects,
          count: aggregate.stale_validation_project_count,
          label: 'stale validation snapshot',
          title: 'Stale Validation Projects',
          evidenceLabel: 'stale validation timestamp source',
          state: 'Portfolio Needs Review' as const,
          reason: 'stale validation snapshot',
          checked: 'Portfolio aggregate stale_validation_projects[] and stale_validation_project_count',
          action: 'Review stale snapshot',
        }
      : {
          projects: aggregate.blocked_projects,
          count: aggregate.blocked_project_count,
          label: 'blocked project',
          title: 'Blocked Projects',
          evidenceLabel: 'blocker count and at risk aggregate source',
          state: 'Portfolio Blocked' as const,
          reason: 'blocked validation state',
          checked: 'Portfolio aggregate blocked_projects[] and blocked_project_count',
          action: 'Open Validator',
        };

  const projectLines = selected.projects[0] == null
    ? `Aggregate reports zero ${selected.label}s from the prebuilt portfolio aggregate; project count ${selected.count}; ${selected.evidenceLabel}; aggregate source.`
    : selected.projects.map((project) => projectLine(project, selected.label)).join('\n');
  const affected = selected.projects.map((project) =>
    projectSignal({
      project,
      signalReason: selected.reason,
      stalenessLabel: selected.reason === 'stale validation snapshot' ? 'Stale validation snapshot source' : 'Current',
    }),
  );
  const top = affected[0] ?? null;

  return {
    ...base,
    answer: [
      'Portfolio Signal:',
      `${selected.title}: project count ${selected.count}; ${selected.evidenceLabel}; aggregate source ${selected.checked}.`,
      '',
      'Projects Affected:',
      projectLines,
      '',
      'Recommended Action:',
      top
        ? `${selected.action} for ${top.projectName} from ${selected.checked}.`
        : `No action required from ${selected.checked}.`,
    ].join('\n'),
    evidence: selected.projects.map((project) => ({
      label: project.project_name,
      href: `/platform/projects/${encodeURIComponent(project.project_id)}`,
      source: `${selected.checked}; ${selected.label}; readiness ${project.readiness_state}`,
    })),
    sources: ['portfolio-safe project status aggregate'],
    checkedSources: Array.from(new Set([...(base.checkedSources ?? []), selected.checked])),
    nextActions: top
      ? [{ label: selected.action, href: top.handoffHref }]
      : [{ label: 'No action required' }],
    availability: 'available',
    dataFound: true,
    portfolioSignalState: selected.state,
    portfolioSections: {
      portfolioSignal: `${selected.title}: project count ${selected.count}; ${selected.evidenceLabel}; aggregate source.`,
      projectsAffected: affected,
      financialExposure: {
        totalAtRiskAmount: 0,
        perProject: selected.projects.map((project) => ({
          projectId: project.project_id,
          projectName: project.project_name,
          atRiskAmount: 0,
        })),
      },
      patternDetected: {
        label: 'No cross project pattern provided by portfolio project status aggregate.',
        affectedProjects: [],
        exists: false,
      },
      recommendedAction: {
        label: top
          ? `${selected.action} for ${top.projectName} from ${selected.checked}.`
          : `No action required from ${selected.checked}.`,
        projectName: top?.projectName ?? null,
        workflowName: top ? selected.action : 'No action required',
        reason: selected.checked,
        href: top?.handoffHref,
      },
    },
  };
}
