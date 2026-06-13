import type { EvidenceObject } from '@/lib/extraction/types';
import type { ParsedPdfElement } from '@/lib/extraction/pdf/types';

const ELEMENT_CONFIDENCE: Record<ParsedPdfElement['element_type'], number> = {
  title: 0.89,
  section_header: 0.86,
  narrative_text: 0.76,
  table: 0.84,
  list_item: 0.78,
};

function uniqueHeaderContext(element: ParsedPdfElement): string[] | undefined {
  const headerContext = [
    element.section_label,
    ...(element.table_linkage?.header_context ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  if (headerContext.length === 0) return undefined;
  return [...new Set(headerContext)].slice(0, 4);
}

export function buildElementEvidence(params: {
  sourceDocumentId: string;
  elements: ParsedPdfElement[];
}): EvidenceObject[] {
  return params.elements.map((element) => {
    const confidence = ELEMENT_CONFIDENCE[element.element_type];
    const headerContext = uniqueHeaderContext(element);
    const isHeader = element.element_type === 'title' || element.element_type === 'section_header';

    return {
      id: element.id,
      kind: element.element_type === 'table' ? 'table' : 'text',
      source_type: 'pdf',
      source_document_id: params.sourceDocumentId,
      description:
        `Partitioned ${element.element_type.replace(/_/g, ' ')}`
        + (element.page_number != null ? ` on page ${element.page_number}` : ''),
      text: element.text,
      location: {
        ...(element.page_number != null ? { page: element.page_number } : {}),
        ...(element.section_label ? { section: element.section_label } : {}),
        ...(isHeader ? { label: element.text } : {}),
        ...(headerContext ? { header_context: headerContext } : {}),
      },
      confidence,
      weak: confidence < 0.65,
      metadata: {
        source_document_id: params.sourceDocumentId,
        source_extraction_path: 'pdf_unstructured_partition',
        element_type: element.element_type,
        raw_element_type: element.raw_element_type,
        source_element_id: element.source_element_id,
        text_preview: element.text_preview,
        section_label: element.section_label,
        parent_element_id: element.parent_element_id,
        category_depth: element.category_depth,
        linked_table_id: element.table_linkage?.matched_table_id ?? null,
        table_row_count_hint: element.table_linkage?.row_count_hint ?? null,
        table_html_present: Boolean(element.table_linkage?.text_as_html),
      },
    };
  });
}
