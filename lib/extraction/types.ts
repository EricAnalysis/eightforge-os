export type ExtractionGapSeverity = 'info' | 'warning' | 'critical';

export interface ExtractionGap {
  id: string;
  category: string;
  severity: ExtractionGapSeverity;
  message: string;
  source: 'pdf' | 'xlsx' | 'pipeline';
  page?: number;
  sheet?: string;
  row?: number;
  section?: string;
  label?: string;
  nearby_text?: string;
}

export interface EvidenceLocation {
  page?: number;
  sheet?: string;
  row?: number;
  column?: string;
  /** 0-based column index within the sheet header row when known. */
  column_index?: number;
  section?: string;
  label?: string;
  nearby_text?: string;
  header_context?: string[];
}

export type EvidenceValue = string | number | boolean | null;

/** Provenance for a single evidence span (required on every ingested object). */
export interface EvidenceSourceMetadata {
  /** Document row / upload this span was extracted from. */
  source_document_id: string;
  /** Parser path, e.g. pdf_text_layer, ocr, legacy_page_text, xlsx_workbook. */
  source_extraction_path?: string;
}

export interface EvidenceObject {
  id: string;
  kind:
    | 'text'
    | 'table'
    | 'table_row'
    | 'form_field'
    | 'sheet'
    | 'sheet_row'
    | 'sheet_cell';
  source_type: 'pdf' | 'xlsx';
  description: string;
  text?: string;
  value?: EvidenceValue;
  location: EvidenceLocation;
  confidence: number;
  weak: boolean;
  /** Always set at extraction ingest; also copied into metadata.source_document_id when metadata is present. */
  source_document_id: string;
  metadata?: Record<string, unknown>;
}
