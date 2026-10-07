import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import {
  documentReviewedValueState,
  type HeldRegionAssertionReason,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import {
  loadRegionBoundAssertionRows,
  type RegionAssertionClient,
} from '@/lib/server/regionBoundHumanAssertions';

/**
 * The current human-reviewed truth of a set of documents, for any surface that
 * reads project truth (Project Ask, investigation context). The only source is
 * `human_fact_assertions`, resolved against each document's current extraction
 * by the same shared resolver the Validator, the document route and the
 * resolution queue use: an effective value is applied truth; a held value is
 * NOT, and says why.
 *
 * A document's extraction is read only when it has region-bound reviews, since
 * a review's currency cannot be decided without it.
 */

export type ReviewedTruthValue = Readonly<{
  documentId: string;
  factKey: string;
  anchorKey: string;
  value: unknown;
  assertionId: string;
  physicalPageNumber: number;
  reviewOrigin: string;
  assertedAt: string;
  originalSourceText: string | null;
}>;

export type ReviewedTruthHeld = Readonly<{
  documentId: string;
  factKey: string;
  anchorKey: string;
  reason: HeldRegionAssertionReason;
  assertionIds: readonly string[];
}>;

export type ProjectReviewedTruth =
  | Readonly<{ status: 'ok'; effective: readonly ReviewedTruthValue[]; held: readonly ReviewedTruthHeld[] }>
  /** The B3 store is not deployed: no reviewed truth can exist. */
  | Readonly<{ status: 'unavailable'; effective: readonly []; held: readonly [] }>;

type ExtractionRow = { document_id: string; created_at: string | null; data: Record<string, unknown> | null };

export async function readProjectReviewedTruth(
  admin: RegionAssertionClient,
  params: Readonly<{ organizationId: string; documentIds: readonly string[] }>,
): Promise<ProjectReviewedTruth> {
  const assertionRead = await loadRegionBoundAssertionRows(admin, params.documentIds);
  if (assertionRead.status === 'unavailable') return { status: 'unavailable', effective: [], held: [] };
  const rows = assertionRead.rows.filter((row) => row.organization_id === params.organizationId);
  const reviewedDocumentIds = [...new Set(rows.flatMap((row) => row.source_document_id ? [row.source_document_id] : []))]
    .filter((id) => params.documentIds.includes(id));
  if (reviewedDocumentIds.length === 0) return { status: 'ok', effective: [], held: [] };

  // The same preferred-extraction choice the Validator and the resolution queue make.
  const query = (admin as unknown as { from(table: string): { select(columns: string): {
    in(column: string, values: readonly string[]): { is(column: string, value: null): {
      order(column: string, options: { ascending: boolean }): PromiseLike<{ data: unknown; error: unknown }> } } } } })
    .from('document_extractions').select('document_id, created_at, data')
    .in('document_id', reviewedDocumentIds).is('field_key', null).order('created_at', { ascending: false });
  const { data, error } = await query;
  if (error) throw new Error('Failed to load extractions for reviewed truth.');
  const byDocument = new Map<string, ExtractionRow[]>();
  for (const row of Array.isArray(data) ? data as ExtractionRow[] : []) {
    byDocument.set(row.document_id, [...(byDocument.get(row.document_id) ?? []), row]);
  }

  const effective: ReviewedTruthValue[] = [];
  const held: ReviewedTruthHeld[] = [];
  for (const documentId of reviewedDocumentIds) {
    const state = documentReviewedValueState({
      documentId,
      organizationId: params.organizationId,
      rows,
      extractionData: pickPreferredExtractionBlob(byDocument.get(documentId) ?? [])?.data ?? null,
    });
    for (const entry of state.effective) {
      effective.push({
        documentId, factKey: entry.factKey, anchorKey: entry.anchorKey, value: entry.value,
        assertionId: entry.provenance.assertionId, physicalPageNumber: entry.provenance.physicalPageNumber,
        reviewOrigin: entry.provenance.reviewOrigin, assertedAt: entry.provenance.assertedAt,
        originalSourceText: entry.provenance.originalSourceText,
      });
    }
    for (const entry of state.held) {
      held.push({ documentId, factKey: entry.factKey, anchorKey: entry.anchorKey, reason: entry.reason,
        assertionIds: entry.assertionIds });
    }
  }
  return { status: 'ok', effective, held };
}
