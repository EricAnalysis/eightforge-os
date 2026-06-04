// ASK SELECTOR - reads canonical truth, never produces it.
// No summation, counting, scoring, finding creation, or inference. If the value
// is not already canonical, this is needs-upstream-fact, not a selector. Reads
// THROUGH canonicalReadGuard. Portfolio selectors read portfolio-safe-aggregate
// ONLY - never project-deep. Must pass its matrix-traced probe at matrixSpecific
// + matrixSourced + matrixEvidenceAdequate.
import type { ProjectSelectorParams, SelectorAnswer } from '@/lib/ask/selectors';
import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
import {
  fallbackSource,
  humanize,
  selectedSources,
  sourceId,
} from './selectorUtils';

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

function nextActionFromSource(sourceType: string): SelectorAnswer['nextAction'] {
  if (sourceType === 'decision') return 'Open Execution Item';
  if (sourceType === 'fact' || sourceType === 'document') return 'Open Evidence';
  return 'Open Validator';
}

function upstreamGapAnswer(params: ProjectSelectorParams, message: string): SelectorAnswer {
  const source = fallbackSource(params.projectId, 'Missing upstream approval/execution fact');
  return {
    value: message,
    sourceLayer: 'validation_snapshot',
    sourceId: sourceId(source),
    isFallback: false,
    isStale: false,
    confidence: 'not_found',
    evidence: [{
      label: source.label,
      value: message,
      sourceId: sourceId(source),
    }],
    sources: [source],
    validationState: 'Not Found',
    gateImpact: 'Affects approval gate, invoice readiness, execution priority, and payment release.',
    nextAction: 'Open Validator',
    findings: [],
    decisions: [],
  };
}

export function selectProjectApprovalExecutionState(params: ProjectSelectorParams): SelectorAnswer {
  const text = params.question.originalQuestion.toLowerCase();
  if (text.includes('open tickets')) {
    return upstreamGapAnswer(
      params,
      'This cannot be answered from current canonical system truth. Missing upstream field: Validator/Execution invoice_exception_eligibility.open_ticket_count.',
    );
  }
  if (text.includes('approved with exceptions')) {
    return upstreamGapAnswer(
      params,
      'This cannot be answered from current canonical system truth. Missing upstream field: Validator/Execution invoice_exception_eligibility.exception_type and required_approval_condition.',
    );
  }
  if (text.includes('next best action')) {
    return upstreamGapAnswer(
      params,
      'This cannot be answered from current canonical system truth. Missing upstream field: Execution recommended_next_action with source_item_id and priority_reason.',
    );
  }
  if (text.includes('execution items')) {
    return upstreamGapAnswer(
      params,
      'This cannot be answered from current canonical system truth. Missing upstream field: Execution open_execution_items[] with status, required_action, and blocker_flag.',
    );
  }
  if (text.includes('blocking payment release')) {
    return upstreamGapAnswer(
      params,
      'This cannot be answered from current canonical system truth. Missing upstream field: Execution payment_release_blockers[] with action_id, blocker_basis, and payment_gate_impact.',
    );
  }

  const context = params.retrieval.rawData.validatorContext;
  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: params.project.validationStatus,
    validationSummary: params.project.validationSummary,
  });
  const findings = params.retrieval.validatorFindings;
  const decisions = params.retrieval.decisions;
  const facts = params.retrieval.facts;
  const blockerCount = snapshot.facts.blocker_count;
  const warningCount = snapshot.facts.warning_count;
  const topFinding = findings[0] ?? null;
  const topDecision = decisions[0] ?? null;
  const invoiceFact = facts.find((fact) => (fact.fieldKey ?? '').includes('invoice')) ?? facts[0] ?? null;
  const status = snapshot.facts.readiness ?? snapshot.facts.validator_status ?? snapshot.facts.status ?? context?.projectStatus ?? 'validator status';
  const blockerBasis = topFinding
    ? `${topFinding.description}; rule ${topFinding.category}; gate impact ${topFinding.blocksProject ? 'blocks approval' : 'requires approval review'}`
    : `blocker count ${blockerCount}; warning count ${warningCount}; validator source`;
  const action = topFinding?.linkedActionId
    ? `Open execution item ${topFinding.linkedActionId}`
    : topDecision
      ? `Review execution item ${topDecision.title}`
      : 'Open Validator';

  let answer =
    `Invoice approval readiness is ${humanize(String(status))}; approval status source is validator. ` +
    `Blocking finding count is ${blockerCount} with ${warningCount} warnings. ` +
    `Approval blocker basis: ${blockerBasis}. ` +
    `Next best action: ${action} because validator and execution priority identify the current approval gate.`;

  if (text.includes('action before approval')) {
    answer =
      `Finding action before approval is ${action}. ` +
      `Finding ${topFinding?.id ?? 'validator summary'} required action ${topFinding?.linkedActionId ?? 'Open Validator'}; approval gate effect ${blockerBasis}.`;
  }

  const sources = selectedSources({
    facts: invoiceFact ? [invoiceFact] : facts,
    findings,
    decisions,
    projectId: params.projectId,
    fallbackLabel: 'Project validator approval status source',
  });
  const firstSource = sources[0] ?? fallbackSource(params.projectId, 'Project validator approval status source');
  const validationState = validationStateFromCanonicalStatus(snapshot.facts.status);

  return {
    value: answer,
    sourceLayer: sources.some((source) => source.type === 'decision') ? 'execution_summary' : 'validation_snapshot',
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
    validationState,
    gateImpact: 'Affects approval gate, invoice readiness, execution priority, and payment release.',
    nextAction: nextActionFromSource(firstSource.type),
    findings,
    decisions,
  };
}
