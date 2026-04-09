import { withSourceDocument } from '@/lib/extraction/withSourceDocument';
import type { EvidenceObject, ExtractionGap } from '@/lib/extraction/types';
import type {
  ExtractNodeInput,
  ExtractNodeOutput,
  ExtractedNodeDocument,
} from '@/lib/pipeline/types';
import type { DocumentFamily } from '@/lib/types/documentIntelligence';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function detectedDocumentTypeFromExtraction(extractionData: Record<string, unknown> | null): string | null {
  const fields = asRecord(extractionData?.fields);
  const direct = fields?.detected_document_type;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();

  const extraction = asRecord(extractionData?.extraction);
  const aiAssist = asRecord(extraction?.ai_assist_v1);
  const classification = asRecord(aiAssist?.classification);
  const assisted = classification?.detected_document_type;
  return typeof assisted === 'string' && assisted.trim().length > 0 ? assisted.trim() : null;
}

function assistedFamilyFromExtraction(extractionData: Record<string, unknown> | null): DocumentFamily | null {
  const extraction = asRecord(extractionData?.extraction);
  const aiAssist = asRecord(extraction?.ai_assist_v1);
  const classification = asRecord(aiAssist?.classification);
  const family = classification?.family;
  switch (family) {
    case 'contract':
    case 'invoice':
    case 'payment_recommendation':
    case 'ticket':
    case 'spreadsheet':
    case 'operational':
    case 'generic':
      return family;
    default:
      return null;
  }
}

function inferFamily(
  documentType: string | null,
  contentLayers: Record<string, unknown> | null,
  extractionData: Record<string, unknown> | null,
): DocumentFamily {
  const normalizedType = (
    detectedDocumentTypeFromExtraction(extractionData)
    ?? documentType
    ?? ''
  ).toLowerCase();
  if (normalizedType.includes('transaction_data') || normalizedType.includes('transaction data')) {
    return 'spreadsheet';
  }
  const spreadsheet = asRecord(contentLayers?.spreadsheet);
  const detectedSheets = asRecord(spreadsheet?.detected_sheets);
  const sheets = asArray<Record<string, unknown>>(detectedSheets?.sheets);
  if (sheets.some((sheet) => sheet.classification === 'ticket_export')) {
    return 'ticket';
  }

  const assistedFamily = assistedFamilyFromExtraction(extractionData);
  if (assistedFamily) return assistedFamily;

  if (normalizedType.includes('payment_rec') || normalizedType.includes('payment_recommendation')) {
    return 'payment_recommendation';
  }
  if (normalizedType.includes('contract')) return 'contract';
  if (normalizedType.includes('invoice')) return 'invoice';
  if (normalizedType.includes('ticket')) return 'ticket';
  if (normalizedType.includes('spreadsheet') || normalizedType.includes('xlsx') || normalizedType.includes('xls')) {
    return 'spreadsheet';
  }
  return 'generic';
}

function parseEvidence(
  extractionData: Record<string, unknown> | null,
  contentLayers: Record<string, unknown> | null,
  documentId: string,
): EvidenceObject[] {
  const pdfLayer = asRecord(contentLayers?.pdf);
  const pdfEvidence = asArray<EvidenceObject>(pdfLayer?.evidence);
  const spreadsheetEvidence = asArray<EvidenceObject>(asRecord(contentLayers?.spreadsheet)?.evidence);
  const pdfText = asRecord(pdfLayer?.text);
  const pdfTextConfidence =
    typeof pdfText?.confidence === 'number'
      ? pdfText.confidence
      : (typeof pdfLayer?.confidence === 'number'
          ? pdfLayer.confidence as number
          : 0);
  const rehydratedPdfTextEvidence =
    pdfEvidence.length === 0
      ? asArray<Record<string, unknown>>(pdfText?.pages).flatMap((page, pageIndex) => {
          const pageNumber = typeof page.page_number === 'number' ? page.page_number : pageIndex + 1;
          return asArray<Record<string, unknown>>(page.plain_text_blocks).flatMap((block, blockIndex) => {
            const text = typeof block.text === 'string' ? block.text.trim() : '';
            if (!text) return [];
            const nearbyText =
              typeof block.nearby_text === 'string' && block.nearby_text.trim().length > 0
                ? block.nearby_text.trim()
                : undefined;
            return [{
              id:
                typeof block.id === 'string' && block.id.trim().length > 0
                  ? block.id
                  : `${documentId}:pdf:text:${pageNumber}:${blockIndex + 1}`,
              kind: 'text' as const,
              source_type: 'pdf' as const,
              source_document_id: documentId,
              description: `PDF text block on page ${pageNumber}`,
              text,
              location: {
                page: pageNumber,
                ...(nearbyText ? { nearby_text: nearbyText } : {}),
              },
              confidence: pdfTextConfidence,
              weak: pdfTextConfidence < 0.5,
              metadata: {
                source_document_id: documentId,
                source_extraction_path: 'pdf_content_layers',
                ...(typeof block.line_start === 'number' ? { line_start: block.line_start } : {}),
                ...(typeof block.line_end === 'number' ? { line_end: block.line_end } : {}),
              },
            } satisfies EvidenceObject];
          });
        })
      : [];
  if (pdfEvidence.length > 0 || rehydratedPdfTextEvidence.length > 0 || spreadsheetEvidence.length > 0) {
    return withSourceDocument(
      [...pdfEvidence, ...rehydratedPdfTextEvidence, ...spreadsheetEvidence] as EvidenceObject[],
      documentId,
    );
  }

  const extraction = asRecord(extractionData?.extraction);
  const evidenceV1 = asRecord(extraction?.evidence_v1);
  const pageText = asArray<Record<string, unknown>>(evidenceV1?.page_text);
  const legacy = pageText.map((page, index) => {
    const pageNum = typeof page.page_number === 'number' ? page.page_number : index + 1;
    return {
      id: `${documentId}:legacy:text:${pageNum}`,
      kind: 'text' as const,
      source_type: 'pdf' as const,
      source_document_id: documentId,
      description: `Legacy page text ${pageNum}`,
      text: typeof page.text === 'string' ? page.text : '',
      location: {
        page: pageNum,
      },
      confidence: 0.55,
      weak: true,
      metadata: {
        source_document_id: documentId,
        source_extraction_path: 'legacy_evidence_v1_page_text',
        ...(typeof (page as { source_method?: unknown }).source_method === 'string'
          ? { source_method: (page as { source_method: string }).source_method }
          : {}),
      },
    };
  });
  return legacy;
}

function parseGaps(contentLayers: Record<string, unknown> | null): ExtractionGap[] {
  const pdfGaps = asArray<ExtractionGap>(asRecord(contentLayers?.pdf)?.gaps);
  const spreadsheetGaps = asArray<ExtractionGap>(asRecord(contentLayers?.spreadsheet)?.gaps);
  return [...pdfGaps, ...spreadsheetGaps];
}

function parseConfidence(contentLayers: Record<string, unknown> | null): number {
  const pdfConfidence = asRecord(contentLayers?.pdf)?.confidence;
  if (typeof pdfConfidence === 'number') return pdfConfidence;
  const spreadsheetConfidence = asRecord(contentLayers?.spreadsheet)?.confidence;
  if (typeof spreadsheetConfidence === 'number') return spreadsheetConfidence;
  return 0;
}

function buildExtractedRecord(contentLayers: Record<string, unknown> | null): Record<string, unknown> {
  const pdf = asRecord(contentLayers?.pdf);
  if (pdf) {
    const text = asRecord(pdf.text);
    const tables = asRecord(pdf.tables);
    const forms = asRecord(pdf.forms);
    return {
      source_kind: 'pdf',
      text_page_count: text?.page_count ?? null,
      text_confidence: text?.confidence ?? null,
      table_count: asArray<unknown>(tables?.tables).length,
      form_field_count: asArray<unknown>(forms?.fields).length,
    };
  }

  const spreadsheet = asRecord(contentLayers?.spreadsheet);
  if (spreadsheet) {
    const workbook = asRecord(spreadsheet.workbook);
    const normalizedTicketExport = asRecord(spreadsheet.normalized_ticket_export);
    const normalizedTransactionData = asRecord(spreadsheet.normalized_transaction_data);
    const summary = asRecord(normalizedTicketExport?.summary);
    const rollups = asRecord(normalizedTransactionData?.rollups);
    const distinctInvoiceNumbers = asArray<string>(rollups?.distinct_invoice_numbers);
    return {
      source_kind: 'xlsx',
      sheet_count: workbook?.sheet_count ?? null,
      workbook_confidence: workbook?.confidence ?? null,
      ticket_row_count: summary?.row_count ?? null,
      missing_quantity_rows: summary?.missing_quantity_rows ?? null,
      missing_rate_rows: summary?.missing_rate_rows ?? null,
      transaction_row_count: normalizedTransactionData?.row_count ?? null,
      total_extended_cost: rollups?.total_extended_cost ?? null,
      distinct_invoice_number_count: distinctInvoiceNumbers.length,
    };
  }

  return {};
}

function buildDocument(params: {
  id: string;
  documentType: string | null;
  documentName: string;
  documentTitle: string | null;
  extractionData: Record<string, unknown> | null;
  isPrimary: boolean;
}): ExtractedNodeDocument {
  const extraction = asRecord(params.extractionData?.extraction);
  const contentLayers = asRecord(extraction?.content_layers_v1);
  const evidenceV1 = asRecord(extraction?.evidence_v1);
  const typedFields = asRecord(asRecord(params.extractionData?.fields)?.typed_fields) ?? {};
  const structuredFields = asRecord(evidenceV1?.structured_fields) ?? {};
  const sectionSignals = asRecord(evidenceV1?.section_signals) ?? {};
  const evidence = parseEvidence(params.extractionData, contentLayers, params.id);
  const gaps = parseGaps(contentLayers);
  const textPreview = typeof extraction?.text_preview === 'string' ? extraction.text_preview : '';
  const family = inferFamily(params.documentType, contentLayers, params.extractionData);

  return {
    document_id: params.id,
    document_type: params.documentType,
    document_name: params.documentName,
    document_title: params.documentTitle,
    family,
    is_primary: params.isPrimary,
    extraction_data: params.extractionData,
    typed_fields: typedFields,
    structured_fields: structuredFields,
    section_signals: sectionSignals,
    text_preview: textPreview,
    evidence,
    gaps: gaps.length > 0
      ? gaps
      : textPreview
        ? []
        : [{
            id: `gap:missing_context:${params.id}`,
            category: 'missing_context',
            severity: 'warning',
            message: 'No structured extraction content was available for this document.',
            source: 'pipeline',
          }],
    confidence: parseConfidence(contentLayers),
    content_layers: contentLayers,
    extracted_record: buildExtractedRecord(contentLayers),
  };
}

export function extractNode(input: ExtractNodeInput): ExtractNodeOutput {
  const primaryDocument = buildDocument({
    id: input.documentId,
    documentType: input.documentType,
    documentName: input.documentName,
    documentTitle: input.documentTitle,
    extractionData: input.extractionData,
    isPrimary: true,
  });
  const relatedDocuments = input.relatedDocs.map((document) =>
    buildDocument({
      id: document.id,
      documentType: document.document_type,
      documentName: document.name,
      documentTitle: document.title ?? null,
      extractionData: document.extraction,
      isPrimary: false,
    }),
  );

  const evidence = [
    ...primaryDocument.evidence,
    ...relatedDocuments.flatMap((document) => document.evidence),
  ];
  const gaps = [
    ...primaryDocument.gaps,
    ...relatedDocuments.flatMap((document) => document.gaps),
  ];
  const confidenceCandidates = [
    primaryDocument.confidence,
    ...relatedDocuments.map((document) => document.confidence),
  ].filter((value) => value > 0);

  return {
    primaryDocument,
    relatedDocuments,
    evidence,
    gaps,
    confidence: confidenceCandidates.length > 0
      ? Number((confidenceCandidates.reduce((sum, value) => sum + value, 0) / confidenceCandidates.length).toFixed(3))
      : 0,
  };
}
