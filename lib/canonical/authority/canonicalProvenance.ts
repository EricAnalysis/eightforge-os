/**
 * Canonical provenance: where a canonical fact came from, honestly.
 *
 * Every canonical invoice, invoice line, transaction, and relationship carries
 * one of these. It is assembled from evidence the source already produced — it
 * never invents a coordinate. A missing bounding box stays null; fabricating
 * geometry to look complete was an audited defect class in this repository and
 * is exactly what `CanonicalBoundingBox.complete` exists to expose.
 *
 * This module does NOT introduce a second evidence subsystem. It reuses
 * `CanonicalEvidenceRef` as the structural record and adds only the four
 * dimensions the ref does not carry: which artifact, which adapter, which
 * source family, and how the value came to be (observed / derived / asserted).
 * `projectProvenanceEvidence` renders provenance into the SHAPE the existing
 * validator finding-evidence model already accepts, so canonical findings reuse
 * `makeFinding` unchanged.
 */

import type {
  CanonicalBoundingBox,
  CanonicalEvidenceRef,
} from '@/lib/canonical/truth/envelope';

/**
 * How a canonical fact came to hold its value.
 *
 * `unresolved` is a first-class outcome, not an error: a fact whose basis could
 * not be established must say so rather than borrow a confident derivation.
 */
export type CanonicalProvenanceDerivation =
  | 'observed'
  | 'derived'
  | 'operator_asserted'
  | 'unresolved';

export type CanonicalProvenance = {
  readonly sourceArtifactId: string | null;
  readonly sourceDocumentId: string | null;
  /** Free-form document-family label, carried verbatim. Never branched on. */
  readonly sourceFamily: string | null;
  /** Which canonical adapter produced the fact. Always known. */
  readonly adapterId: string;
  readonly derivation: CanonicalProvenanceDerivation;
  readonly operatorAssertionId: string | null;
  /** Opaque id of the source observation (persisted row, extraction artifact). */
  readonly observationId: string | null;
  readonly page: number | null;
  readonly sheetName: string | null;
  readonly rowNumber: number | null;
  /** Null when the source carried no geometry. Never synthesized. */
  readonly boundingBox: CanonicalBoundingBox | null;
  readonly rawSpan: string | null;
  readonly evidence: readonly CanonicalEvidenceRef[];
};

/**
 * Structural mirror of the validator's finding-evidence input.
 *
 * Declared here so canonical modules can project evidence without importing
 * `lib/validator`, and so rule packs can consume projected evidence without
 * importing `lib/canonical`. Neither direction gains a new module edge.
 */
export type CanonicalFindingEvidence = {
  readonly evidence_type: string;
  readonly source_document_id: string | null;
  readonly source_page: number | null;
  readonly record_id: string | null;
  readonly field_name: string | null;
  readonly field_value: unknown;
  readonly note: string | null;
};

function firstNonNull<T>(values: readonly (T | null | undefined)[]): T | null {
  for (const value of values) {
    if (value != null) return value;
  }
  return null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Builds provenance from evidence the source already produced.
 *
 * Coordinates are read from the supplied evidence refs in order and from the
 * explicit overrides; whichever is present first wins, and nothing is inferred
 * when both are absent. Missing geometry is acceptable as long as document,
 * page, or observation identity stays honest — which
 * `provenanceIsLocatable` reports rather than assumes.
 */
export function buildCanonicalProvenance(input: {
  readonly adapterId: string;
  readonly derivation: CanonicalProvenanceDerivation;
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly sourceArtifactId?: string | null;
  readonly sourceDocumentId?: string | null;
  readonly sourceFamily?: string | null;
  readonly operatorAssertionId?: string | null;
  readonly observationId?: string | null;
  readonly page?: number | null;
  readonly sheetName?: string | null;
  readonly rowNumber?: number | null;
}): CanonicalProvenance {
  const evidence = input.evidence;
  return {
    sourceArtifactId: nonEmpty(input.sourceArtifactId),
    sourceDocumentId: nonEmpty(input.sourceDocumentId)
      ?? firstNonNull(evidence.map((ref) => ref.documentId)),
    sourceFamily: nonEmpty(input.sourceFamily),
    adapterId: input.adapterId,
    derivation: input.derivation,
    operatorAssertionId: nonEmpty(input.operatorAssertionId),
    observationId: nonEmpty(input.observationId)
      ?? firstNonNull(evidence.map((ref) => ref.extractionArtifactId ?? ref.sourceAnchor)),
    page: finite(input.page) ?? firstNonNull(evidence.map((ref) => ref.page)),
    sheetName: nonEmpty(input.sheetName) ?? firstNonNull(evidence.map((ref) => ref.tableKey)),
    rowNumber: finite(input.rowNumber) ?? firstNonNull(evidence.map((ref) => ref.rowIndex)),
    // Geometry is taken only where the source produced it. There is no
    // "reasonable default" box; an absent box is the truthful answer.
    boundingBox: firstNonNull(evidence.map((ref) => ref.boundingBox)),
    rawSpan: firstNonNull(evidence.map((ref) => ref.rawSpan)),
    evidence,
  };
}

/**
 * True when provenance can actually take an operator back to a source.
 *
 * Geometry is not required. A document plus a page, sheet/row, or observation
 * id is enough to locate the fact; without any of those the provenance is
 * decorative and callers should treat the fact as unlocatable rather than
 * pretending it is anchored.
 */
export function provenanceIsLocatable(provenance: CanonicalProvenance): boolean {
  if (provenance.sourceDocumentId == null) return false;
  return (
    provenance.page != null
    || provenance.rowNumber != null
    || provenance.observationId != null
    || (provenance.boundingBox?.complete ?? false)
  );
}

/**
 * Deterministic provenance summary, safe to embed in a finding note.
 *
 * Stable across runs for the same source, so repeated runs produce identical
 * evidence identity rather than a new-looking finding each time.
 */
export function describeProvenance(provenance: CanonicalProvenance): string {
  const parts = [
    provenance.sourceDocumentId ? `document ${provenance.sourceDocumentId}` : 'document unknown',
    provenance.page != null ? `page ${String(provenance.page)}` : null,
    provenance.sheetName ? `sheet ${provenance.sheetName}` : null,
    provenance.rowNumber != null ? `row ${String(provenance.rowNumber)}` : null,
    provenance.observationId ? `observation ${provenance.observationId}` : null,
  ].filter((part): part is string => part != null);
  return `${parts.join(', ')} (${provenance.adapterId}, ${provenance.derivation})`;
}

/**
 * Projects canonical provenance into the existing finding-evidence shape.
 *
 * The single place canonical provenance becomes validator evidence, so evidence
 * identity cannot drift between the packs that consume it.
 */
export function projectProvenanceEvidence(input: {
  readonly evidenceType: string;
  readonly recordId: string;
  readonly fieldName: string | null;
  readonly fieldValue: unknown;
  readonly provenance: CanonicalProvenance;
  readonly note?: string | null;
}): CanonicalFindingEvidence {
  const { provenance } = input;
  return {
    evidence_type: input.evidenceType,
    source_document_id: provenance.sourceDocumentId,
    source_page: provenance.page,
    record_id: input.recordId,
    field_name: input.fieldName,
    field_value: input.fieldValue,
    note: input.note != null && input.note.length > 0
      ? `${input.note} Source: ${describeProvenance(provenance)}.`
      : `Source: ${describeProvenance(provenance)}.`,
  };
}
