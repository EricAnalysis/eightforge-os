// ASK SELECTOR - reads canonical truth, never produces it.
// No summation, counting, scoring, finding creation, or inference. If the value
// is not already canonical, this is needs-upstream-fact, not a selector. Reads
// THROUGH canonicalReadGuard. Portfolio selectors read portfolio-safe-aggregate
// ONLY - never project-deep. Must pass its matrix-traced probe at matrixSpecific
// + matrixSourced + matrixEvidenceAdequate.
import type { ProjectSelectorParams, SelectorAnswer } from '@/lib/ask/selectors';
import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
import { fallbackSource, sourceId, sourceFromFact } from './selectorUtils';

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

function emptySnapshotAnswer(params: ProjectSelectorParams, field: string, value: string): SelectorAnswer {
  const source = {
    type: 'validator' as const,
    label: `Canonical review snapshot ${field}`,
    snippet: value,
    confidence: 96,
    timestamp: new Date(0).toISOString(),
    factId: `project:${params.projectId}:validator-summary:${field}`,
  };
  return {
    value,
    sourceLayer: 'validation_snapshot', sourceId: source.factId,
    isFallback: false, isStale: false, confidence: 'verified',
    evidence: [{ label: source.label, value, sourceId: source.factId }],
    sources: [source], validationState: 'Confirmed',
    gateImpact: 'No document review action is identified by this canonical snapshot.',
    nextAction: 'No action required', findings: [], documents: [],
  };
}

export function selectProjectReviewAuditState(params: ProjectSelectorParams): SelectorAnswer {
  const text = params.question.originalQuestion.toLowerCase();
  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: params.project.validationStatus,
    validationSummary: params.project.validationSummary,
  });
  const validationState = validationStateFromCanonicalStatus(snapshot.facts.status);
  const rawSummary = params.project.validationSummary;
  const summary = rawSummary != null && typeof rawSummary === 'object' && !Array.isArray(rawSummary)
    ? rawSummary as Record<string, unknown>
    : null;

  if (text.includes('marked reviewed')) {
    const reviewedDocuments = snapshot.facts.reviewed_documents_with_warnings;
    if (reviewedDocuments[0] == null) {
      if (Array.isArray(summary?.reviewed_documents_with_warnings) && summary.reviewed_documents_with_warnings.length === 0) {
        return emptySnapshotAnswer(params, 'reviewed_documents_with_warnings',
          'Reviewed documents with warnings: the canonical snapshot records no document with a review event and warning count. Source: validator review snapshot.');
      }
      return upstreamGapAnswer(
        params,
        'This cannot be answered from current canonical system truth. Missing upstream field: Audit/Validator reviewed_documents_with_warnings[] with warning_count and review_event_source.',
      );
    }

    const sources = reviewedDocuments.map((document) => ({
      type: 'validator' as const,
      label: `Reviewed document warning ${document.document_id}`,
      snippet: `Document ${document.document_id}; warning count ${document.warning_count}; review event source ${document.review_event_source}`,
      confidence: 96,
      timestamp: new Date(0).toISOString(),
      documentId: document.document_id,
      factId: document.review_event_source,
    }));
    const answer = reviewedDocuments
      .map((document) =>
        `Document ${document.document_id} is marked reviewed but still has warning count ${document.warning_count}; review event source ${document.review_event_source}.`,
      )
      .join(' ');
    return {
      value: `Reviewed documents with warnings: ${answer}`,
      sourceLayer: 'validation_snapshot',
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
      gateImpact: 'Affects document review, audit traceability, warning disposition, and operator inspection priority.',
      nextAction: 'Open Evidence',
      findings: [],
      documents: [],
    };
  }
  if (text.includes('inspect first')) {
    const firstDocument = snapshot.facts.first_document_to_inspect;
    if (firstDocument == null) {
      if (summary != null && Object.hasOwn(summary, 'first_document_to_inspect') && summary.first_document_to_inspect === null) {
        return emptySnapshotAnswer(params, 'first_document_to_inspect',
          'First document to inspect: no document is identified by the canonical snapshot. Risk reason: no blocker/warning/action inspection priority is recorded. Source: validator review snapshot.');
      }
      return upstreamGapAnswer(
        params,
        'This cannot be answered from current canonical system truth. Missing upstream field: Validator/Execution first_document_to_inspect with risk_reason and priority_source.',
      );
    }

    const source = {
      type: 'validator' as const,
      label: `First document to inspect ${firstDocument.document_id}`,
      snippet:
        `Document ${firstDocument.document_id}; risk reason ${firstDocument.risk_reason}; ` +
        `linked action ${firstDocument.linked_action_id ?? 'none'}; priority source ${firstDocument.priority_source}`,
      confidence: 96,
      timestamp: new Date(0).toISOString(),
      documentId: firstDocument.document_id,
      factId: firstDocument.priority_source,
    };
    return {
      value:
        `First document to inspect: document ${firstDocument.document_id}. ` +
        `Risk reason: ${firstDocument.risk_reason}. ` +
        `Linked blocker/warning/action: ${firstDocument.linked_action_id ?? 'none'}. ` +
        `Priority source: ${firstDocument.priority_source}.`,
      sourceLayer: 'validation_snapshot',
      sourceId: sourceId(source),
      isFallback: false,
      isStale: false,
      confidence: 'verified',
      evidence: [{
        label: source.label,
        value: source.snippet,
        sourceId: sourceId(source),
      }],
      sources: [source],
      validationState,
      gateImpact: 'Affects document review, audit traceability, warning disposition, and operator inspection priority.',
      nextAction: 'Open Evidence',
      findings: [],
      documents: [],
    };
  }

  if (text.includes('manually confirmed') || text.includes('overridden by a human')) {
    const overrides = text.includes('overridden by a human');
    const facts = params.retrieval.facts.filter((fact) => overrides
      ? fact.sourceKind === 'human_override' && Boolean(fact.overrideId)
      : fact.sourceKind === 'human_review' && fact.reviewStatus === 'confirmed');
    if (facts.length > 0) {
      const sources = facts.map(sourceFromFact);
      const value = facts.map((fact) => overrides
        ? `Human overridden fact ${fact.label}: override value ${String(fact.value)}; override source ${fact.overrideId}.`
        : `Manually confirmed fact ${fact.label}: confirmed value ${String(fact.value)}; review status confirmed; source ${fact.factId ?? fact.id}.`).join(' ')
        + ' Actor, reason and historical review timestamp are not available in this read.';
      return {
        value, sourceLayer: 'document_fact', sourceId: sourceId(sources[0]),
        isFallback: false, isStale: false, confidence: 'partial',
        evidence: sources.map((source) => ({ label: source.label, value: source.snippet ?? source.label, sourceId: sourceId(source) })),
        sources, validationState: 'Confirmed',
        gateImpact: 'Reads existing human authority; historical audit metadata remains unavailable.',
        nextAction: 'Open Evidence', findings: [], documents: [],
      };
    }
  }
  // A document/fact/finding is not a review event or a before/after baseline.
  // These inputs currently carry no typed audit history for those questions.
  return upstreamGapAnswer(params,
    text.includes('changed')
      ? 'This cannot be answered from current canonical system truth. Missing upstream field: review baseline and before/after audit events.'
      : 'This cannot be answered from current canonical system truth. Missing upstream field: typed document review state or human review/override audit evidence.');
}
