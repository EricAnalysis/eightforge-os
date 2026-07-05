import type { RelatedDocInput } from '@/lib/documentIntelligence';

function normalizeType(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function isContractPricingSupportDocument(params: {
  documentType: string | null | undefined;
  relatedDocs?: readonly RelatedDocInput[] | null;
}): boolean {
  if (normalizeType(params.documentType) !== 'price_sheet') return false;

  return (params.relatedDocs ?? []).some((doc) => {
    const relatedType = normalizeType(doc.document_type);
    const relationshipType = normalizeType(doc.relationship_type);
    return relatedType === 'contract' && relationshipType === 'attached_to';
  });
}
