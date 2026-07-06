// Shared low-level text-cleanup primitives for the contract rate-schedule
// pipelines. This does NOT unify all normalization in the pipeline into one
// function -- normalizeOcrText/normalizedText/normalizeCategoryKey
// (contractPricingAssembly.ts), normalizeSearchText/normalizeUnit
// (contractRateScheduleRows.ts), and cleanText (exhibitARateTableRows.ts)
// each serve genuinely distinct purposes (structure-preserving OCR-ghost
// repair vs. free-text search/matching vs. category-key exact matching vs.
// display cleanup), confirmed by a full behavior audit, and are documented
// as intentionally separate at their own definitions. This file extracts
// only the two pieces of logic that were proven byte-for-byte duplicated
// across those functions.

// Shared by normalizeWhitespace in contractRateScheduleRows.ts and
// exhibitARateTableRows.ts, which were byte-identical one-line functions.
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Shared by the first replace() in normalizeOcrText (contractPricingAssembly.ts),
// normalizeSearchText (contractRateScheduleRows.ts), and cleanText
// (exhibitARateTableRows.ts), which all converted en/em dashes to an ASCII
// hyphen identically before doing their own, distinct further processing.
export function normalizeDashCharacters(value: string): string {
  return value.replace(/[–—]/g, '-');
}
