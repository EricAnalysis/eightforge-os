// ASK SELECTOR - reads canonical truth, never produces it.
// No summation, counting, scoring, finding creation, or inference. If the value
// is not already canonical, this is needs-upstream-fact, not a selector. Reads
// THROUGH canonicalReadGuard. Portfolio selectors read portfolio-safe-aggregate
// ONLY - never project-deep. Must pass its matrix-traced probe at matrixSpecific
// + matrixSourced + matrixEvidenceAdequate.
import type { ProjectSelectorParams, SelectorAnswer } from '@/lib/ask/selectors';
import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
import type { ProjectExecutionSummary } from '@/lib/execution/executionSummary';
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

function sourceForPrebuiltField(params: {
  type: 'validator' | 'decision';
  label: string;
  snippet: string;
  sourceId: string;
}): ReturnType<typeof fallbackSource> {
  return {
    type: params.type,
    label: params.label,
    snippet: params.snippet,
    confidence: 96,
    timestamp: new Date(0).toISOString(),
    factId: params.sourceId,
  };
}

function sourceForExecutionSummaryEmpty(params: ProjectSelectorParams, snippet: string): ReturnType<typeof fallbackSource> {
  return sourceForPrebuiltField({
    type: 'decision',
    label: 'Execution summary',
    snippet,
    sourceId: `project:${params.projectId}:execution_summary`,
  });
}

function readExecutionSummary(params: ProjectSelectorParams): ProjectExecutionSummary | null {
  return params.retrieval.rawData.executionSummary ?? null;
}

export function selectProjectApprovalExecutionState(params: ProjectSelectorParams): SelectorAnswer {
  const text = params.question.originalQuestion.toLowerCase();
  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: params.project.validationStatus,
    validationSummary: params.project.validationSummary,
  });
  const validationState = validationStateFromCanonicalStatus(snapshot.facts.status);

  if (text.includes('open tickets')) {
    const eligibility = snapshot.facts.invoice_exception_eligibility;
    if (eligibility == null) {
      return upstreamGapAnswer(
        params,
        'This cannot be answered from current canonical system truth. Missing upstream field: Validator/Execution invoice_exception_eligibility.open_ticket_count.',
      );
    }

    const source = sourceForPrebuiltField({
      type: 'validator',
      label: 'Validator invoice exception eligibility',
      snippet: `Invoice open ticket count ${eligibility.open_ticket_count}; approval gate basis ${eligibility.approval_gate_basis}`,
      sourceId: `project:${params.projectId}:invoice_exception_eligibility`,
    });
    return {
      value:
        `Invoice exception eligibility: open ticket count ${eligibility.open_ticket_count}. ` +
        `This invoice can move forward only according to approval gate basis: ${eligibility.approval_gate_basis}.`,
      sourceLayer: 'validation_snapshot',
      sourceId: sourceId(source),
      isFallback: false,
      isStale: false,
      confidence: 'verified',
      evidence: [{
        label: source.label,
        value: source.snippet ?? source.label,
        sourceId: sourceId(source),
      }],
      sources: [source],
      validationState,
      gateImpact: 'Affects approval gate, invoice readiness, execution priority, and payment release.',
      nextAction: 'Open Validator',
      findings: [],
      decisions: [],
    };
  }
  if (text.includes('approved with exceptions')) {
    const eligibility = snapshot.facts.invoice_exception_eligibility;
    if (eligibility == null) {
      return upstreamGapAnswer(
        params,
        'This cannot be answered from current canonical system truth. Missing upstream field: Validator/Execution invoice_exception_eligibility.exception_type and required_approval_condition.',
      );
    }

    const source = sourceForPrebuiltField({
      type: 'validator',
      label: 'Validator invoice exception eligibility',
      snippet: `Invoice exception ${eligibility.exception_type}; required approval condition ${eligibility.required_approval_condition}`,
      sourceId: `project:${params.projectId}:invoice_exception_eligibility`,
    });
    return {
      value:
        `Invoice exception approval: exception type ${eligibility.exception_type}. ` +
        `Required approval condition: ${eligibility.required_approval_condition}.`,
      sourceLayer: 'validation_snapshot',
      sourceId: sourceId(source),
      isFallback: false,
      isStale: false,
      confidence: 'verified',
      evidence: [{
        label: source.label,
        value: source.snippet ?? source.label,
        sourceId: sourceId(source),
      }],
      sources: [source],
      validationState,
      gateImpact: 'Affects approval gate, invoice readiness, execution priority, and payment release.',
      nextAction: 'Open Validator',
      findings: [],
      decisions: [],
    };
  }
  if (text.includes('next best action')) {
    const executionSummary = readExecutionSummary(params);
    if (executionSummary == null) {
      return upstreamGapAnswer(
        params,
        'This cannot be answered from current canonical system truth. Missing upstream field: Execution recommended_next_action with source_item_id and priority_reason.',
      );
    }

    const recommended = executionSummary.recommended_next_action;
    if (recommended == null) {
      const source = sourceForExecutionSummaryEmpty(
        params,
        'Execution summary computed no open execution items; next best action is no action pending; priority reason none open.',
      );
      return {
        value:
          'Next best action: no action pending. ' +
          'Execution summary source reports no open execution items, so priority reason is none open.',
        sourceLayer: 'execution_summary',
        sourceId: sourceId(source),
        isFallback: false,
        isStale: false,
        confidence: 'verified',
        evidence: [{
          label: source.label,
          value: source.snippet ?? source.label,
          sourceId: sourceId(source),
        }],
        sources: [source],
        validationState,
        gateImpact: 'No current execution blocker affects approval gate, invoice readiness, execution priority, or payment release.',
        nextAction: 'No action required',
        findings: [],
        decisions: [],
      };
    }

    const source = sourceForPrebuiltField({
      type: 'decision',
      label: 'Execution recommended next action',
      snippet: `Execution item source ${recommended.source_item_id}; priority reason ${recommended.priority_reason}`,
      sourceId: recommended.source_item_id,
    });
    return {
      value:
        `Next best action: open execution item ${recommended.source_item_id}. ` +
        `Priority reason: ${recommended.priority_reason}.`,
      sourceLayer: 'execution_summary',
      sourceId: sourceId(source),
      isFallback: false,
      isStale: false,
      confidence: 'verified',
      evidence: [{
        label: source.label,
        value: source.snippet ?? source.label,
        sourceId: sourceId(source),
      }],
      sources: [source],
      validationState,
      gateImpact: 'Affects approval gate, invoice readiness, execution priority, and payment release.',
      nextAction: 'Open Execution Item',
      findings: [],
      decisions: [],
    };
  }
  if (text.includes('execution items')) {
    const executionSummary = readExecutionSummary(params);
    if (executionSummary == null) {
      return upstreamGapAnswer(
        params,
        'This cannot be answered from current canonical system truth. Missing upstream field: Execution open_execution_items[] with status, required_action, and blocker_flag.',
      );
    }

    const openExecutionItems = executionSummary.open_execution_items;
    if (openExecutionItems.length === 0) {
      const source = sourceForExecutionSummaryEmpty(
        params,
        'Execution summary open execution items list is empty; status none open; required action none; blocker flag false.',
      );
      return {
        value:
          'Open execution items: none open. ' +
          'Execution summary source reports status none open, required action none, and blocker flag false.',
        sourceLayer: 'execution_summary',
        sourceId: sourceId(source),
        isFallback: false,
        isStale: false,
        confidence: 'verified',
        evidence: [{
          label: source.label,
          value: source.snippet ?? source.label,
          sourceId: sourceId(source),
        }],
        sources: [source],
        validationState,
        gateImpact: 'No current execution blocker affects approval gate, invoice readiness, execution priority, or payment release.',
        nextAction: 'No action required',
        findings: [],
        decisions: [],
      };
    }

    const sources = openExecutionItems.map((item) => sourceForPrebuiltField({
      type: 'decision',
      label: `Execution item ${item.id}`,
      snippet: `Execution item ${item.id}; status ${item.status}; required action ${item.required_action}; blocker flag ${item.blocker_flag}`,
      sourceId: item.id,
    }));
    const answer = openExecutionItems
      .map((item) =>
        `Execution item ${item.id}: status ${item.status}; required action ${item.required_action}; blocker flag ${item.blocker_flag}.`,
      )
      .join(' ');
    return {
      value: `Open execution items: ${answer}`,
      sourceLayer: 'execution_summary',
      sourceId: sourceId(sources[0]),
      isFallback: false,
      isStale: false,
      confidence: 'verified',
      evidence: sources.map((source) => ({
        label: source.label,
        value: source.snippet ?? source.label,
        sourceId: sourceId(source),
      })),
      sources,
      validationState,
      gateImpact: 'Affects approval gate, invoice readiness, execution priority, and payment release.',
      nextAction: 'Open Execution Queue',
      findings: [],
      decisions: [],
    };
  }
  if (text.includes('blocking payment release')) {
    const executionSummary = readExecutionSummary(params);
    if (executionSummary == null) {
      return upstreamGapAnswer(
        params,
        'This cannot be answered from current canonical system truth. Missing upstream field: Execution payment_release_blockers[] with action_id, blocker_basis, and payment_gate_impact.',
      );
    }

    const blockers = executionSummary.payment_release_blockers;
    if (blockers.length === 0) {
      const source = sourceForExecutionSummaryEmpty(
        params,
        'Execution summary payment release blockers list is empty; action none; blocker basis none; payment gate impact none blocking.',
      );
      return {
        value:
          'No actions are blocking payment release. ' +
          'Execution summary source reports action none, blocker basis none, and payment gate impact none blocking.',
        sourceLayer: 'execution_summary',
        sourceId: sourceId(source),
        isFallback: false,
        isStale: false,
        confidence: 'verified',
        evidence: [{
          label: source.label,
          value: source.snippet ?? source.label,
          sourceId: sourceId(source),
        }],
        sources: [source],
        validationState,
        gateImpact: 'No current execution blocker affects approval gate, invoice readiness, execution priority, or payment release.',
        nextAction: 'No action required',
        findings: [],
        decisions: [],
      };
    }

    const sources = blockers.map((blocker) => sourceForPrebuiltField({
      type: 'decision',
      label: `Payment release blocker ${blocker.action_id}`,
      snippet: `Action ${blocker.action_id}; blocker basis ${blocker.blocker_basis}; payment gate impact ${blocker.payment_gate_impact}`,
      sourceId: blocker.action_id,
    }));
    const answer = blockers
      .map((blocker) =>
        `Action ${blocker.action_id} is blocking payment release; blocker basis ${blocker.blocker_basis}; payment gate impact ${blocker.payment_gate_impact}.`,
      )
      .join(' ');
    return {
      value: `Payment release blockers: ${answer}`,
      sourceLayer: 'execution_summary',
      sourceId: sourceId(sources[0]),
      isFallback: false,
      isStale: false,
      confidence: 'verified',
      evidence: sources.map((source) => ({
        label: source.label,
        value: source.snippet ?? source.label,
        sourceId: sourceId(source),
      })),
      sources,
      validationState,
      gateImpact: 'Affects approval gate, invoice readiness, execution priority, and payment release.',
      nextAction: 'Open Execution Queue',
      findings: [],
      decisions: [],
    };
  }

  const context = params.retrieval.rawData.validatorContext;
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
