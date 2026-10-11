// ASK SELECTOR - reads stored facts; never infers contract authority or clauses.
import type { ProjectSelectorParams, SelectorAnswer } from '@/lib/ask/selectors';
import { canonicalKey, fallbackSource, sourceFromFact, sourceId } from './selectorUtils';

// These are read keys, not producers. A contract-looking document, an NTE
// amount, or an unrelated finding cannot stand in for the requested statement.
function requestedKeys(text: string): string[] {
  if (/amendment|exhibit|rate schedule/.test(text)) return ['rate_schedule_authority'];
  if (/replace an older/.test(text)) return ['document_replacement'];
  if (/conflicting facts/.test(text)) return ['cross_document_conflict'];
  if (/tipping fees/.test(text)) return ['tipping_fee_billability'];
  if (/documentation is required/.test(text)) return ['payment_documentation_required'];
  if (/monitoring/.test(text)) return ['monitoring_required'];
  if (/gps/.test(text)) return ['operational_documentation_required'];
  if (/private property/.test(text)) return ['private_property_authority'];
  if (/no-guaranteed-quantity|funding-contingency/.test(text)) return ['quantity_funding_terms'];
  if (/performance bond/.test(text)) return ['performance_bond'];
  if (/fema/.test(text)) return ['fema_reimbursability'];
  if (/governing|which contract/.test(text)) return ['governing_contract'];
  return [];
}

export function selectProjectContractAuthority(params: ProjectSelectorParams): SelectorAnswer {
  const keys = requestedKeys(params.question.originalQuestion.toLowerCase());
  const facts = params.retrieval.facts.filter((fact) =>
    keys.includes(canonicalKey(fact.fieldKey ?? fact.label)) &&
    String(fact.value).trim() !== '',
  );
  const distinctValues = new Set(facts.map((fact) => JSON.stringify(fact.value)));
  const available = facts.length > 0 && distinctValues.size === 1;
  const sources = available
    ? facts.map(sourceFromFact)
    : [fallbackSource(params.projectId, 'Missing or conflicting contract authority fact')];
  const value = available
    ? facts.map((fact) => `${fact.label}: ${String(fact.value)}`).join('\n')
    : `No verified contract authority statement found. Missing upstream field: ${keys.join(', ') || 'requested contract clause or authority statement'}. A document title or unrelated finding does not establish the requested clause or authority.`;
  return {
    value,
    sourceLayer: available && facts.every((fact) => fact.sourceKind === 'canonical_project_fact') ? 'canonical_project_fact' : 'document_fact',
    sourceId: sourceId(sources[0]),
    isFallback: false,
    isStale: false,
    confidence: available ? 'verified' : 'not_found',
    evidence: available ? facts.map((fact) => ({
      label: fact.label,
      value: String(fact.value),
      sourceId: fact.factId ?? fact.id,
    })) : [],
    sources,
    validationState: available ? 'Confirmed' : 'Not Found',
    gateImpact: 'No contract authority, billing eligibility, or approval state was changed.',
    nextAction: available ? 'Open Evidence' : 'Open Validator',
    findings: [],
    documents: [],
  };
}
