import {
  buildInvoiceLineToRateMap,
  loadProjectValidatorInput,
} from '@/lib/validator/projectValidator';
import {
  readRowString,
  rowIdentifier,
  type InvoiceLineRow,
  type RateScheduleItem,
} from '@/lib/validator/shared';

const INVOICE_LINE_ID_KEYS = ['id', 'invoice_line_id', 'line_id'] as const;

export type ManualRateLinkOption = {
  documentId: string;
  recordId: string;
  rateCode: string | null;
  description: string | null;
  unitType: string | null;
  rateAmount: number | null;
  canonicalCategory: string | null;
};

export type ManualRateLinkOptionsResult = {
  options: ManualRateLinkOption[];
  recommendedRecordId: string | null;
  activeManualLinkRecordId: string | null;
  invoiceLine: {
    documentId: string;
    subjectId: string;
    lineNumber: string | null;
    description: string | null;
    billingCode: string | null;
  };
};

export class ManualRateLinkOptionsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function canonicalInvoiceLineSubjectId(value: string): string {
  const typed = /^typed:(.+):invoice:line:(\d+)$/u.exec(value);
  return typed ? `fact:${typed[1]}:line:${typed[2]}` : value;
}

function lineSubjectId(line: InvoiceLineRow): string {
  return rowIdentifier(line, INVOICE_LINE_ID_KEYS, 'invoice_line');
}

function optionFromRateItem(item: RateScheduleItem): ManualRateLinkOption {
  return {
    documentId: item.source_document_id,
    recordId: item.record_id,
    rateCode: item.rate_code,
    description: item.description,
    unitType: item.unit_type,
    rateAmount: item.rate_amount,
    canonicalCategory: item.canonical_category ?? null,
  };
}

export async function loadManualRateLinkOptions(params: {
  projectId: string;
  organizationId: string;
  invoiceLineSubjectId: string;
}): Promise<ManualRateLinkOptionsResult> {
  const input = await loadProjectValidatorInput(params.projectId);
  if (input.project.organization_id !== params.organizationId) {
    throw new ManualRateLinkOptionsError('Project not found', 404);
  }

  const canonicalSubjectId = canonicalInvoiceLineSubjectId(params.invoiceLineSubjectId);
  const line = input.invoiceLines.find((candidate) =>
    canonicalInvoiceLineSubjectId(lineSubjectId(candidate)) === canonicalSubjectId,
  );
  if (!line) {
    throw new ManualRateLinkOptionsError('Invoice line not found in canonical project truth', 404);
  }

  const resolvedLineId = lineSubjectId(line);
  const automatedMatch = buildInvoiceLineToRateMap(
    [line],
    input.factLookups.rateScheduleItems,
  ).get(resolvedLineId) ?? null;
  const activeMatch = input.invoiceLineToRateMap.get(resolvedLineId) ?? null;
  const invoiceDocumentId = readRowString(line, ['source_document_id', 'document_id'])
    ?? /^fact:(.+):line:\d+$/u.exec(canonicalSubjectId)?.[1]
    ?? null;
  if (!invoiceDocumentId) {
    throw new ManualRateLinkOptionsError('Invoice line has no source document', 409);
  }

  const options = input.factLookups.rateScheduleItems
    .map(optionFromRateItem)
    .sort((left, right) =>
      (left.rateCode ?? '').localeCompare(right.rateCode ?? '', 'en-US')
      || (left.description ?? '').localeCompare(right.description ?? '', 'en-US')
      || left.recordId.localeCompare(right.recordId, 'en-US'),
    );

  return {
    options,
    recommendedRecordId: automatedMatch?.record_id ?? null,
    activeManualLinkRecordId:
      activeMatch?.match_source_kind === 'manual_link' ? activeMatch.record_id : null,
    invoiceLine: {
      documentId: invoiceDocumentId,
      subjectId: params.invoiceLineSubjectId,
      lineNumber: readRowString(line, ['line_number', 'line_no', 'item_number']),
      description: readRowString(line, ['description', 'item_description', 'service_description']),
      billingCode: readRowString(line, ['rate_code', 'line_code', 'billing_code', 'code']),
    },
  };
}

export function findManualRateLinkOption(
  result: ManualRateLinkOptionsResult,
  params: { documentId: string; recordId: string },
): ManualRateLinkOption | null {
  return result.options.find((option) =>
    option.documentId === params.documentId && option.recordId === params.recordId,
  ) ?? null;
}
