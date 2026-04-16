/**
 * Central registry of known contract extraction failure modes.
 * Keep this file as the single source of truth for edge-case aliases and
 * regex patterns used by extraction, classification, debugging, and validation.
 */
export const CONTRACT_FAILURE_MODES = {
  // Signals that a table/section is likely a contract rate schedule.
  rateSchedules: {
    titleAliases: [
      /unit prices?/i,
      /unit rate price/i,
      /schedule of values/i,
      /\bSOV\b/i,
      /schedule of rates/i,
      /schedule of rates and prices/i,
      /contract price schedule/i,
      /price schedule/i,
      /price sheet/i,
      /pricing schedule/i,
      /unit rate price form/i,
      /item and place pricing/i,
      /compensation schedule/i,
      /emergency debris removal unit rates?/i,
      /time\s*(?:and|&)\s*materials(?:\s+rates?)?/i,
      /section\s+b\.?\s+(?:prices|costs)/i,
    ],
    headerSignals: [
      /unit price/i,
      /unit rate/i,
      /unit cost/i,
      /rate per/i,
      /price per unit/i,
      /price per/i,
      /scheduled value/i,
      /contract line item number/i,
      /\bCLIN\b/i,
      /\bqty\b/i,
      /quantity/i,
    ],
    structuralRules: [
      'has_description_quantity_price',
      'clin_with_money_column',
      'has_total_row',
    ],
  },

  // Unit-of-measure variations that commonly break table normalization.
  units: {
    headerAliases: [
      /uom/i,
      /unit(?: of measure)?/i,
      /measure/i,
      /meas\.?/i,
      /unit quantity/i,
      /qty/i,
    ],
    uomPatterns: [
      /\b(?:EA|LF|SF|CY|LS|HR|MO|DAY|LOT|TN|TON|LB|LBS)\b/i,
    ],
    inlinePatterns: [
      /@\s*\$?\d[\d,]*(?:\.\d+)?\s+per\s+\w+/i,
      /\$\s*[\d,]+(?:\.\d+)?\s*(?:per|\/)\s*[A-Za-z][A-Za-z .-]*/i,
    ],
  },

  // Term/date-of-performance language that appears in contracts and DOT-style scopes.
  term: {
    commencement: [
      /shall commence on/i,
      /commencing on/i,
      /effective date/i,
      /date hereof/i,
      /notice to proceed|NTP/i,
    ],
    duration: [
      /initial term/i,
      /for a period of/i,
      /\d+\s+(?:year|month|day)s?/i,
      /term of this (?:agreement|contract)/i,
    ],
    renewal: [
      /automatically renew/i,
      /automatically be extended/i,
      /renewal term/i,
      /additional (?:one|1)-year terms?/i,
      /successive (?:one|1)-year terms?/i,
    ],
    dotStyle: [
      /contract time/i,
      /period of performance/i,
      /delivery schedule/i,
      /\d+\s+(?:calendar|working)\s+days/i,
      /time and materials|t&m/i,
    ],
  },
} as const;
