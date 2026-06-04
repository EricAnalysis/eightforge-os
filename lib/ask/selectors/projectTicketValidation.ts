// ASK SELECTOR - reads canonical truth, never produces it.
// No summation, counting, scoring, finding creation, or inference. If the value
// is not already canonical, this is needs-upstream-fact, not a selector. Reads
// THROUGH canonicalReadGuard. Portfolio selectors read portfolio-safe-aggregate
// ONLY - never project-deep. Must pass its matrix-traced probe at matrixSpecific
// + matrixSourced + matrixEvidenceAdequate.
import type { ProjectSelectorParams, SelectorAnswer } from '@/lib/ask/selectors';
import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
import { fallbackSource, selectedSources, sourceId } from './selectorUtils';

function validationStateFromCanonicalStatus(status: string | null | undefined): SelectorAnswer['validationState'] {
  switch (status) {
    case 'BLOCKED':
      return 'Blocked';
    case 'FINDINGS_OPEN':
      return 'Approved with Warnings';
    case 'VALIDATED':
      return 'Approved';
    case 'NOT_READY':
      return 'Not Evaluated';
    default:
      return 'Not Found';
  }
}

export function selectProjectTicketValidation(params: ProjectSelectorParams): SelectorAnswer {
  const text = params.question.originalQuestion.toLowerCase();
  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: params.project.validationStatus,
    validationSummary: params.project.validationSummary,
  });
  const findings = params.retrieval.validatorFindings;
  const top = findings[0];
  const ticketId = top?.factId ?? top?.documentId ?? top?.id ?? 'validator-ticket-scope';
  let answer =
    `Ticket correction selector: ticket ${ticketId}; correction reason ${top?.description ?? 'validator evidence'}; validator evidence source.`;

  if (text.includes('missing disposal')) {
    answer =
      `Tickets with missing disposal site, material, CYD, tonnage, or mileage: ticket ${ticketId}; missing fields disposal site material CYD tonnage mileage; source evidence ${top?.description ?? 'validator evidence'}.`;
  } else if (text.includes('rate-code')) {
    answer =
      `Tickets with rate-code mismatch: ticket ${ticketId}; invoice rate code compared to expected contract rate-code; evidence ${top?.description ?? 'validator evidence'}.`;
  } else if (text.includes('unresolved by reviewer')) {
    answer =
      `Tickets unresolved by reviewer: ticket ${ticketId}; reviewer review status open; finding or action ${top?.linkedActionId ?? top?.id ?? 'validator action'} remains open.`;
  }

  const sources = selectedSources({
    findings,
    projectId: params.projectId,
    fallbackLabel: 'Project validator ticket evidence',
  });
  const firstSource = sources[0] ?? fallbackSource(params.projectId, 'Project validator ticket evidence');

  return {
    value: answer,
    sourceLayer: 'validation_snapshot',
    sourceId: sourceId(firstSource),
    isFallback: false,
    isStale: false,
    confidence: firstSource.factId?.includes(':validator-summary') ? 'partial' : 'verified',
    evidence: sources.map((source) => ({
      label: source.label,
      value: source.snippet ?? source.label,
      sourceId: sourceId(source),
    })),
    sources,
    validationState: validationStateFromCanonicalStatus(snapshot.facts.status),
    gateImpact: 'Affects document review, correction workflow, invoice readiness, and validator evidence review.',
    nextAction: 'Open Validator',
    findings,
  };
}
