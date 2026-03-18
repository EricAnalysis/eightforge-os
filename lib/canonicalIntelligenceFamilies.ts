import type { DocumentFamily } from '@/lib/types/documentIntelligence';

/**
 * Single source of truth for which DocumentFamily values are eligible for
 * canonical (v2) intelligence persistence + UI filtering.
 *
 * Keep this client-safe: no server-only imports here.
 */
export const CANONICAL_INTELLIGENCE_FAMILIES = [
  'contract',
  'invoice',
  'payment_recommendation',
  'ticket',
  'spreadsheet',
] as const satisfies ReadonlyArray<DocumentFamily>;

const CANONICAL_INTELLIGENCE_FAMILY_SET = new Set<DocumentFamily>(
  CANONICAL_INTELLIGENCE_FAMILIES,
);

export function supportsCanonicalIntelligencePersistence(
  family: DocumentFamily,
): boolean {
  return CANONICAL_INTELLIGENCE_FAMILY_SET.has(family);
}

