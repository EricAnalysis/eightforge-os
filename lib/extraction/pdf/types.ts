import type { ExtractionGap } from '@/lib/extraction/types';

export type ParsedPdfElementType =
  | 'title'
  | 'section_header'
  | 'narrative_text'
  | 'table'
  | 'list_item';

export interface UnstructuredElementMetadata {
  page_number?: number;
  parent_id?: string;
  category_depth?: number;
  text_as_html?: string;
  coordinates?: {
    points?: number[][];
    system?: {
      name?: string;
      layout_width?: number;
      layout_height?: number;
      orientation?: string;
    };
  };
  emphasized_text_contents?: string[];
  emphasized_text_tags?: string[];
  [key: string]: unknown;
}

export interface UnstructuredElement {
  type?: string;
  element_id?: string;
  text?: string;
  metadata?: UnstructuredElementMetadata;
  [key: string]: unknown;
}

export interface UnstructuredPartitionResult {
  provider: 'unstructured';
  status: 'available' | 'failed';
  api_url: string;
  strategy: string;
  elements: UnstructuredElement[];
  error?: string;
  response_status?: number;
}

export interface ParsedPdfCoordinates {
  points: Array<[number, number]>;
  system_name?: string;
  layout_width?: number;
  layout_height?: number;
  orientation?: string;
}

export interface ParsedPdfTableLinkage {
  matched_table_id?: string | null;
  text_as_html?: string | null;
  row_count_hint?: number | null;
  header_context?: string[];
}

export interface ParsedPdfElement {
  id: string;
  provider: 'unstructured';
  source_element_id: string;
  element_type: ParsedPdfElementType;
  raw_element_type: string;
  page_number: number | null;
  text: string;
  text_preview: string;
  section_label: string | null;
  parent_element_id: string | null;
  category_depth: number | null;
  table_linkage?: ParsedPdfTableLinkage;
  coordinates?: ParsedPdfCoordinates | null;
  metadata: Record<string, unknown>;
}

export interface ParsedElementsV1 {
  parser_version: 'parsed_elements_v1';
  source_kind: 'pdf';
  provider: 'unstructured';
  status: 'available' | 'failed';
  confidence: number;
  element_count: number;
  elements: ParsedPdfElement[];
  gaps: ExtractionGap[];
}
