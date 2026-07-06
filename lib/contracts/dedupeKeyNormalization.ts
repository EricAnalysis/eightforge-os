// Shared tail-normalization step for row-deduplication keys across the contract
// rate-schedule pipelines. This does NOT unify the 4 dedupe-key functions
// (rateKey, rateRecoveryKey in contractRateScheduleRows.ts; normalizedRowKey in
// exhibitARateTableRows.ts; dedupeKey in contractPricingAssembly.ts) into one
// function -- they operate on different row shapes at different pipeline stages
// (3 pre-convergence on raw ContractRateScheduleRow, 1 post-convergence on the
// fully OCR-corrected ContractPricingAssemblyRow) and forcing them into a single
// key would require unifying those two row shapes, which is out of scope. This
// extracts only the one piece of normalization logic that was byte-for-byte
// duplicated between normalizedRowKey's description field and the tail of
// normalizeDedupeText, so both delegate to one implementation instead of two.
export function collapseToAlphanumericTokens(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
