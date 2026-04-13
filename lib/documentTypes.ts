export const UPLOAD_DOCUMENT_TYPES = [
  'contract',
  'invoice',
  'report',
  'policy',
  'procedure',
  'specification',
  'transaction_data',
  'other',
] as const;

const DOCUMENT_TYPE_INPUT_RE = /^[a-z0-9_-]+$/;

const DOCUMENT_TYPE_ALIASES: Record<string, string> = {
  'payment rec': 'payment_recommendation',
  'payment recommendation': 'payment_recommendation',
  'transaction data': 'transaction_data',
  'ticket export': 'ticket',
};

export function normalizeDocumentTypeInput(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
  const aliased = DOCUMENT_TYPE_ALIASES[normalized] ?? normalized.replace(/\s+/g, '_');

  if (!DOCUMENT_TYPE_INPUT_RE.test(aliased)) {
    throw new Error('Document type must contain only letters, numbers, underscores, or hyphens.');
  }

  return aliased;
}
