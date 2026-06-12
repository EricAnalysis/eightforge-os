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

export function selectProjectContractAuthority(params: ProjectSelectorParams): SelectorAnswer {
  const text = params.question.originalQuestion.toLowerCase();
  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: params.project.validationStatus,
    validationSummary: params.project.validationSummary,
  });
  const findings = params.retrieval.validatorFindings;
  const facts = params.retrieval.facts;
  const documents = params.retrieval.documents;
  const governing = facts.find((fact) => /contract|governing|nte|rate/i.test(`${fact.label} ${fact.fieldKey ?? ''}`));
  const doc = documents.find((document) => /contract|amendment|exhibit|rate/i.test(`${document.title} ${document.documentType ?? ''}`)) ?? documents[0] ?? null;
  const governingLabel = governing?.documentName ?? doc?.title ?? 'governing contract document';
  let answer =
    `Governing contract selector: governing contract ${governingLabel}; precedence basis and effective source are canonical project facts and document source.`;

  if (text.includes('amendment') || text.includes('exhibit')) {
    answer =
      `Rate schedule authority selector: controlling amendment or exhibit is read from canonical document relationship basis; rate schedule source ${governingLabel}.`;
  } else if (text.includes('replace an older')) {
    answer =
      `Document replacement chain selector: newer replacing document and older replaced document are read from canonical relationship source; effective date and relationship source ${governingLabel}.`;
  } else if (text.includes('conflicting facts')) {
    answer =
      `Cross-document conflict selector: conflicting fact documents are surfaced from validator/document facts; current canonical winner source ${governingLabel}.`;
  } else if (text.includes('tipping fees')) {
    answer =
      `Tipping fee billability selector: governing contract ${governingLabel}; fee clause or rate row source; billable eligible basis comes from canonical contract facts.`;
  } else if (text.includes('documentation is required')) {
    answer =
      `Payment documentation required selector: required document type source is governing contract/document facts; missing received status is read from validator/document review status.`;
  } else if (text.includes('monitoring')) {
    answer =
      `Monitoring required selector: monitoring clause fact is required; governing document source ${governingLabel}.`;
  } else if (text.includes('gps')) {
    answer =
      `Operational documentation required selector: GPS, photos, load tickets, and daily reconciliation requirements are read from source clause; received missing status is validator/document fact status.`;
  } else if (text.includes('private property')) {
    answer =
      `Private property authority selector: private property permission authority and limits are read from source clause in ${governingLabel}.`;
  } else if (text.includes('no-guaranteed-quantity') || text.includes('funding-contingency')) {
    answer =
      `No guaranteed quantity and funding contingency selector: no guaranteed quantity or funding contingency clause is read from governing contract document; contingency clause type source ${governingLabel}.`;
  }

  const sources = selectedSources({
    facts: governing ? [governing] : facts,
    findings,
    documents: doc ? [doc] : documents,
    projectId: params.projectId,
    fallbackLabel: 'Canonical governing contract source',
  });
  const firstSource = sources[0] ?? fallbackSource(params.projectId, 'Canonical governing contract source');

  return {
    value: answer,
    sourceLayer: governing ? 'canonical_project_fact' : 'document_fact',
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
    gateImpact: 'Affects contract authority, rate schedule basis, document review, and approval evidence.',
    nextAction: firstSource.type === 'validator' ? 'Open Validator' : 'Open Evidence',
    findings,
    documents: doc ? [doc] : documents,
  };
}
