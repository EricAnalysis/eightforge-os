/**
 * Stable, machine-readable citation strings for canonical intelligence.
 * Used in source_refs / comparisons — not shown as UI redesign; feeds audit/trace.
 */

export type ReconciliationScope = 'single_document' | 'cross_document';

/** Strict: evidence_v1 section signals and page/label anchors only (no text_preview inference). */
export function collectStrictContractRateGroundingRefs(
  sectionSignals: Record<string, unknown>,
): string[] {
  const refs: string[] = [];
  if (sectionSignals.rate_section_present === true) {
    refs.push('evidence_v1.section_signals.rate_section_present');
    const pages = Array.isArray(sectionSignals.rate_section_pages)
      ? (sectionSignals.rate_section_pages as unknown[]).filter((n): n is number => typeof n === 'number')
      : [];
    if (pages.length > 0) {
      refs.push(`evidence_v1.section_signals.rate_section_pages:${pages.join(',')}`);
    }
    const label =
      typeof sectionSignals.rate_section_label === 'string' && sectionSignals.rate_section_label.trim().length > 0
        ? sectionSignals.rate_section_label.trim()
        : null;
    if (label) {
      refs.push('evidence_v1.section_signals.rate_section_label');
    }
  }
  if (sectionSignals.unit_price_structure_present === true) {
    refs.push('evidence_v1.section_signals.unit_price_structure_present');
  }
  if (sectionSignals.time_and_materials_present === true) {
    refs.push('evidence_v1.section_signals.time_and_materials_present');
  }
  return refs;
}

/** Optional text-keyword inference — use only for facts transparency or risk/missing paths, not strict confirms. */
export function collectTextOnlyRateInferenceRef(includeTextInference: boolean): string[] {
  return includeTextInference ? ['inference:text_preview:rate_or_pricing_keywords'] : [];
}

export function collectContractStructuredFieldRefs(params: {
  contractorFromStructured: boolean;
  nteFromStructured: boolean;
}): { contractor: string[]; nte: string[] } {
  return {
    contractor: params.contractorFromStructured ? ['evidence_v1.structured_fields.contractor_name'] : [],
    nte: params.nteFromStructured ? ['evidence_v1.structured_fields.nte_amount'] : [],
  };
}

export function xrefPrimaryFact(factPath: string): string {
  return `xref:scope:primary_document:fact:${factPath}`;
}

export function xrefRelatedDocumentFact(documentId: string, factPath: string): string {
  return `xref:document:${documentId}:fact:${factPath}`;
}
