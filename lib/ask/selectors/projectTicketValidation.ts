// ASK SELECTOR - reads canonical truth, never produces it.
// No summation, counting, scoring, finding creation, or inference. If the value
// is not already canonical, this is needs-upstream-fact, not a selector. Reads
// THROUGH canonicalReadGuard. Portfolio selectors read portfolio-safe-aggregate
// ONLY - never project-deep. Must pass its matrix-traced probe at matrixSpecific
// + matrixSourced + matrixEvidenceAdequate.
import type { ProjectSelectorParams, SelectorAnswer } from '@/lib/ask/selectors';
import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
import { sourceFromFinding, sourceId } from './selectorUtils';

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
  const missingFields = text.includes('missing disposal');
  const rateCode = /rate[- ]code/.test(text);
  const reviewer = text.includes('unresolved by reviewer');
  const findings = params.retrieval.validatorFindings.filter((finding) => {
    const statement = finding.description;
    if (!/\bticket\b/i.test(statement)) return false;
    if (missingFields) return /missing|absent|not recorded/i.test(statement) && /disposal site|material|\bCYD\b|tonnage|mileage/i.test(statement);
    if (rateCode) return /rate[- ]code/i.test(statement) && /mismatch|does not match|different/i.test(statement);
    if (reviewer) return /reviewer|review status/i.test(statement) && /unresolved|pending|open/i.test(statement);
    return /correction|incorrect|missing|mismatch|invalid/i.test(statement);
  });
  if (findings.length === 0) {
    const field = missingFields ? 'ticket missing-field findings' : rateCode ? 'ticket rate-code mismatch findings' : reviewer ? 'ticket reviewer-status findings' : 'ticket correction findings';
    return {
      value: `This cannot be answered from current canonical system truth. Missing upstream field: Validator ${field} with ticket identity and source evidence.`,
      sourceLayer: 'validation_snapshot', sourceId: `project:${params.projectId}:missing-ticket-findings`,
      isFallback: false, isStale: false, confidence: 'not_found', evidence: [], sources: [],
      validationState: 'Not Found', gateImpact: 'Ticket conclusions remain unproven without matching stored evidence.',
      nextAction: 'Run Validator', findings: [],
    };
  }
  const sources = findings.map(sourceFromFinding);
  const firstSource = sources[0];

  return {
    value: `Stored validator ticket findings: ${findings.map((finding) => finding.description).join(' ')}`,
    sourceLayer: 'validation_snapshot',
    sourceId: sourceId(firstSource),
    isFallback: false,
    isStale: false,
    confidence: 'verified',
    evidence: sources.map((source, index) => ({
      label: source.label,
      value: findings[index].description,
      sourceId: sourceId(source),
    })),
    sources,
    validationState: validationStateFromCanonicalStatus(snapshot.facts.status),
    gateImpact: 'Affects document review, correction workflow, invoice readiness, and validator evidence review.',
    nextAction: 'Open Validator',
    findings,
  };
}
