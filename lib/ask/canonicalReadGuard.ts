// ASK BOUNDARY FILE — reads canonical truth, never produces it.
// No summation, scoring, risk creation, severity assignment, or pattern
// inference in this layer. Any change must pass scripts/ask/phase3Diagnostic.ts
// at 22/22, 0 gaps. See Ask workstream closeout.
import type { RetrievalResult, Source, StructuredFact } from '@/lib/ask/types';

export type CanonicalReadLayer =
  | 'human_override'
  | 'canonical_project_fact'
  | 'validation_snapshot'
  | 'execution_summary'
  | 'audit_event'
  | 'document_fact'
  | 'document_extraction';

export type TrustLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type GuardedEvidenceItem = {
  id: string;
  label: string;
  value: string;
  sourceDocumentName: string | null;
  pageNumber: number | null;
  factNodeKey: string | null;
  layer: CanonicalReadLayer;
  trustLevel: TrustLevel;
  isFallback: boolean;
  isStale: boolean;
  href: string | null;
};

export type CanonicalReadGuardResult = {
  evidence: GuardedEvidenceItem[];
  fallbackUsed: boolean;
  highestTrustLevel: TrustLevel | null;
};

function layerForFact(fact: StructuredFact): CanonicalReadLayer {
  switch (fact.sourceKind) {
    case 'human_override':
      return 'human_override';
    case 'canonical_project_fact':
      return 'canonical_project_fact';
    case 'human_review':
    case 'document_fact':
      return 'document_fact';
    default:
      return 'document_extraction';
  }
}

export function trustLevelForLayer(layer: CanonicalReadLayer): TrustLevel {
  switch (layer) {
    case 'human_override':
      return 1;
    case 'canonical_project_fact':
      return 2;
    case 'validation_snapshot':
      return 3;
    case 'execution_summary':
      return 4;
    case 'audit_event':
    case 'document_fact':
      return 5;
    case 'document_extraction':
      return 6;
  }
}

function evidenceFromSource(source: Source): GuardedEvidenceItem {
  const layer: CanonicalReadLayer =
    source.type === 'validator'
      ? 'validation_snapshot'
      : source.type === 'decision'
        ? 'execution_summary'
        : source.type === 'fact'
          ? 'document_fact'
          : source.type === 'document'
            ? 'document_extraction'
            : 'canonical_project_fact';

  return {
    id: `${source.type}:${source.factId ?? source.documentId ?? source.label}`,
    label: source.label,
    value: source.snippet ?? source.label,
    sourceDocumentName: source.documentName ?? null,
    pageNumber: source.page ?? null,
    factNodeKey: source.factId ?? null,
    layer,
    trustLevel: trustLevelForLayer(layer),
    isFallback: source.type === 'document',
    isStale: false,
    href: source.documentId ? `/platform/documents/${encodeURIComponent(source.documentId)}` : null,
  };
}

export function guardProjectRead(params: {
  retrieval: RetrievalResult;
  sources: Source[];
  projectId: string;
}): CanonicalReadGuardResult {
  const factEvidence = params.retrieval.facts.slice(0, 4).map((fact) => {
    const layer = layerForFact(fact);
    return {
      id: fact.factId ?? fact.id,
      label: fact.label,
      value: String(fact.value),
      sourceDocumentName: fact.documentName ?? null,
      pageNumber: fact.page ?? null,
      factNodeKey: fact.fieldKey ?? fact.factId ?? null,
      layer,
      trustLevel: trustLevelForLayer(layer),
      isFallback: layer === 'document_extraction',
      isStale: false,
      href: fact.extractedFrom.startsWith('project:')
        ? `/platform/projects/${encodeURIComponent(params.projectId)}`
        : `/platform/documents/${encodeURIComponent(fact.extractedFrom)}`,
    } satisfies GuardedEvidenceItem;
  });
  const sourceEvidence = params.sources.map(evidenceFromSource);
  const byId = new Map<string, GuardedEvidenceItem>();

  for (const item of [...factEvidence, ...sourceEvidence]) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }

  const evidence = Array.from(byId.values());
  const fallbackUsed = evidence.some((item) => item.isFallback);
  const highestTrustLevel = evidence.length > 0
    ? evidence.reduce<TrustLevel>((best, item) => item.trustLevel < best ? item.trustLevel : best, 6)
    : null;

  return {
    evidence,
    fallbackUsed,
    highestTrustLevel,
  };
}
