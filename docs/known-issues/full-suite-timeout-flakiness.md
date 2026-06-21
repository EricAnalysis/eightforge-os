# Full-Suite Timeout Flakiness

## Symptom

Under `npm run test:unit` full-suite execution, Vitest's 5-second per-test timeout can occasionally trip on tests that perform longer real PDF/OCR or document-persistence setup work.

The affected tests have passed reliably when run in isolation, with observed isolated wall-clock runtimes in the 7-14 second range for the PDF fallback file. The timeout behavior appears tied to full-suite parallelism, resource allocation, or cumulative PDF/OCR setup pressure rather than deterministic test failure.

## Confirmed Affected Tests

- `lib/pipeline/processDocument.test.ts`
- `lib/server/documentExtraction.pdfFallbackGate.test.ts`
- `lib/server/intelligencePersistence.invoice.test.ts`
- `lib/server/intelligencePersistence.support.test.ts`
- `lib/server/intelligencePersistence.transactionData.test.ts`

## Latest Full-Suite Rerun

On 2026-06-21, after documenting this issue, `npm run test:unit` was rerun once on `fix/vegetative-rate-classification-and-support-matching`.

The run completed in about 72 seconds and reproduced four 5-second timeout failures:

- `lib/pipeline/processDocument.test.ts` > `processDocument canonical persistence gating` > `keeps Williamson-style contract failures at extracted and blocks all downstream decisioning`
- `lib/server/intelligencePersistence.invoice.test.ts` > `generateAndPersistCanonicalIntelligence invoice persistence` > `writes canonical invoice rows from the shared extraction blob on the invoice path`
- `lib/server/intelligencePersistence.support.test.ts` > `generateAndPersistCanonicalIntelligence support persistence` > `writes canonical support rows for non-transaction support workbooks`
- `lib/server/intelligencePersistence.transactionData.test.ts` > `generateAndPersistCanonicalIntelligence transaction_data persistence` > `persists normalized transaction data after the pipeline normalize stage`

In that same full-suite rerun, `lib/server/documentExtraction.pdfFallbackGate.test.ts` passed, taking about 6.3 seconds for the file, with its `uses pdf_text when meaningful native page text blocks the weak fallback gate` case taking about 4.6 seconds.

## Not Caused By Vegetative Rate Classification Work

This flakiness was investigated during the `fix/vegetative-rate-classification-and-support-matching` branch review.

It is not caused by the vegetative rate classification or cross-document compatibility changes in:

- `lib/validator/rateTaxonomy.ts`
- `lib/validator/billingKeys.ts`
- `lib/contracts/contractPricingAssembly.ts`
- `lib/validator/rulePacks/crossDocumentRateVerification.ts`

Verification notes:

- The isolated PDF fallback test was rerun multiple times on the feature branch and did not reproduce the timeout.
- The same isolated test was rerun multiple times on `main` at `967cc3e` and also did not reproduce the timeout.
- The branch does not directly change `lib/server/documentExtraction.ts`.
- The relevant `documentExtraction.ts` PDF fallback gate path does not call the changed taxonomy or cross-document matching logic.
- The other recovered timeout tests do not directly import or exercise the changed taxonomy, billing key, pricing assembly, or cross-document verification modules.

## Recommended Future Fix

Handle this separately from the categorization PR by either:

- raising the per-test timeout for PDF/OCR-heavy test files specifically, such as through a Vitest config override or targeted per-file timeout, or
- investigating full-suite parallelism and resource allocation for PDF/OCR-heavy test execution.

This issue is not addressed in the categorization PR. It is documented here so reviewers can distinguish known full-suite timeout flakiness from regressions in the vegetative rate classification and cross-document support matching changes.
