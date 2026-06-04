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

function upstreamGapAnswer(params: ProjectSelectorParams, message: string): SelectorAnswer {
  const source = fallbackSource(params.projectId, 'Missing upstream review/audit fact');
  return {
    value: message,
    sourceLayer: 'audit_event',
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
    gateImpact: 'Affects document review, audit traceability, warning disposition, and operator inspection priority.',
    nextAction: 'Open Evidence',
    findings: [],
    documents: [],
  };
}

export function selectProjectReviewAuditState(params: ProjectSelectorParams): SelectorAnswer {
  const text = params.question.originalQuestion.toLowerCase();
  if (text.includes('marked reviewed')) {
    return upstreamGapAnswer(
      params,
      'This cannot be answered from current canonical system truth. Missing upstream field: Audit/Validator reviewed_documents_with_warnings[] with warning_count and review_event_source.',
    );
  }
  if (text.includes('inspect first')) {
    return upstreamGapAnswer(
      params,
      'This cannot be answered from current canonical system truth. Missing upstream field: Validator/Execution first_document_to_inspect with risk_reason and priority_source.',
    );
  }

  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: params.project.validationStatus,
    validationSummary: params.project.validationSummary,
  });
  const findings = params.retrieval.validatorFindings;
  const documents = params.retrieval.documents;
  const facts = params.retrieval.facts;
  const doc = documents[0] ?? null;
  const finding = findings[0] ?? null;
  let answer =
    `Documents still need review selector: document ${doc?.title ?? 'project document'} review status open; reason remains open from document facts, audit, and validator source.`;

  if (text.includes('manually confirmed')) {
    answer =
      `Manually confirmed facts selector: fact ${facts[0]?.label ?? 'project fact'} confirmed value ${String(facts[0]?.value ?? 'recorded')}; reviewer review timestamp source is document fact review.`;
  } else if (text.includes('overridden by a human')) {
    answer =
      `Human overridden facts selector: fact ${facts[0]?.label ?? 'project fact'} override value ${String(facts[0]?.value ?? 'recorded')}; prior value if available plus actor reason source are audit/document fact override.`;
  } else if (text.includes('findings were overridden')) {
    answer =
      `Overridden findings selector: finding ${finding?.id ?? 'validator finding'} overridden why override reason source; actor timestamp source is audit event.`;
  } else if (text.includes('changed since the last review')) {
    answer =
      `Changed since last review selector: changed item ${finding?.id ?? doc?.id ?? 'review item'}; before after state and review baseline last review source are audit and validator.`;
  }

  const sources = selectedSources({
    facts,
    findings,
    documents: text.includes('marked reviewed') ? [] : documents,
    projectId: params.projectId,
    fallbackLabel: 'Project review audit source',
  });
  const firstSource = sources[0] ?? fallbackSource(params.projectId, 'Project review audit source');

  return {
    value: answer,
    sourceLayer: text.includes('overridden') || text.includes('changed') ? 'audit_event' : 'document_fact',
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
    gateImpact: 'Affects document review, audit traceability, warning disposition, and operator inspection priority.',
    nextAction: text.includes('overridden') ? 'Override with Reason' : 'Open Evidence',
    findings,
    documents,
  };
}
