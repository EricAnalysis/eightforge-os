import type { EvidenceObject } from '@/lib/extraction/types';
import type {
  NormalizedNodeDocument,
  PipelineDecision,
  PipelineFact,
} from '@/lib/pipeline/types';
import type {
  DecisionAction,
  DecisionActionTargetType,
  DecisionActionType,
  FlowTask,
} from '@/lib/types/documentIntelligence';

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

export function getFact(
  document: NormalizedNodeDocument,
  key: string,
): PipelineFact | null {
  return document.fact_map[key] ?? null;
}

export function getStringFact(
  document: NormalizedNodeDocument,
  key: string,
): string | null {
  const fact = getFact(document, key);
  return typeof fact?.value === 'string' && fact.value.trim().length > 0
    ? fact.value.trim()
    : null;
}

export function getNumberFact(
  document: NormalizedNodeDocument,
  key: string,
): number | null {
  const fact = getFact(document, key);
  return typeof fact?.value === 'number' && Number.isFinite(fact.value)
    ? fact.value
    : null;
}

export function getBooleanFact(
  document: NormalizedNodeDocument,
  key: string,
): boolean | null {
  const fact = getFact(document, key);
  return typeof fact?.value === 'boolean' ? fact.value : null;
}

export function getArrayFact<T>(
  document: NormalizedNodeDocument,
  key: string,
): T[] {
  const fact = getFact(document, key);
  return Array.isArray(fact?.value) ? (fact.value as T[]) : [];
}

export function findRelatedDocument(
  documents: NormalizedNodeDocument[],
  family: NormalizedNodeDocument['family'],
): NormalizedNodeDocument | null {
  return documents.find((document) => document.family === family) ?? null;
}

export function evidenceForFact(
  fact: PipelineFact | null,
  evidenceById: Map<string, EvidenceObject>,
): EvidenceObject[] {
  if (!fact) return [];
  return fact.evidence_refs
    .map((id) => evidenceById.get(id) ?? null)
    .filter((evidence): evidence is EvidenceObject => evidence != null);
}

/** Resolve evidence objects by id with stable de-duplication order. */
export function collectEvidenceByIds(
  ids: string[],
  evidenceById: Map<string, EvidenceObject>,
): EvidenceObject[] {
  const out: EvidenceObject[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const evidence = evidenceById.get(id);
    if (!evidence || seen.has(evidence.id)) continue;
    seen.add(evidence.id);
    out.push(evidence);
  }
  return out;
}

/** First N evidence objects from a related normalized document (for cross-doc decisions). */
export function relatedEvidencePreview(
  document: NormalizedNodeDocument | null,
  limit: number,
): EvidenceObject[] {
  if (!document?.evidence.length) return [];
  return document.evidence.slice(0, limit);
}

/** Target fields for the primary pipeline document (contract / invoice / ticket / pay rec). */
export function documentActionTarget(document: NormalizedNodeDocument): Pick<
  DecisionAction,
  'target_object_id' | 'target_label'
> {
  return {
    target_object_id: document.document_id,
    target_label: document.document_title ?? document.document_name,
  };
}

/**
 * Single-step operator action with a consistent DecisionAction shape across document skills.
 */
export function skillPrimaryAction(input: {
  id: string;
  type: DecisionActionType;
  target_object_type: DecisionActionTargetType;
  target_object_id?: string | null;
  target_label: string;
  description: string;
  expected_outcome: string;
}): DecisionAction {
  return {
    id: input.id,
    type: input.type,
    target_object_type: input.target_object_type,
    target_object_id: input.target_object_id ?? null,
    target_label: input.target_label,
    description: input.description,
    expected_outcome: input.expected_outcome,
    resolvable: false,
  };
}

export function primaryActionOnDocument(
  document: NormalizedNodeDocument,
  partial: Omit<DecisionAction, 'target_object_id' | 'target_label' | 'resolvable'>,
): DecisionAction {
  const target = documentActionTarget(document);
  return skillPrimaryAction({
    ...partial,
    target_object_id: target.target_object_id,
    target_label: target.target_label,
  });
}

export function makeDecision(input: {
  id: string;
  family: PipelineDecision['family'];
  severity: PipelineDecision['severity'];
  title: string;
  detail: string;
  confidence: number;
  fact_refs?: string[];
  evidence_objects?: EvidenceObject[];
  /** Machine citations (evidence_v1 paths, xrefs) prepended before evidence object ids. */
  extra_source_refs?: string[];
  missing_source_context?: string[];
  rule_id?: string;
  field_key?: string;
  expected_location?: string;
  observed_value?: string | number | null;
  expected_value?: string | number | null;
  impact?: string;
  reason?: string;
  primary_action?: PipelineDecision['primary_action'];
  suggested_actions?: PipelineDecision['suggested_actions'];
  reconciliation_scope?: PipelineDecision['reconciliation_scope'];
}): PipelineDecision {
  const evidenceIds = (input.evidence_objects ?? []).map((evidence) => evidence.id);
  const extras = input.extra_source_refs ?? [];
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const ref of [...extras, ...evidenceIds]) {
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    merged.push(ref);
  }
  return {
    id: input.id,
    family: input.family,
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    confidence: input.confidence,
    fact_refs: input.fact_refs ?? [],
    evidence_objects: input.evidence_objects ?? [],
    missing_source_context: input.missing_source_context ?? [],
    rule_id: input.rule_id,
    field_key: input.field_key,
    expected_location: input.expected_location,
    observed_value: input.observed_value,
    expected_value: input.expected_value,
    impact: input.impact,
    reason: input.reason,
    primary_action: input.primary_action,
    suggested_actions: input.suggested_actions,
    source_refs: merged,
    reconciliation_scope: input.reconciliation_scope,
  };
}

export function makeTask(input: {
  id: string;
  title: string;
  priority: FlowTask['priority'];
  verb: FlowTask['verb'];
  entity_type: FlowTask['entity_type'];
  flow_type: FlowTask['flow_type'];
  expected_outcome: string;
  source_decision_ids: string[];
  scope?: string;
}): FlowTask {
  return {
    id: input.id,
    title: input.title,
    verb: input.verb,
    entity_type: input.entity_type,
    scope: input.scope,
    expected_outcome: input.expected_outcome,
    priority: input.priority,
    auto_safe: false,
    source_decision_ids: input.source_decision_ids,
    flow_type: input.flow_type,
  };
}
