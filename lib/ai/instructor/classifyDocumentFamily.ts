import type { InstructorClassificationSnapshot } from '@/lib/ai/instructor/types';
import { runStructuredOutput, type InstructorLikeClient } from '@/lib/ai/instructor/client';
import { instructorClassificationSchema } from '@/lib/ai/instructor/schemas';
import type { DocumentFamily } from '@/lib/types/documentIntelligence';

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

function isPdfLike(fileName: string, mimeType: string | null | undefined): boolean {
  return fileName.toLowerCase().endsWith('.pdf') || mimeType === 'application/pdf';
}

function labelForFamily(family: DocumentFamily): string {
  switch (family) {
    case 'contract':
      return 'Contract / rate doc';
    case 'invoice':
      return 'Invoice';
    case 'payment_recommendation':
      return 'Payment recommendation';
    case 'ticket':
      return 'Ticket / export';
    case 'spreadsheet':
      return 'Spreadsheet';
    case 'operational':
      return 'Operational document';
    default:
      return 'Document';
  }
}

function mapDocumentTypeToFamily(documentType: string | null | undefined): DocumentFamily | null {
  const normalized = (documentType ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('contract')) return 'contract';
  if (normalized.includes('invoice')) return 'invoice';
  if (normalized.includes('payment_rec') || normalized.includes('payment recommendation')) {
    return 'payment_recommendation';
  }
  if (normalized.includes('ticket')) return 'ticket';
  if (normalized.includes('transaction_data') || normalized.includes('transaction data')) {
    return 'spreadsheet';
  }
  if (normalized.includes('spreadsheet') || normalized.includes('xlsx') || normalized.includes('xls')) {
    return 'spreadsheet';
  }
  if (normalized.includes('report') || normalized.includes('permit') || normalized.includes('ops') || normalized.includes('checklist')) {
    return 'operational';
  }
  if (normalized.includes('generic')) return 'generic';
  return null;
}

function deterministicClassification(params: {
  documentType: string | null;
  fileName: string;
  title: string | null;
  mimeType: string | null;
  textPreview: string | null;
  tableHeaders: string[];
  sectionLabels: string[];
}): InstructorClassificationSnapshot {
  const typeFamily = mapDocumentTypeToFamily(params.documentType);
  if (typeFamily) {
    return {
      parser_version: 'instructor_classification_v1',
      status: 'skipped',
      source: 'deterministic',
      family: typeFamily,
      detected_document_type: params.documentType,
      confidence: 0.98,
      reasons: [`Existing document type "${params.documentType}" is already specific enough for routing.`],
      warnings: [],
      attempts: 0,
      model: null,
    };
  }

  const haystack = normalizeWhitespace([
    params.fileName,
    params.title ?? '',
    params.textPreview ?? '',
    ...params.sectionLabels,
    ...params.tableHeaders,
  ].join(' ')).toLowerCase();
  const ext = params.fileName.toLowerCase();
  const reasons: string[] = [];

  if (ext.endsWith('.xlsx') || ext.endsWith('.xls') || ext.endsWith('.csv')) {
    reasons.push('Spreadsheet file extension detected.');
    if (haystack.includes('ticket')) {
      return {
        parser_version: 'instructor_classification_v1',
        status: 'skipped',
        source: 'deterministic',
        family: 'ticket',
        detected_document_type: 'ticket',
        confidence: 0.93,
        reasons: [...reasons, 'Ticket keyword present in filename or extracted content.'],
        warnings: [],
        attempts: 0,
        model: null,
      };
    }
    return {
      parser_version: 'instructor_classification_v1',
      status: 'skipped',
      source: 'deterministic',
      family: 'spreadsheet',
      detected_document_type: 'spreadsheet',
      confidence: 0.92,
      reasons,
      warnings: [],
      attempts: 0,
      model: null,
    };
  }

  if (haystack.includes('payment recommendation') || haystack.includes('payment rec')) {
    return {
      parser_version: 'instructor_classification_v1',
      status: 'skipped',
      source: 'deterministic',
      family: 'payment_recommendation',
      detected_document_type: 'payment_recommendation',
      confidence: 0.9,
      reasons: ['Payment recommendation wording detected in filename or extracted content.'],
      warnings: [],
      attempts: 0,
      model: null,
    };
  }

  if (haystack.includes('invoice') || haystack.includes('pay app') || haystack.includes('application for payment')) {
    return {
      parser_version: 'instructor_classification_v1',
      status: 'skipped',
      source: 'deterministic',
      family: 'invoice',
      detected_document_type: 'invoice',
      confidence: 0.88,
      reasons: ['Invoice-style wording detected in filename or extracted content.'],
      warnings: [],
      attempts: 0,
      model: null,
    };
  }

  if (
    haystack.includes('contract')
    || haystack.includes('agreement')
    || haystack.includes('rate schedule')
    || haystack.includes('unit rates')
    || haystack.includes('exhibit a')
  ) {
    return {
      parser_version: 'instructor_classification_v1',
      status: 'skipped',
      source: 'deterministic',
      family: 'contract',
      detected_document_type: 'contract',
      confidence: 0.87,
      reasons: ['Contract or rate-schedule wording detected in filename or extracted content.'],
      warnings: [],
      attempts: 0,
      model: null,
    };
  }

  if (haystack.includes('ticket')) {
    return {
      parser_version: 'instructor_classification_v1',
      status: 'skipped',
      source: 'deterministic',
      family: 'ticket',
      detected_document_type: 'ticket',
      confidence: 0.82,
      reasons: ['Ticket wording detected in filename or extracted content.'],
      warnings: [],
      attempts: 0,
      model: null,
    };
  }

  if (
    haystack.includes('daily report')
    || haystack.includes('weekly report')
    || haystack.includes('monitoring report')
    || haystack.includes('permit')
    || haystack.includes('checklist')
  ) {
    return {
      parser_version: 'instructor_classification_v1',
      status: 'skipped',
      source: 'deterministic',
      family: 'operational',
      detected_document_type: haystack.includes('report') ? 'report' : 'operational',
      confidence: 0.74,
      reasons: ['Operational/report wording detected in filename or extracted content.'],
      warnings: [],
      attempts: 0,
      model: null,
    };
  }

  if (isPdfLike(params.fileName, params.mimeType)) {
    reasons.push('PDF input with weak routing signals needs model-assisted classification.');
  } else {
    reasons.push('No strong deterministic family signal detected.');
  }

  return {
    parser_version: 'instructor_classification_v1',
    status: 'failed',
    source: 'fallback',
    family: 'generic',
    detected_document_type: null,
    confidence: 0.45,
    reasons,
    warnings: [],
    attempts: 0,
    model: null,
  };
}

function buildClassificationPrompt(params: {
  fileName: string;
  title: string | null;
  mimeType: string | null;
  textPreview: string | null;
  tableHeaders: string[];
  sectionLabels: string[];
  deterministic: InstructorClassificationSnapshot;
}): string {
  return [
    'Classify the document family for EightForge.',
    'Return the family and a detected_document_type that best fits the existing pipeline.',
    'Use only the supplied metadata and extracted evidence summary.',
    'Do not invent unsupported document types.',
    '',
    `Filename: ${params.fileName}`,
    `Title: ${params.title ?? '(none)'}`,
    `Mime type: ${params.mimeType ?? '(unknown)'}`,
    `Deterministic fallback: ${labelForFamily(params.deterministic.family)} (${params.deterministic.detected_document_type ?? 'none'})`,
    `Deterministic reasons: ${params.deterministic.reasons.join(' | ')}`,
    `Section labels: ${params.sectionLabels.join(' | ') || '(none)'}`,
    `Table headers: ${params.tableHeaders.join(' | ') || '(none)'}`,
    'Text preview:',
    params.textPreview ?? '(none)',
  ].join('\n');
}

export async function classifyDocumentFamily(params: {
  documentType: string | null;
  fileName: string;
  title: string | null;
  mimeType: string | null;
  textPreview: string | null;
  tableHeaders?: string[];
  sectionLabels?: string[];
  model?: string;
  client?: InstructorLikeClient | null;
  createClient?: () => InstructorLikeClient | null;
}): Promise<InstructorClassificationSnapshot> {
  const deterministic = deterministicClassification({
    documentType: params.documentType,
    fileName: params.fileName,
    title: params.title,
    mimeType: params.mimeType,
    textPreview: boundedText(params.textPreview, 6000),
    tableHeaders: (params.tableHeaders ?? []).slice(0, 10).map((value) => boundedText(value, 120) ?? '').filter(Boolean),
    sectionLabels: (params.sectionLabels ?? []).slice(0, 10).map((value) => boundedText(value, 120) ?? '').filter(Boolean),
  });

  if (deterministic.source === 'deterministic' && deterministic.confidence >= 0.82) {
    return deterministic;
  }

  const model = params.model ?? process.env.EIGHTFORGE_INSTRUCTOR_CLASSIFICATION_MODEL ?? 'gpt-4o-mini';
  const result = await runStructuredOutput({
    model,
    schema: instructorClassificationSchema,
    schemaName: 'DocumentFamilyClassification',
    system:
      'You classify operational documents into one of these families: contract, invoice, payment_recommendation, ticket, spreadsheet, operational, generic.',
    user: buildClassificationPrompt({
      fileName: params.fileName,
      title: params.title,
      mimeType: params.mimeType,
      textPreview: boundedText(params.textPreview, 6000),
      tableHeaders: (params.tableHeaders ?? []).slice(0, 10),
      sectionLabels: (params.sectionLabels ?? []).slice(0, 10),
      deterministic,
    }),
    client: params.client,
    createClient: params.createClient,
  });

  if (result.status !== 'applied' || !result.data) {
    return {
      ...deterministic,
      status: result.status === 'skipped' ? 'skipped' : 'failed',
      source: deterministic.family === 'generic' ? 'fallback' : deterministic.source,
      warnings: result.warnings,
      attempts: result.attempts,
      model: result.model,
    };
  }

  return {
    parser_version: 'instructor_classification_v1',
    status: 'applied',
    source: 'instructor',
    family: result.data.family,
    detected_document_type: result.data.detected_document_type,
    confidence: result.data.confidence,
    reasons: result.data.reasons ?? [],
    warnings: result.warnings,
    attempts: result.attempts,
    model: result.model,
  };
}
