// ASK SELECTOR - reads canonical truth, never produces it.
// No summation, counting, scoring, finding creation, or inference. If the value
// is not already canonical, this is needs-upstream-fact, not a selector. Reads
// THROUGH canonicalReadGuard. Portfolio selectors read portfolio-safe-aggregate
// ONLY - never project-deep. Must pass its matrix-traced probe at matrixSpecific
// + matrixSourced + matrixEvidenceAdequate.
import type { AskAnswerContract } from '@/lib/ask/globalCommand';
import type { PortfolioSelectorParams } from '@/lib/ask/selectors';

export function selectPortfolioProjectStatus(params: PortfolioSelectorParams): AskAnswerContract | null {
  const text = params.question.toLowerCase();
  if (!text.includes('blocked') && !text.includes('ready for approval') && !text.includes('stale validation')) {
    return null;
  }

  const base = params.base;
  const missingField = text.includes('ready for approval')
    ? 'Portfolio aggregate approval_ready_projects[] and approval_ready_project_count'
    : text.includes('stale validation')
      ? 'Portfolio aggregate stale_validation_projects[] and stale_validation_project_count'
      : 'Portfolio aggregate blocked_projects[] and blocked_project_count';

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
