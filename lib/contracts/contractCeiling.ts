import type { ContractCeilingType } from '@/lib/contracts/types';

export const RATE_BASED_CEILING_EVIDENCE_REGEXES: readonly RegExp[] = [
  /\ball\s+rates?\s+in\s+exhibit\s+[a-z]\b[\s\S]{0,160}\bnot[-\s]+to[-\s]+exceed(?:\s+rates?)?\b/i,
  /\b(?:unit prices?|rates?|pricing table|price schedule|schedule(?:\s+of\s+rates)?|line items?)\b[\s\S]{0,120}\b(?:shall\s+be|are|is|will\s+be|deemed|considered)\b[\s\S]{0,80}\bnot[-\s]+to[-\s]+exceed\b/i,
  /\b(?:not[-\s]+to[-\s]+exceed|nte)\b[\s\S]{0,120}\b(?:unit prices?|rates?|pricing table|price schedule|schedule(?:\s+of\s+rates)?|line items?|exhibit\s+[a-z])\b/i,
  /\b(?:not[-\s]+to[-\s]+exceed|nte)\s+rates?\b/i,
];

function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function isRatePriceNoCeilingMachineClassification(
  value: string | null | undefined,
): boolean {
  return value === 'rate_price_no_ceiling';
}

export function hasRateBasedCeilingLanguage(text: string | null | undefined): boolean {
  const haystack = normalizeSearchText(text);
  if (!haystack) return false;
  return RATE_BASED_CEILING_EVIDENCE_REGEXES.some((regex) => regex.test(haystack));
}

export function classifyContractCeiling(params: {
  totalCeilingAmount?: number | null;
  machineClassification?: string | null;
  text?: string | null;
  rateSchedulePresent?: boolean;
}): ContractCeilingType {
  if (
    typeof params.totalCeilingAmount === 'number'
    && Number.isFinite(params.totalCeilingAmount)
  ) {
    return 'total';
  }

  if (isRatePriceNoCeilingMachineClassification(params.machineClassification)) {
    return 'rate_based';
  }

  const rateBasedLanguageDetected = hasRateBasedCeilingLanguage(params.text);
  if (rateBasedLanguageDetected && params.rateSchedulePresent !== false) {
    return 'rate_based';
  }

  return 'none';
}

export function contractCeilingDisplay(type: ContractCeilingType): string {
  switch (type) {
    case 'total':
      return 'Total contract ceiling stated';
    case 'rate_based':
      return 'Rate based ceiling per schedule';
    default:
      return 'No explicit ceiling';
  }
}

export function contractCeilingSummary(type: ContractCeilingType): string {
  switch (type) {
    case 'total':
      return 'Total contract ceiling stated';
    case 'rate_based':
      return 'No total ceiling stated; Exhibit A rates are not to exceed';
    default:
      return 'No explicit ceiling';
  }
}
