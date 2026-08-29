import { hashCanonical } from '@/lib/extraction/domain/hash';

export const PDF_LAYOUT_OBSERVATION_VERSION = 'pdf_layout_observation_v1' as const;

declare const pdfLayoutObservationIdBrand: unique symbol;
export type PdfLayoutObservationId = string & Readonly<{
  [pdfLayoutObservationIdBrand]: true;
}>;

export type PdfLayoutObservationSourceMethod = 'pdfjs' | 'ocr_fallback';

export type PdfLayoutObservationIdentityContext = Readonly<{
  sourceDocumentId: string;
  sourceArtifactId: string;
}>;

export type PdfLayoutObservationIdentity = Readonly<{
  id: PdfLayoutObservationId;
  version: typeof PDF_LAYOUT_OBSERVATION_VERSION;
  parser: 'pdfjs_text_content' | 'tesseract_blocks';
  parser_observation_key: string;
  page_representation_digest: string;
}>;

export function pdfLayoutPageRepresentationDigest(value: unknown): string {
  return hashCanonical({
    version: PDF_LAYOUT_OBSERVATION_VERSION,
    ordered_parser_observations: value,
  });
}

export function createPdfLayoutObservationIdentity(params: {
  context: PdfLayoutObservationIdentityContext;
  physicalPageNumber: number;
  sourceMethod: PdfLayoutObservationSourceMethod;
  parser: PdfLayoutObservationIdentity['parser'];
  parserObservationKey: string;
  pageRepresentationDigest: string;
}): PdfLayoutObservationIdentity {
  const id = `pdf:layout-token:v1:${hashCanonical({
    version: PDF_LAYOUT_OBSERVATION_VERSION,
    source_document_id: params.context.sourceDocumentId,
    source_artifact_id: params.context.sourceArtifactId,
    physical_page_number: params.physicalPageNumber,
    artifact_local_index: params.physicalPageNumber - 1,
    source_method: params.sourceMethod,
    parser: params.parser,
    parser_observation_key: params.parserObservationKey,
    page_representation_digest: params.pageRepresentationDigest,
  })}` as PdfLayoutObservationId;
  return Object.freeze({
    id,
    version: PDF_LAYOUT_OBSERVATION_VERSION,
    parser: params.parser,
    parser_observation_key: params.parserObservationKey,
    page_representation_digest: params.pageRepresentationDigest,
  });
}
