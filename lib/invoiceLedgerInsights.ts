import {
  shouldShowMissingEvidenceBadge,
} from '@/lib/documentIntelligenceViewModel';
import type { DocumentIntelligenceViewModel } from '@/lib/documentIntelligenceViewModel';
import type { ComparisonResult } from '@/lib/types/documentIntelligence';

export type LedgerInsightSignals = {
  needsReviewFactCount: number;
  missingInvoiceParties: boolean;
  conflictedFactCount: number;
  crossDocComparisonDebt: boolean;
  isInvoiceInsights: boolean;
};

function normalizeLedgerFieldKey(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Cross-document reconciliation: contract comparisons that are not clean matches are review debt.
 */
function comparisonRowNeedsReview(row: ComparisonResult): boolean {
  if (row.status === 'missing') return true;
  if (/\bcontract\b/i.test(row.check) && row.status !== 'match') return true;
  return false;
}

export function deriveLedgerInsightSignals(
  model: DocumentIntelligenceViewModel | null,
  comparisons?: readonly ComparisonResult[] | null,
): LedgerInsightSignals | null {
  if (!model) return null;

  const crossDocComparisonDebt = (comparisons ?? []).some(comparisonRowNeedsReview);

  const needsReview = model.facts.filter((fact) => {
    if (fact.reviewStatus && fact.reviewStatus !== 'needs_followup') return false;
    if (fact.reviewStatus === 'needs_followup') return true;
    return (
      fact.reviewState === 'derived' ||
      fact.reviewState === 'missing' ||
      fact.confidenceLabel === 'low' ||
      fact.confidenceLabel === 'none' ||
      shouldShowMissingEvidenceBadge(fact)
    );
  });
  const conflictedFacts = model.facts.filter((fact) => fact.reviewState === 'conflicted');
  const missingInvoiceParties =
    model.family === 'invoice'
    && (['contractor_name', 'client_name'].some((needle) => {
      const fact = model.facts.find((candidate) => normalizeLedgerFieldKey(candidate.fieldKey) === needle);
      if (!fact) return true;
      const text = fact.displayValue?.trim() ?? '';
      return text.length === 0 || text === 'Missing' || fact.displayValue === '[object Object]';
    }));

  const isInvoiceInsights = model.family === 'invoice';

  if (!isInvoiceInsights) {
    if (needsReview.length === 0 && conflictedFacts.length === 0 && !missingInvoiceParties && !crossDocComparisonDebt) {
      return null;
    }
  }

  return {
    needsReviewFactCount: needsReview.length,
    missingInvoiceParties,
    conflictedFactCount: conflictedFacts.length,
    crossDocComparisonDebt,
    isInvoiceInsights,
  };
}
