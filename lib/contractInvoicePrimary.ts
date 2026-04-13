import type { DocumentFamily } from '@/lib/types/documentIntelligence';

const CONTRACT_INVOICE_PRIMARY_DOC_TYPES = new Set([
  'contract',
  'invoice',
  'williamson_contract',
]);

export function isContractInvoicePrimaryDocumentType(
  documentType: string | null | undefined,
): boolean {
  return CONTRACT_INVOICE_PRIMARY_DOC_TYPES.has((documentType ?? '').toLowerCase());
}

export function isContractInvoicePrimaryFamily(
  family: DocumentFamily | null | undefined,
): boolean {
  return family === 'contract' || family === 'invoice';
}
