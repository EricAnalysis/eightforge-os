import type { EvidenceObject, ExtractionGap } from '@/lib/extraction/types';
import type { PdfTextExtractionResult } from '@/lib/extraction/pdf/extractText';
import type { PdfTableExtractionResult } from '@/lib/extraction/pdf/extractTables';
import type { PdfFormExtractionResult } from '@/lib/extraction/pdf/extractForms';

export interface PdfEvidenceMapResult {
  evidence: EvidenceObject[];
  confidence: number;
  gaps: ExtractionGap[];
}

function uniqueGaps(gaps: ExtractionGap[]): ExtractionGap[] {
  const seen = new Set<string>();
  return gaps.filter((gap) => {
    const key = `${gap.category}:${gap.page ?? gap.sheet ?? 'global'}:${gap.row ?? '0'}:${gap.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildEvidenceMap(params: {
  sourceDocumentId: string;
  text: PdfTextExtractionResult;
  tables: PdfTableExtractionResult;
  forms: PdfFormExtractionResult;
}): PdfEvidenceMapResult {
  const docId = params.sourceDocumentId;
  const path = 'pdf_content_layers';
  const evidence: EvidenceObject[] = [];

  params.text.pages.forEach((page) => {
    page.plain_text_blocks.forEach((block) => {
      evidence.push({
        id: block.id,
        kind: 'text',
        source_type: 'pdf',
        source_document_id: docId,
        description: `PDF text block on page ${block.page_number}`,
        text: block.text,
        location: {
          page: block.page_number,
          nearby_text: block.nearby_text,
        },
        confidence: params.text.confidence,
        weak: params.text.confidence < 0.5,
        metadata: { source_document_id: docId, source_extraction_path: path },
      });
    });
  });

  params.tables.tables.forEach((table) => {
    evidence.push({
      id: table.id,
      kind: 'table',
      source_type: 'pdf',
      source_document_id: docId,
      description: `PDF table on page ${table.page_number}`,
      text: table.rows.map((row) => row.raw_text).join('\n'),
      location: {
        page: table.page_number,
        section: table.header_context[0],
        header_context: table.headers.length > 0 ? table.headers : table.header_context,
      },
      confidence: table.confidence,
      weak: table.confidence < 0.55,
      metadata: {
        source_document_id: docId,
        source_extraction_path: path,
        row_count: table.rows.length,
      },
    });

    table.rows.forEach((row) => {
      evidence.push({
        id: row.id,
        kind: 'table_row',
        source_type: 'pdf',
        source_document_id: docId,
        description: `PDF table row ${row.row_index} on page ${row.page_number}`,
        text: row.raw_text,
        location: {
          page: row.page_number,
          row: row.row_index,
          nearby_text: row.nearby_text,
          header_context: table.headers.length > 0 ? table.headers : table.header_context,
        },
        confidence: table.confidence,
        weak: table.confidence < 0.55,
        metadata: {
          source_document_id: docId,
          source_extraction_path: path,
          cells: row.cells.map((cell) => cell.text),
        },
      });
    });
  });

  params.forms.fields.forEach((field) => {
    evidence.push({
      id: field.id,
      kind: 'form_field',
      source_type: 'pdf',
      source_document_id: docId,
      description: `PDF form field "${field.label}" on page ${field.page_number}`,
      text: field.value,
      value: field.value,
      location: {
        page: field.page_number,
        label: field.label,
        nearby_text: field.nearby_text,
      },
      confidence: field.confidence,
      weak: field.confidence < 0.6,
      metadata: { source_document_id: docId, source_extraction_path: path },
    });
  });

  const contributingScores = [
    params.text.confidence,
    params.tables.confidence > 0 ? params.tables.confidence : undefined,
    params.forms.confidence > 0 ? params.forms.confidence : undefined,
  ].filter((score): score is number => typeof score === 'number' && score > 0);

  const confidence = contributingScores.length > 0
    ? Number((contributingScores.reduce((sum, score) => sum + score, 0) / contributingScores.length).toFixed(3))
    : 0;

  return {
    evidence,
    confidence,
    gaps: uniqueGaps([
      ...params.text.gaps,
      ...params.tables.gaps,
      ...params.forms.gaps,
    ]),
  };
}
