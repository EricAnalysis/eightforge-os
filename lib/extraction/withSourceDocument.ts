import type { EvidenceObject } from '@/lib/extraction/types';

/** Ensures every evidence object carries document id and metadata.source_document_id. */
export function withSourceDocument(
  evidence: EvidenceObject[],
  documentId: string,
  sourceExtractionPath?: string,
): EvidenceObject[] {
  return evidence.map((item) => {
    const source_document_id = item.source_document_id || documentId;
    const metadata: Record<string, unknown> = { ...(item.metadata ?? {}), source_document_id };
    if (sourceExtractionPath != null && metadata.source_extraction_path == null) {
      metadata.source_extraction_path = sourceExtractionPath;
    }
    return { ...item, source_document_id, metadata };
  });
}
