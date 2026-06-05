// ASK SELECTOR - reads canonical truth, never produces it.
// No summation, counting, scoring, finding creation, or inference. If the value
// is not already canonical, this is needs-upstream-fact, not a selector. Reads
// THROUGH canonicalReadGuard. Portfolio selectors read portfolio-safe-aggregate
// ONLY - never project-deep. Must pass its matrix-traced probe at matrixSpecific
// + matrixSourced + matrixEvidenceAdequate.
import type { Source, StructuredFact, ValidatorFinding, DecisionRecord, AskDocument } from '@/lib/ask/types';

export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return 'unresolved';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

export function humanize(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalKey(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function factValue(facts: StructuredFact[], keys: string[]): StructuredFact | null {
  const allowed = new Set(keys);
  return facts.find((fact) => allowed.has(canonicalKey(fact.fieldKey ?? fact.label))) ?? null;
}

export function sourceFromFact(fact: StructuredFact): Source {
  const projectScoped = fact.extractedFrom.startsWith('project:');
  return {
    type: 'fact',
    label: fact.documentName ?? fact.sourceLabel ?? 'Canonical project fact',
    documentId: projectScoped ? undefined : fact.extractedFrom,
    documentName: fact.documentName,
    page: fact.page,
    snippet: `${fact.label}: ${String(fact.value)}`.slice(0, 50),
    confidence: fact.confidence,
    timestamp: fact.timestamp,
    anchorId: fact.anchorId,
    factId: fact.factId ?? fact.id,
  };
}

export function sourceFromFinding(finding: ValidatorFinding): Source {
  return {
    type: 'validator',
    label: finding.documentName ?? 'Project validator finding',
    documentId: finding.documentId ?? undefined,
    documentName: finding.documentName ?? undefined,
    page: finding.page ?? undefined,
    snippet: finding.description.slice(0, 50),
    confidence: finding.blocksProject ? 95 : 84,
    timestamp: finding.timestamp,
    factId: finding.factId ?? finding.id,
  };
}

export function sourceFromDecision(decision: DecisionRecord): Source {
  return {
    type: 'decision',
    label: decision.documentName ? `${decision.documentName} decision` : 'Execution item source',
    documentId: decision.documentId ?? undefined,
    documentName: decision.documentName ?? undefined,
    snippet: (decision.summary ?? decision.title).slice(0, 50),
    confidence: decision.confidence ?? 78,
    timestamp: decision.detectedAt ?? decision.createdAt,
    factId: decision.id,
  };
}

export function sourceFromDocument(document: AskDocument): Source {
  return {
    type: 'document',
    label: document.title,
    documentId: document.id,
    documentName: document.documentName,
    snippet: [document.documentType, document.processingStatus].filter(Boolean).join(' / ').slice(0, 50),
    confidence: 72,
    timestamp: document.processedAt ?? document.createdAt,
    factId: document.id,
  };
}

export function fallbackSource(projectId: string, label: string, timestamp = new Date(0).toISOString()): Source {
  return {
    type: 'validator',
    label,
    snippet: label.slice(0, 50),
    confidence: 76,
    timestamp,
    factId: `project:${projectId}:validator-summary`,
  };
}

export function sourceId(source: Source): string {
  return source.factId ?? source.anchorId ?? source.documentId ?? source.label;
}

export function selectedSources(params: {
  facts?: StructuredFact[];
  findings?: ValidatorFinding[];
  decisions?: DecisionRecord[];
  documents?: AskDocument[];
  projectId: string;
  fallbackLabel: string;
}): Source[] {
  const sources = [
    ...(params.facts ?? []).slice(0, 3).map(sourceFromFact),
    ...(params.findings ?? []).slice(0, 3).map(sourceFromFinding),
    ...(params.decisions ?? []).slice(0, 2).map(sourceFromDecision),
    ...(params.documents ?? []).slice(0, 2).map(sourceFromDocument),
  ];

  return sources.length > 0 ? sources : [fallbackSource(params.projectId, params.fallbackLabel)];
}
