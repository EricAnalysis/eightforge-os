import type { RelatedDocInput } from '@/lib/documentIntelligence';
import type { EvidenceObject, ExtractionGap } from '@/lib/extraction/types';
import type {
  DetectedEntity,
  DocumentFamily,
  DocumentSummary,
  FlowTask,
  IntelligenceKeyFact,
  NormalizedDecision,
  SuggestedQuestion,
} from '@/lib/types/documentIntelligence';

export interface PipelineFact {
  id: string;
  key: string;
  label: string;
  value: unknown;
  display_value: string;
  confidence: number;
  evidence_refs: string[];
  gap_refs: string[];
  missing_source_context: string[];
  source_document_id: string;
  document_family: DocumentFamily;
  /** How evidence_refs were attached: primary grounding vs value-in-text fallback. */
  evidence_resolution?: 'primary' | 'value_fallback' | 'none';
}

export interface PipelineAuditNote {
  id: string;
  stage: 'extract' | 'normalize' | 'decision' | 'action' | 'audit';
  status: 'info' | 'warning' | 'critical';
  message: string;
  evidence_refs?: string[];
  fact_refs?: string[];
}

export interface PipelineNodeTrace {
  node: 'extract' | 'normalize' | 'decision' | 'action' | 'audit';
  status: 'completed' | 'failed';
  summary: string;
  gap_count: number;
  evidence_count?: number;
  fact_count?: number;
  decision_count?: number;
  action_count?: number;
  /** Sum of source_refs across decisions after normalization (citation breadth). */
  evidence_citation_count?: number;
}

export interface ExtractedNodeDocument {
  document_id: string;
  document_type: string | null;
  document_name: string;
  document_title: string | null;
  family: DocumentFamily;
  is_primary: boolean;
  extraction_data: Record<string, unknown> | null;
  typed_fields: Record<string, unknown>;
  structured_fields: Record<string, unknown>;
  section_signals: Record<string, unknown>;
  text_preview: string;
  evidence: EvidenceObject[];
  gaps: ExtractionGap[];
  confidence: number;
  content_layers: Record<string, unknown> | null;
  extracted_record: Record<string, unknown>;
}

export interface NormalizedNodeDocument extends ExtractedNodeDocument {
  facts: PipelineFact[];
  fact_map: Record<string, PipelineFact>;
}

export interface PipelineDecision extends NormalizedDecision {
  confidence: number;
  evidence_objects: EvidenceObject[];
  missing_source_context: string[];
}

export interface SkillExecutionInput {
  primaryDocument: NormalizedNodeDocument;
  relatedDocuments: NormalizedNodeDocument[];
  projectName: string | null;
  allEvidenceById: Map<string, EvidenceObject>;
}

export interface SkillExecutionOutput {
  decisions: PipelineDecision[];
  actions: FlowTask[];
  audit_notes: PipelineAuditNote[];
}

export interface DocumentFamilySkill {
  documentFamily: 'contract' | 'invoice' | 'ticket' | 'payment_recommendation';
  requiredFacts: string[];
  decisionRules: string[];
  actionGenerationRules: string[];
  evidenceExpectations: string[];
  reviewTriggers: string[];
  run(input: SkillExecutionInput): SkillExecutionOutput;
}

export interface ExtractNodeInput {
  documentId: string;
  documentType: string | null;
  documentName: string;
  documentTitle: string | null;
  projectName: string | null;
  extractionData: Record<string, unknown> | null;
  relatedDocs: RelatedDocInput[];
}

export interface ExtractNodeOutput {
  primaryDocument: ExtractedNodeDocument;
  relatedDocuments: ExtractedNodeDocument[];
  evidence: EvidenceObject[];
  gaps: ExtractionGap[];
  confidence: number;
}

export interface NormalizeNodeOutput {
  primaryDocument: NormalizedNodeDocument;
  relatedDocuments: NormalizedNodeDocument[];
  evidence: EvidenceObject[];
  gaps: ExtractionGap[];
  confidence: number;
  facts: Record<string, unknown>;
  extracted: Record<string, unknown>;
}

export interface DecisionNodeOutput extends NormalizeNodeOutput {
  skill: DocumentFamilySkill | null;
  decisions: PipelineDecision[];
  actions: FlowTask[];
  audit_notes: PipelineAuditNote[];
}

export interface ActionNodeOutput extends DecisionNodeOutput {
  decision_task_ids: Map<string, string[]>;
}

export interface AuditNodeOutput extends ActionNodeOutput {
  node_traces: PipelineNodeTrace[];
  summary: DocumentSummary;
  key_facts: IntelligenceKeyFact[];
  entities: DetectedEntity[];
  suggested_questions: SuggestedQuestion[];
}

export interface DocumentPipelineResult extends AuditNodeOutput {
  handled: boolean;
}
