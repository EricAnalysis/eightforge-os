import { hashCanonical } from '@/lib/extraction/domain/hash';
import { documentReviewedValueState } from '@/lib/humanFactAssertions/regionBoundAssertions';
import {
  buildResolutionQueue,
  type DocumentEvidenceAttention,
  type DocumentReviewedValueState,
  type ResolutionCase,
  type ResolutionCaseKind,
} from '@/lib/resolution/resolutionCases';
import { documentEvidenceAttention } from '@/lib/server/documentEvidenceAttention';

/**
 * Offline, unreviewed inventory of the evidence EightForge cannot yet price
 * (B4.6.1 qualification input). Composes, never recomputes: every entry is a
 * ResolutionCase the queue would open for the same extraction, derived through
 * the same shared attention and case builders. No reviewed assertions, no
 * Validator findings, no recovery proposals: those live in the database and
 * are out of scope for a pinned-payload inventory.
 *
 * Classes stay typed and separate; an evidence identity that lands in two
 * classes is reported as an overlap, never merged or re-scored.
 */

export const INVENTORY_CLASS_BY_KIND = Object.freeze({
  unreadable_priced_line: 'legacy_unresolved_line',
  withheld_priced_line: 'withheld_bundle',
  structure_review: 'structure_case',
  coverage_gap: 'coverage_gap',
  pricing_withheld: 'pricing_withheld_page',
  category_review: 'category_review',
} as const satisfies Partial<Record<ResolutionCaseKind, string>>);

export type InventoryClass =
  | (typeof INVENTORY_CLASS_BY_KIND)[keyof typeof INVENTORY_CLASS_BY_KIND]
  | 'scanned_review_required_value'
  | 'unreadable_native_amount';

export const INVENTORY_CLASSES: readonly InventoryClass[] = Object.freeze([
  'legacy_unresolved_line', 'withheld_bundle', 'scanned_review_required_value', 'unreadable_native_amount',
  'structure_case', 'coverage_gap', 'pricing_withheld_page', 'category_review',
]);

export type InventoryDocumentInput = Readonly<{
  documentId: string;
  label: string;
  extraction: Readonly<{ id?: string; created_at: string | null; data: Record<string, unknown> }>;
}>;

export type InventoryEntry = Readonly<{
  /** Stable evidence identity: the row anchor when one exists, else the page-level evidence digest. */
  identity: string;
  inventoryClass: InventoryClass;
  documentLabel: string;
  documentId: string;
  physicalPageNumber: number | null;
  caseId: string;
  caseKind: ResolutionCaseKind;
  tier: ResolutionCase['tier'];
  rootCauseKey: string;
  diagnosticCode: string | null;
  /** Other facts the same decision must settle (a value case that also needs its category). */
  alsoUnresolved: readonly string[];
  originalSourceText: string | null;
}>;

export type ResolutionEvidenceInventory = Readonly<{
  schema: 'resolution_evidence_inventory_v1';
  documents: readonly Readonly<{ documentId: string; label: string }>[];
  entries: readonly InventoryEntry[];
  /** Distinct identities per class; classes are never pooled. */
  countsByClass: Readonly<Record<InventoryClass, number>>;
  countsByDocumentAndClass: Readonly<Record<string, Readonly<Record<InventoryClass, number>>>>;
  /** Value cases that also carry an unresolved category (counted once, under their value class). */
  attachedCategoryRequirements: number;
  distinctIdentities: number;
  /** Identities that appear in more than one class: reported, never merged. */
  overlaps: readonly Readonly<{ identity: string; classes: readonly InventoryClass[] }>[];
  /** Case kinds the inventory does not classify (database-backed kinds); counted, never silently dropped. */
  unclassifiedKinds: Readonly<Record<string, number>>;
}>;

const OFFLINE_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000000';

function caseIdentity(entry: ResolutionCase): string {
  if (entry.sourceRefs.anchorKey) return `${entry.documentId}:${entry.sourceRefs.anchorKey}`;
  // Page-level evidence: the diagnostic code and its observations, never the
  // diagnostic id (which binds the extraction snapshot and time).
  const observations = entry.evidence.flatMap((ref) => [...ref.observationIds]).sort();
  return `${entry.documentId}:p${entry.physicalPageNumber ?? 'document'}:${entry.diagnostic?.code ?? entry.kind}:`
    + hashCanonical(observations).slice(0, 32);
}

function classify(entry: ResolutionCase, attention: DocumentEvidenceAttention | undefined): InventoryClass | null {
  if (entry.kind === 'review_required_value') {
    const target = (attention?.reviewRequiredTargets ?? []).find((t) => t.anchorKey === entry.sourceRefs.anchorKey);
    return target?.basis === 'unreadable_amount' ? 'unreadable_native_amount' : 'scanned_review_required_value';
  }
  return (INVENTORY_CLASS_BY_KIND as Partial<Record<ResolutionCaseKind, InventoryClass>>)[entry.kind] ?? null;
}

function emptyCounts(): Record<InventoryClass, number> {
  return Object.fromEntries(INVENTORY_CLASSES.map((name) => [name, 0])) as Record<InventoryClass, number>;
}

export function buildResolutionEvidenceInventory(
  documents: readonly InventoryDocumentInput[],
): ResolutionEvidenceInventory {
  const attentionByDocument = new Map<string, DocumentEvidenceAttention>();
  const reviewedValuesByDocument = new Map<string, DocumentReviewedValueState>();
  for (const document of documents) {
    attentionByDocument.set(document.documentId, documentEvidenceAttention({
      organizationId: OFFLINE_ORGANIZATION_ID, documentId: document.documentId, extraction: document.extraction,
    }));
    // Unreviewed by construction: no assertion rows.
    reviewedValuesByDocument.set(document.documentId, documentReviewedValueState({
      documentId: document.documentId, organizationId: OFFLINE_ORGANIZATION_ID, rows: [],
      extractionData: document.extraction.data,
    }));
  }
  const queue = buildResolutionQueue({
    projectId: 'offline_inventory',
    documents: documents.map((document) => ({ id: document.documentId, title: document.label })),
    issues: [],
    evidence: [],
    reviewedValuesByDocument,
    recoveryProposals: [],
    forgewingEnabled: false,
    evidenceAttentionByDocument: attentionByDocument,
  });

  const labelById = new Map(documents.map((document) => [document.documentId, document.label] as const));
  const entries: InventoryEntry[] = [];
  const unclassifiedKinds: Record<string, number> = {};
  for (const entry of queue.cases) {
    const inventoryClass = classify(entry, entry.documentId ? attentionByDocument.get(entry.documentId) : undefined);
    if (!inventoryClass) {
      unclassifiedKinds[entry.kind] = (unclassifiedKinds[entry.kind] ?? 0) + 1;
      continue;
    }
    entries.push({
      identity: caseIdentity(entry),
      inventoryClass,
      documentLabel: labelById.get(entry.documentId ?? '') ?? entry.documentId ?? 'unknown',
      documentId: entry.documentId ?? 'unknown',
      physicalPageNumber: entry.physicalPageNumber,
      caseId: entry.caseId,
      caseKind: entry.kind,
      tier: entry.tier,
      rootCauseKey: entry.rootCauseKey,
      diagnosticCode: entry.diagnostic?.code ?? null,
      alsoUnresolved: [...(entry.alsoUnresolved ?? [])],
      originalSourceText: entry.originalSourceText,
    });
  }
  entries.sort((a, b) => a.documentLabel.localeCompare(b.documentLabel)
    || (a.physicalPageNumber ?? -1) - (b.physicalPageNumber ?? -1)
    || a.inventoryClass.localeCompare(b.inventoryClass) || a.identity.localeCompare(b.identity));

  const classesByIdentity = new Map<string, Set<InventoryClass>>();
  for (const entry of entries) {
    classesByIdentity.set(entry.identity, (classesByIdentity.get(entry.identity) ?? new Set()).add(entry.inventoryClass));
  }
  const countsByClass = emptyCounts();
  const countsByDocumentAndClass: Record<string, Record<InventoryClass, number>> = {};
  const counted = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.inventoryClass}\u0000${entry.identity}`;
    if (counted.has(key)) continue;
    counted.add(key);
    countsByClass[entry.inventoryClass] += 1;
    const perDocument = countsByDocumentAndClass[entry.documentLabel] ??= emptyCounts();
    perDocument[entry.inventoryClass] += 1;
  }
  return {
    schema: 'resolution_evidence_inventory_v1',
    documents: documents.map((document) => ({ documentId: document.documentId, label: document.label })),
    entries,
    countsByClass,
    countsByDocumentAndClass,
    attachedCategoryRequirements: entries.filter((entry) =>
      entry.inventoryClass !== 'category_review' && entry.alsoUnresolved.includes('category')).length,
    distinctIdentities: classesByIdentity.size,
    overlaps: [...classesByIdentity].filter(([, classes]) => classes.size > 1)
      .map(([identity, classes]) => ({ identity, classes: [...classes].sort() })),
    unclassifiedKinds,
  };
}
