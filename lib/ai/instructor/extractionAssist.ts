import type { InstructorLikeClient } from '@/lib/ai/instructor/client';
import { runStructuredOutput } from '@/lib/ai/instructor/client';
import { extractionAssistEnvelopeSchema } from '@/lib/ai/instructor/schemas';
import type { InstructorExtractionAssistSnapshot } from '@/lib/ai/instructor/types';
import type { ExtractionGap } from '@/lib/extraction/types';
import type {
  SupportedDocumentType,
  TypedExtraction,
} from '@/lib/types/extractionSchemas';

const IMPORTANT_GAP_CATEGORIES = new Set([
  'missing_pdf_text_layer',
  'pdf_layout_parse_failed',
  'plain_text_missing',
  'missing_text',
  'fallback_text_only',
  'table_structure_missing',
  'form_fields_missing',
  'unstructured_partition_failed',
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function boundedText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  const normalized = normalizeWhitespace(value);
  if (!normalized) return null;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized;
}

function isSupportedAssistType(value: string | null | undefined): value is SupportedDocumentType {
  return value === 'contract' || value === 'invoice' || value === 'report';
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

function meaningfulFieldCount(value: TypedExtraction | null | undefined): number {
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value)
    .filter(([key]) => key !== 'schema_type')
    .filter(([, fieldValue]) => hasMeaningfulValue(fieldValue))
    .length;
}

function importantGaps(gaps: ExtractionGap[]): ExtractionGap[] {
  return gaps.filter((gap) =>
    gap.severity === 'critical' || IMPORTANT_GAP_CATEGORIES.has(gap.category),
  );
}

function mergeTypedFields(
  existing: TypedExtraction | null,
  assisted: TypedExtraction,
): { typedFields: TypedExtraction; mergedKeys: string[] } {
  if (!existing || existing.schema_type !== assisted.schema_type) {
    return {
      typedFields: assisted,
      mergedKeys: Object.keys(assisted).filter((key) => key !== 'schema_type'),
    };
  }

  const existingRecord = existing as Record<string, unknown>;
  const assistedRecord = assisted as Record<string, unknown>;
  const mergedRecord: Record<string, unknown> = { ...existingRecord };
  const mergedKeys: string[] = [];

  for (const [key, value] of Object.entries(assistedRecord)) {
    if (key === 'schema_type') continue;
    if (hasMeaningfulValue(existingRecord[key])) continue;
    if (!hasMeaningfulValue(value)) continue;
    mergedRecord[key] = value;
    mergedKeys.push(key);
  }

  return {
    typedFields: mergedRecord as TypedExtraction,
    mergedKeys,
  };
}

function materializeTypedExtraction(value: typeof extractionAssistEnvelopeSchema['_output']['typed_fields']): TypedExtraction {
  switch (value.schema_type) {
    case 'contract':
      return {
        schema_type: 'contract',
        vendor_name: value.vendor_name ?? null,
        contract_date: value.contract_date ?? null,
        effective_date: value.effective_date ?? null,
        expiration_date: value.expiration_date ?? null,
        termination_clause: value.termination_clause ?? null,
        rate_table: value.rate_table ?? [],
        material_types: value.material_types ?? [],
        hauling_rates: value.hauling_rates ?? [],
        tipping_fees: value.tipping_fees ?? [],
        fema_reference: value.fema_reference ?? false,
        insurance_requirements: value.insurance_requirements ?? null,
        bonding_requirements: value.bonding_requirements ?? null,
      };
    case 'invoice':
      return {
        schema_type: 'invoice',
        invoice_number: value.invoice_number ?? null,
        invoice_status: value.invoice_status ?? null,
        invoice_date: value.invoice_date ?? null,
        period_start: value.period_start ?? null,
        period_end: value.period_end ?? null,
        period_through: value.period_through ?? null,
        vendor_name: value.vendor_name ?? null,
        client_name: value.client_name ?? null,
        line_items: (value.line_items ?? []).map((item) => ({
          ...item,
          line_code: item.line_code ?? null,
          line_description: item.line_description ?? null,
          quantity: item.quantity ?? null,
          unit: item.unit ?? null,
          unit_price: item.unit_price ?? null,
          line_total: item.line_total ?? null,
          billing_rate_key: item.billing_rate_key ?? null,
          description_match_key: item.description_match_key ?? null,
        })),
        line_item_count: value.line_item_count ?? null,
        subtotal_amount: value.subtotal_amount ?? null,
        total_amount: value.total_amount ?? null,
        current_amount_due: value.current_amount_due ?? value.total_amount ?? null,
        payment_terms: value.payment_terms ?? null,
        po_number: value.po_number ?? null,
      };
    case 'report':
      return {
        schema_type: 'report',
        report_type: value.report_type ?? null,
        reporting_period: value.reporting_period ?? null,
        findings: value.findings ?? [],
        metrics: value.metrics ?? null,
        compliance_status: value.compliance_status ?? null,
        author: value.author ?? null,
        date: value.date ?? null,
      };
  }
}

function buildPrompt(params: {
  detectedDocumentType: SupportedDocumentType;
  textPreview: string;
  currentTypedFields: TypedExtraction | null;
  importantGaps: ExtractionGap[];
  sectionLabels: string[];
  tableHeaders: string[];
  formLabels: string[];
}): string {
  return [
    `Extract only schema-valid ${params.detectedDocumentType} fields for EightForge.`,
    'Use the text preview and structured hints below.',
    'Only return fields that are actually supported by the provided evidence.',
    'Leave uncertain fields null or omit them.',
    'Do not include narrative commentary outside the schema.',
    '',
    `Document type: ${params.detectedDocumentType}`,
    `Current typed fields: ${JSON.stringify(params.currentTypedFields ?? null)}`,
    `Important gaps: ${params.importantGaps.map((gap) => `${gap.category}:${gap.message}`).join(' | ') || '(none)'}`,
    `Section labels: ${params.sectionLabels.join(' | ') || '(none)'}`,
    `Table headers: ${params.tableHeaders.join(' | ') || '(none)'}`,
    `Form labels: ${params.formLabels.join(' | ') || '(none)'}`,
    'Text preview:',
    params.textPreview,
  ].join('\n');
}

export function shouldRunExtractionAssist(params: {
  detectedDocumentType: string | null;
  currentTypedFields: TypedExtraction | null;
  extractionConfidence: number;
  gaps: ExtractionGap[];
  textPreview: string | null;
}): {
  run: boolean;
  triggerReasons: string[];
  importantGaps: ExtractionGap[];
} {
  const triggerReasons: string[] = [];
  const highPriorityGaps = importantGaps(params.gaps);

  if (!isSupportedAssistType(params.detectedDocumentType)) {
    return { run: false, triggerReasons, importantGaps: highPriorityGaps };
  }

  if (!boundedText(params.textPreview, 120)) {
    return { run: false, triggerReasons, importantGaps: highPriorityGaps };
  }

  const currentFieldCount = meaningfulFieldCount(params.currentTypedFields);
  if (params.extractionConfidence < 0.62) {
    triggerReasons.push(`low extraction confidence (${params.extractionConfidence.toFixed(2)})`);
  }
  if (highPriorityGaps.length > 0) {
    triggerReasons.push(`${highPriorityGaps.length} important extraction gap${highPriorityGaps.length === 1 ? '' : 's'}`);
  }
  if (currentFieldCount < 2) {
    triggerReasons.push('typed extraction is still sparse');
  }

  const run = triggerReasons.length > 0
    && (params.extractionConfidence < 0.62 || highPriorityGaps.length > 0)
    && currentFieldCount < 4;

  return {
    run,
    triggerReasons,
    importantGaps: highPriorityGaps,
  };
}

export async function maybeAssistTypedExtraction(params: {
  detectedDocumentType: string | null;
  currentTypedFields: TypedExtraction | null;
  extractionConfidence: number;
  gaps: ExtractionGap[];
  textPreview: string | null;
  sectionLabels?: string[];
  tableHeaders?: string[];
  formLabels?: string[];
  model?: string;
  client?: InstructorLikeClient | null;
  createClient?: () => InstructorLikeClient | null;
}): Promise<{ snapshot: InstructorExtractionAssistSnapshot | null; mergedTypedFields: TypedExtraction | null }> {
  const decision = shouldRunExtractionAssist({
    detectedDocumentType: params.detectedDocumentType,
    currentTypedFields: params.currentTypedFields,
    extractionConfidence: params.extractionConfidence,
    gaps: params.gaps,
    textPreview: params.textPreview,
  });

  if (!decision.run || !isSupportedAssistType(params.detectedDocumentType) || !params.textPreview) {
    return {
      snapshot: decision.triggerReasons.length > 0 && isSupportedAssistType(params.detectedDocumentType)
        ? {
            parser_version: 'instructor_extraction_assist_v1',
            status: 'skipped',
            source: 'fallback',
            detected_document_type: params.detectedDocumentType as SupportedDocumentType,
            confidence: 0,
            trigger_reasons: decision.triggerReasons,
            important_gaps: decision.importantGaps,
            typed_fields: null,
            merged_field_keys: [],
            warnings: ['Extraction assist was not necessary after trigger evaluation.'],
            attempts: 0,
            model: null,
          }
        : null,
      mergedTypedFields: params.currentTypedFields,
    };
  }

  const model = params.model ?? process.env.EIGHTFORGE_INSTRUCTOR_EXTRACTION_MODEL ?? 'gpt-4o-mini';
  const result = await runStructuredOutput({
    model,
    schema: extractionAssistEnvelopeSchema,
    schemaName: `Assist${params.detectedDocumentType[0].toUpperCase()}${params.detectedDocumentType.slice(1)}Extraction`,
    system:
      'Return only schema-valid structured extraction output. Never emit free text outside the schema.',
    user: buildPrompt({
      detectedDocumentType: params.detectedDocumentType,
      textPreview: boundedText(params.textPreview, 8000) ?? '',
      currentTypedFields: params.currentTypedFields,
      importantGaps: decision.importantGaps,
      sectionLabels: (params.sectionLabels ?? []).slice(0, 12).map((value) => boundedText(value, 120) ?? '').filter(Boolean),
      tableHeaders: (params.tableHeaders ?? []).slice(0, 12).map((value) => boundedText(value, 120) ?? '').filter(Boolean),
      formLabels: (params.formLabels ?? []).slice(0, 12).map((value) => boundedText(value, 120) ?? '').filter(Boolean),
    }),
    client: params.client,
    createClient: params.createClient,
  });

  if (result.status !== 'applied' || !result.data) {
    return {
      snapshot: {
        parser_version: 'instructor_extraction_assist_v1',
        status: result.status === 'skipped' ? 'skipped' : 'failed',
        source: 'fallback',
        detected_document_type: params.detectedDocumentType,
        confidence: 0,
        trigger_reasons: decision.triggerReasons,
        important_gaps: decision.importantGaps,
        typed_fields: null,
        merged_field_keys: [],
        warnings: result.warnings,
        attempts: result.attempts,
        model: result.model,
      },
      mergedTypedFields: params.currentTypedFields,
    };
  }

  const assistedFields = materializeTypedExtraction(result.data.typed_fields);
  if (assistedFields.schema_type !== params.detectedDocumentType) {
    return {
      snapshot: {
        parser_version: 'instructor_extraction_assist_v1',
        status: 'failed',
        source: 'fallback',
        detected_document_type: params.detectedDocumentType,
        confidence: 0,
        trigger_reasons: decision.triggerReasons,
        important_gaps: decision.importantGaps,
        typed_fields: null,
        merged_field_keys: [],
        warnings: [
          ...result.warnings,
          `Instructor returned schema_type "${assistedFields.schema_type}" for "${params.detectedDocumentType}".`,
        ],
        attempts: result.attempts,
        model: result.model,
      },
      mergedTypedFields: params.currentTypedFields,
    };
  }

  const merged = mergeTypedFields(params.currentTypedFields, assistedFields);
  return {
    snapshot: {
      parser_version: 'instructor_extraction_assist_v1',
      status: 'applied',
      source: 'instructor',
      detected_document_type: params.detectedDocumentType,
      confidence: result.data.confidence,
      trigger_reasons: decision.triggerReasons.length > 0 ? decision.triggerReasons : (result.data.reasons ?? []),
      important_gaps: decision.importantGaps,
      typed_fields: assistedFields,
      merged_field_keys: merged.mergedKeys,
      warnings: result.warnings,
      attempts: result.attempts,
      model: result.model,
    },
    mergedTypedFields: merged.typedFields,
  };
}
