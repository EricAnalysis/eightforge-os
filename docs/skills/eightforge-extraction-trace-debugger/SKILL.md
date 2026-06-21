---
name: eightforge-extraction-trace-debugger
description: >
  Trace EightForge document intelligence bugs from source document or spreadsheet through extraction, normalization, persistence, view model assembly, and UI rendering. Use for contract pricing assembly, rate schedule cleanup, invoice total extraction, transaction_data spreadsheet summaries, evidence anchors, OCR/table noise, missing rendered sections, and mismatches between Extraction, Evidence, Facts, and Validator surfaces.
---

# EightForge Extraction Trace Debugger

Use this as a bounded investigation role for document intelligence regressions. The goal is to find the first divergence between source truth, extracted artifacts, canonical assembly, and UI rendering.

## EightForge Guardrails

- Keep fixes minimal and local. Do not redesign pages, add tabs, or restructure workflows unless explicitly asked.
- Preserve one canonical truth layer. Do not create duplicate truth logic in UI, Decision Queue, extraction helpers, view models, validator adapters, or persistence helpers.
- Evidence anchoring is non-negotiable: findings, facts, decisions, and displayed operational claims must preserve source document/page/bbox/row/lineage where available.
- Maintain truth-to-action grammar: show what is wrong, what is at risk, what must be fixed first, and what happens next.
- Avoid dashboard theater. Prefer operationally necessary facts, risks, and actions over decorative summaries or vanity metrics.
- Do not treat Decision Queue as the resolver. It can frame and route work, but canonical facts, validator findings, and execution state remain authoritative in their own layers.
- Debugging does not finalize approval-impacting outcomes. Execution is the only place to finalize approval-impacting outcomes.

## Trace Flow

1. Pin the expected operator-visible output in concrete terms: source document, page/sheet/row, field or table row, and the exact surface that is wrong.
2. Map the pipeline in order:
   - source file or fixture
   - parser/extractor output
   - normalized document or dataset model
   - persisted extraction/facts/rows
   - view model assembly
   - UI component props and render conditions
   - validator or decision consumer, if downstream behavior is affected
3. Compare sibling surfaces that should agree. For example, Extraction tab vs Evidence tab vs Fact Ledger vs Validator blocker context.
4. Identify whether the defect is:
   - extraction missed or misread source data
   - normalization kept noisy OCR/table text
   - persistence stored the right data but UI reads the wrong shape
   - view model builds both raw and clean rows but the surface consumes the raw rows
   - render condition blocks a valid section
   - evidence anchor/page/row lineage is missing or misleading
5. Make the smallest fix at the first true divergence. If the defect is surface consumption of the wrong shape, fix the local consumer or view-model handoff before refactoring the pipeline. Do not add a new tab, bypass canonical assembly, or make shadow diagnostics authoritative.
6. Verify with the narrowest artifact-level test and, for UI changes, a targeted browser check when a dev server is already part of the task.

## Recurring EightForge Paths

- Contract pricing/rate schedule assembly: look for helpers that turn raw `rate_schedule_rows` into clean assembly rows, then verify every surface consumes the clean shape consistently.
- Invoice totals and line items: distinguish cover-sheet billed total, line totals, rates, quantities, and display-normalized contractor/vendor identity.
- Transaction data spreadsheets: verify dataset summary source, row counts, grouped aggregates, review buckets, and compact persisted rows before changing UI.
- Evidence anchors: preserve page, bbox, row, sheet, source label, and extraction version wherever available.
- OCR/source uncertainty: surface uncertainty honestly, keep source text inspectable, and avoid normalizing uncertain text into authoritative truth without evidence.

## Output

Return a concise trace:

- source expectation
- first divergence
- affected files/surfaces
- minimal fix made or recommended
- verification performed
- any remaining uncertainty about OCR/source quality
