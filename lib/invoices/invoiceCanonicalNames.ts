/**
 * Canonical display names and light inference for invoice contractor fields.
 * Shared by pipeline normalization and document intelligence UI.
 */

export function normalizeInvoiceContractorDisplay(name: string | null | undefined): string | null {
  if (name == null) return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  if (/\baftermath\s+disaster\s+recovery\b/i.test(trimmed)) {
    return 'Aftermath Disaster Recovery';
  }
  return trimmed;
}

/**
 * When structured vendor fields are empty, infer contractor from OCR/plain text
 * (e.g. header block above Bill To).
 */
export function inferInvoiceContractorFromPlainText(plain: string | null | undefined): string | null {
  if (plain == null || !plain.trim()) return null;
  if (/\baftermath\s+disaster\s+recovery\b/i.test(plain)) {
    return 'Aftermath Disaster Recovery';
  }
  return null;
}
