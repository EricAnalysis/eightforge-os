import { buildPdfLayoutObservationsLayer } from '@/lib/extraction/pdf/layoutObservationEvidence';
import { createPdfLayoutObservationIdentity, pdfLayoutPageRepresentationDigest } from '@/lib/extraction/pdf/layoutObservationIdentity';
import { PRICED_SCHEDULE_HEADER_INTERPRETATION_VERSION, type PagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import type { PdfLayout, PdfToken } from '@/lib/extraction/pdf/extractText';
import type { HeaderEvidenceContext } from './headerEvidence';
export const headerEvidenceFixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function headerEvidenceFixture(options: { seed?: number; offset?: number; labels?: string[]; source?: 'pdfjs' | 'ocr_fallback' } = {}) {
  const seed = options.seed ?? 0;
  const documentId = headerEvidenceFixtureId(3 + seed), artifactId = headerEvidenceFixtureId(5 + seed);
  const source = options.source ?? 'pdfjs';
  const labels = options.labels ?? ['Customer Description', 'Billing Rate'];
  const pageDigest = pdfLayoutPageRepresentationDigest(['header-page', source]);
  const tokens: PdfToken[] = labels.flatMap((label, column) => label.split(' ').map((text, word) => {
    const identity = createPdfLayoutObservationIdentity({ context: { sourceDocumentId: documentId, sourceArtifactId: artifactId },
      physicalPageNumber: 1, sourceMethod: source, parser: source === 'pdfjs' ? 'pdfjs_text_content' : 'tesseract_blocks',
      parserObservationKey: `${column}:${word}`, pageRepresentationDigest: pageDigest });
    return { text, x: (options.offset ?? 0) + column * 100 + word * 25, y: 100, width: 20, height: 10,
      source, observation_id: identity.id, observation_identity: identity };
  }));
  const refs = tokens.map(token => ({ observation_id: token.observation_id!, text: token.text,
    x_min: token.x, x_max: token.x + token.width, y_min: token.y, y_max: token.y + token.height, source: token.source }));
  let start = 0;
  const headerLabels = labels.map(text => { const source_refs = refs.slice(start, start + text.split(' ').length); start += source_refs.length; return { text, source_refs }; });
  const page = { status: 'reconstructed', semantic_status: 'unresolved', physical_page_number: 1, header_raw_text: labels.join(' '), header_y: 100,
    columns: headerLabels.map((label, column_index) => ({ header_text: label.text, header_source_refs: label.source_refs,
      role: null, x_min: column_index === 0 ? null : (options.offset ?? 0) + column_index * 100 - 25,
      x_max: column_index === headerLabels.length - 1 ? null : (options.offset ?? 0) + (column_index + 1) * 100 - 25 })), rows: [], rejected_spines: [], unassigned_lines: [],
    header_interpretation: { version: PRICED_SCHEDULE_HEADER_INTERPRETATION_VERSION, status: 'unresolved',
      reason: 'required_role_missing', grouping_basis: { clear: true }, labels: headerLabels, source_refs: refs } };
  const reconstruction = { parser_version: 'priced_schedule_reconstruction_v6', pages: [page] } as unknown as PagePricedScheduleReconstruction;
  const layout: PdfLayout = { page_count: 1, gaps: [], pages: [{ page_number: 1, lines: [{ id: 'header', page_number: 1,
    text: labels.join(' '), tokens, kind: 'table_candidate', x_min: refs[0]!.x_min,
    x_max: refs.at(-1)!.x_max, y: 100, source }] }] };
  const layer = JSON.parse(JSON.stringify(buildPdfLayoutObservationsLayer({ layout, reconstruction, context: { sourceDocumentId: documentId, sourceArtifactId: artifactId } }))) as { observations: Array<Record<string, any>> };
  const pdf = { priced_schedule_reconstruction_v1: reconstruction, layout_observations_v1: layer,
    page_extraction_coverage_v1: { pages: [{ page_number: 1, page_representation_digest: pageDigest }] } };
  const context: HeaderEvidenceContext = { actorOrganizationId: headerEvidenceFixtureId(1),
    document: { id: documentId, organization_id: headerEvidenceFixtureId(1), project_id: headerEvidenceFixtureId(2), document_type: 'contract' },
    project: { id: headerEvidenceFixtureId(2), organization_id: headerEvidenceFixtureId(1) },
    extraction: { id: headerEvidenceFixtureId(4 + seed), organization_id: headerEvidenceFixtureId(1), document_id: documentId, data: { extraction: { content_layers_v1: { source_kind: 'pdf', pdf } } } },
    artifact: { id: artifactId, organization_id: headerEvidenceFixtureId(1), source_document_id: documentId, source_sha256: 'a'.repeat(64) } };
  return { context, pdf, page, layer, headerLabels, refs };
}
