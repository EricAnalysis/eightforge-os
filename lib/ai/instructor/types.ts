import type { ExtractionGap } from '@/lib/extraction/types';
import type {
  SupportedDocumentType,
  TypedExtraction,
} from '@/lib/types/extractionSchemas';
import type { DocumentFamily } from '@/lib/types/documentIntelligence';

export type InstructorAssistStatus = 'applied' | 'skipped' | 'failed';
export type InstructorAssistSource = 'deterministic' | 'instructor' | 'fallback';

export interface InstructorClassificationSnapshot {
  parser_version: 'instructor_classification_v1';
  status: InstructorAssistStatus;
  source: InstructorAssistSource;
  family: DocumentFamily;
  detected_document_type: string | null;
  confidence: number;
  reasons: string[];
  warnings: string[];
  attempts: number;
  model: string | null;
}

export interface InstructorExtractionAssistSnapshot {
  parser_version: 'instructor_extraction_assist_v1';
  status: InstructorAssistStatus;
  source: InstructorAssistSource;
  detected_document_type: SupportedDocumentType;
  confidence: number;
  trigger_reasons: string[];
  important_gaps: ExtractionGap[];
  typed_fields: TypedExtraction | null;
  merged_field_keys: string[];
  warnings: string[];
  attempts: number;
  model: string | null;
}

export interface InstructorAssistSnapshot {
  parser_version: 'instructor_ai_assist_v1';
  provider: 'openai_instructor';
  classification: InstructorClassificationSnapshot;
  extraction_assist?: InstructorExtractionAssistSnapshot;
}
