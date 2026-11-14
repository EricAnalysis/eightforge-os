import { categoryReviewTargets } from '@/lib/contracts/categoryReview';
import { ALLOWED_RATE_CATEGORIES } from '@/lib/validator/rateTaxonomy';
import { layoutObservationsLayerOf, pageVisualEvidence, type DiagnosticSourceRef } from '@/lib/recovery/diagnosticVisualEvidence';
import { canonicalBoxesForObservations } from '@/lib/recovery/visualSourceEvidence';
import type { CanonicalBox } from '@/lib/extraction/geometry/canonicalPageFrame';
import type { SourceRegion } from '@/lib/humanFactAssertions/regionBoundAssertions';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : null;
const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.flatMap((item) => {
  const parsed = record(item); return parsed ? [parsed] : [];
}) : [];
const box = (value: unknown) => {
  const source = record(value);
  const xMin = Number(source?.x_min); const xMax = Number(source?.x_max);
  const yMin = Number(source?.y_min); const yMax = Number(source?.y_max);
  return [xMin, xMax, yMin, yMax].every(Number.isFinite) && xMax > xMin && yMax > yMin
    ? { x_min: xMin, x_max: xMax, y_min: yMin, y_max: yMax } : null;
};
const sameBox = (left: ReturnType<typeof box>, right: ReturnType<typeof box>) => !!left && !!right
  && left.x_min === right.x_min && left.x_max === right.x_max
  && left.y_min === right.y_min && left.y_max === right.y_max;

/** Supplemental evidence for a Category decision; it never changes the assertion target. */
export type ValueReadingCategoryEvidence = Readonly<{
  sourceDocumentId: string;
  sourceArtifactId: string;
  extractionSnapshotId: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  rowId: string;
  sourceObservationIds: readonly string[];
  sourceRegion: SourceRegion;
  rawText: string;
  /** Exact printed taxonomy value, or null when only operator Category selection is safe. */
  supportedCategory: string | null;
  canonicalBoxes: readonly CanonicalBox[];
}>;

/** Resolve only the Category cell of the same published row in the pinned extraction. */
export function resolveValueReadingCategoryEvidence(params: Readonly<{
  extractionData: unknown;
  sourceDocumentId: string;
  sourceArtifactId: string;
  extractionSnapshotId: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  anchorKey: string;
}>): Readonly<{ required: false; evidence: null } | { required: true; evidence: ValueReadingCategoryEvidence | null }> {
  const matchingTargets = categoryReviewTargets(params.extractionData, params.sourceDocumentId)
    .filter((target) => target.anchorKey === params.anchorKey);
  if (matchingTargets.length === 0) return { required: false, evidence: null };
  if (matchingTargets.length !== 1) return { required: true, evidence: null };
  const categoryTarget = matchingTargets[0]!;
  if (categoryTarget.physicalPageNumber !== params.physicalPageNumber
    || categoryTarget.pageRepresentationDigest !== params.pageRepresentationDigest
    || categoryTarget.visual?.sourceArtifactId !== params.sourceArtifactId
    || categoryTarget.visual?.sourceDocumentId !== params.sourceDocumentId) return { required: true, evidence: null };
  const extraction = record(params.extractionData);
  const pdf = record(record(record(extraction?.extraction)?.content_layers_v1)?.pdf);
  const reconstruction = record(pdf?.priced_schedule_reconstruction_v1);
  const pages = records(reconstruction?.pages).filter((page) => page.physical_page_number === params.physicalPageNumber);
  if (pages.length !== 1) return { required: true, evidence: null };
  const rows = records(pages[0]?.rows).filter((row) =>
    `page_priced_schedule:p${params.physicalPageNumber}:r${row.row_index}` === categoryTarget.rowId);
  if (rows.length !== 1 || rows[0]?.physical_page_number !== params.physicalPageNumber) return { required: true, evidence: null };
  const columns = records(pages[0]?.columns);
  const cells = records(rows[0]?.unresolved_role_cells).filter((cell) => {
    const index = cell.column_index;
    return Number.isInteger(index) && typeof index === 'number' && index >= 0 && index < columns.length
      && String(cell.header_text).trim().toLowerCase() === 'category'
      && String(columns[index]?.header_text ?? '').trim().toLowerCase() === 'category';
  });
  if (cells.length !== 1) return { required: true, evidence: null };
  const cell = cells[0]!;
  const cellBox = box(cell);
  const refs = records(cell.source_refs);
  if (!cellBox || refs.length === 0 || refs.length > 18) return { required: true, evidence: null };
  const layer = layoutObservationsLayerOf(params.extractionData);
  if (!layer || layer.source_artifact_id !== params.sourceArtifactId) return { required: true, evidence: null };
  const observations = records(layer.observations);
  const ids = new Set<string>();
  const verifiedRefs: DiagnosticSourceRef[] = [];
  for (const ref of refs) {
    const id = ref.observation_id;
    const refBox = box(ref);
    if (typeof id !== 'string' || !id || ids.has(id) || !refBox
      || refBox.x_min < cellBox.x_min || refBox.x_max > cellBox.x_max
      || refBox.y_min < cellBox.y_min || refBox.y_max > cellBox.y_max
      || (ref.source !== 'pdfjs' && ref.source !== 'ocr_fallback') || typeof ref.text !== 'string') {
      return { required: true, evidence: null };
    }
    const matches = observations.filter((item) => item.id === id);
    const observation = matches[0];
    const metadata = record(observation?.metadata);
    const location = record(observation?.location);
    if (matches.length !== 1 || observation?.source_document_id !== params.sourceDocumentId
      || observation?.source_artifact_id !== params.sourceArtifactId
      || observation?.physical_page_number !== params.physicalPageNumber
      || observation?.source_method !== ref.source || observation?.raw_text !== ref.text
      || metadata?.page_representation_digest !== params.pageRepresentationDigest
      || metadata?.source_document_id !== params.sourceDocumentId
      || metadata?.source_artifact_id !== params.sourceArtifactId
      || location?.page !== params.physicalPageNumber
      || !sameBox(box(location?.bounding_box), refBox)
      || !sameBox(box(metadata?.bounding_box), refBox)) return { required: true, evidence: null };
    ids.add(id);
    verifiedRefs.push({ observation_id: id, text: ref.text, source: ref.source,
      x_min: refBox.x_min, x_max: refBox.x_max, y_min: refBox.y_min, y_max: refBox.y_max });
  }
  const visual = pageVisualEvidence({ evidenceId: `value-reading-category:${params.anchorKey}`, summary: 'Category cell',
    extractionData: params.extractionData, sourceDocumentId: params.sourceDocumentId,
    physicalPageNumber: params.physicalPageNumber, pageRepresentationDigest: params.pageRepresentationDigest,
    refs: verifiedRefs });
  const sourceObservationIds = [...ids].sort();
  const canonicalBoxes = visual && visual.sourceArtifactId === params.sourceArtifactId
    ? canonicalBoxesForObservations(visual, sourceObservationIds) : null;
  if (!canonicalBoxes) return { required: true, evidence: null };
  const printed = [...new Set(verifiedRefs.map((ref) => ref.text.trim()).filter((text) => ALLOWED_RATE_CATEGORIES.includes(text)))];
  if (printed.length > 1) return { required: true, evidence: null };
  return { required: true, evidence: {
    sourceDocumentId: params.sourceDocumentId, sourceArtifactId: params.sourceArtifactId,
    extractionSnapshotId: params.extractionSnapshotId, physicalPageNumber: params.physicalPageNumber,
    pageRepresentationDigest: params.pageRepresentationDigest, rowId: categoryTarget.rowId,
    sourceObservationIds, sourceRegion: { coordinate_space: 'source', boxes: verifiedRefs.map((ref) => ({
      x_min: ref.x_min, x_max: ref.x_max, y_min: ref.y_min, y_max: ref.y_max,
    })) },
    rawText: String(cell.raw_text), supportedCategory: printed[0] ?? null, canonicalBoxes,
  } };
}
