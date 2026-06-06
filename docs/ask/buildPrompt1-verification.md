# Build Prompt 1 Verification Report

Generated from:
- docs/ask/capabilityMatrix.md
- scripts/ask/phase3Diagnostic.ts
- scripts/ask/artifacts/phase3-diagnostic-log.json (2026-06-04T04:46:19.045Z)
- scripts/ask/artifacts/phase3-confirmed-gap-list.json (2026-06-04T04:46:19.060Z)
- lib/ask/upstreamGapDetector.ts
- lib/ask/canonicalReadGuard.ts

Reporting pass only: no matrix row, probe, selector, router, or Ask logic was edited.

## Section 1 - Failing Probe Split By Failure Type

| CM ID | Surface | Matrix Coverage Status | Observed Failure Type | Build Owner |
|---|---|---|---|---|
| CM-001 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-002 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-003 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-005 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-006 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-007 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-009 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-010 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-011 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-013 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-014 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-017 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-018 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-019 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-020 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-021 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-022 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-023 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-025 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-026 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-028 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-029 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-030 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-031 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-033 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-034 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-035 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-036 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-037 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-038 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-039 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-040 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-041 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-042 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-043 | Project | needs-selector | GENERIC | Build Prompt 2 |
| CM-049 | Portfolio | needs-selector | GENERIC | Build Prompt 2 |
| CM-053 | Portfolio | needs-selector | GENERIC | Build Prompt 2 |
| CM-054 | Portfolio | needs-selector | GENERIC | Build Prompt 2 |

Totals:
- GENERIC: 38
- GAP: 0 (of which: truth-exists 0 / source-absent 0)
- ERROR: 0
- TOTAL: 38

## Section 2 - Matrix Coverage Rollup

| Coverage Status | Count |
|---|---:|
| answerable-now | 4 |
| needs-selector | 38 |
| needs-upstream-fact | 9 |
| needs-communication-event | 3 |
| needs-AI | 2 |
| TOTAL | 56 |

## Section 3 - Cross-Check: Coverage Status vs Observed Failure Type

Zero mismatches found for mismatch types A-D. The matrix classifications are honest for the probed rows and the harness agrees with them.

| CM ID | Matrix Said | Harness Observed | Mismatch Type | Note |
|---|---|---|---|---|
| none | none | none | none | No Type A, B, C, or D mismatches found. |

Discrepancies Found: none for the requested mismatch classes.

## Section 4 - Gap-Count Reconciliation (75 gaps vs 38 probes)

| CM ID | Gap Count for this Probe | Distinct Root Causes | Same-Root Duplicates? |
|---|---:|---|---|
| CM-001 | 2 | canonical_field_absent: CM-001: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-001: response does not satisfy the matrix Evidence Requirement | No |
| CM-002 | 2 | canonical_field_absent: CM-002: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-002: response does not satisfy the matrix Evidence Requirement | No |
| CM-003 | 1 | evidence_anchor_missing: CM-003: response does not satisfy the matrix Evidence Requirement | No |
| CM-005 | 3 | canonical_field_absent: CM-005: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-005: response has neither a named source nor a surfaced upstream gap<br>evidence_anchor_missing: CM-005: response does not satisfy the matrix Evidence Requirement | No |
| CM-006 | 2 | canonical_field_absent: CM-006: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-006: response does not satisfy the matrix Evidence Requirement | No |
| CM-007 | 2 | canonical_field_absent: CM-007: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-007: response does not satisfy the matrix Evidence Requirement | No |
| CM-009 | 2 | canonical_field_absent: CM-009: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-009: response does not satisfy the matrix Evidence Requirement | No |
| CM-010 | 2 | canonical_field_absent: CM-010: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-010: response does not satisfy the matrix Evidence Requirement | No |
| CM-011 | 2 | canonical_field_absent: CM-011: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-011: response does not satisfy the matrix Evidence Requirement | No |
| CM-013 | 2 | canonical_field_absent: CM-013: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-013: response does not satisfy the matrix Evidence Requirement | No |
| CM-014 | 2 | canonical_field_absent: CM-014: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-014: response does not satisfy the matrix Evidence Requirement | No |
| CM-017 | 2 | canonical_field_absent: CM-017: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-017: response does not satisfy the matrix Evidence Requirement | No |
| CM-018 | 2 | canonical_field_absent: CM-018: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-018: response does not satisfy the matrix Evidence Requirement | No |
| CM-019 | 2 | canonical_field_absent: CM-019: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-019: response does not satisfy the matrix Evidence Requirement | No |
| CM-020 | 2 | canonical_field_absent: CM-020: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-020: response does not satisfy the matrix Evidence Requirement | No |
| CM-021 | 2 | canonical_field_absent: CM-021: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-021: response does not satisfy the matrix Evidence Requirement | No |
| CM-022 | 2 | canonical_field_absent: CM-022: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-022: response does not satisfy the matrix Evidence Requirement | No |
| CM-023 | 2 | canonical_field_absent: CM-023: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-023: response does not satisfy the matrix Evidence Requirement | No |
| CM-025 | 2 | canonical_field_absent: CM-025: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-025: response does not satisfy the matrix Evidence Requirement | No |
| CM-026 | 2 | canonical_field_absent: CM-026: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-026: response does not satisfy the matrix Evidence Requirement | No |
| CM-028 | 2 | canonical_field_absent: CM-028: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-028: response does not satisfy the matrix Evidence Requirement | No |
| CM-029 | 2 | canonical_field_absent: CM-029: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-029: response does not satisfy the matrix Evidence Requirement | No |
| CM-030 | 2 | canonical_field_absent: CM-030: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-030: response does not satisfy the matrix Evidence Requirement | No |
| CM-031 | 2 | canonical_field_absent: CM-031: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-031: response does not satisfy the matrix Evidence Requirement | No |
| CM-033 | 2 | canonical_field_absent: CM-033: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-033: response does not satisfy the matrix Evidence Requirement | No |
| CM-034 | 2 | canonical_field_absent: CM-034: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-034: response does not satisfy the matrix Evidence Requirement | No |
| CM-035 | 3 | canonical_field_absent: CM-035: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-035: response has neither a named source nor a surfaced upstream gap<br>evidence_anchor_missing: CM-035: response does not satisfy the matrix Evidence Requirement | No |
| CM-036 | 2 | canonical_field_absent: CM-036: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-036: response does not satisfy the matrix Evidence Requirement | No |
| CM-037 | 2 | canonical_field_absent: CM-037: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-037: response does not satisfy the matrix Evidence Requirement | No |
| CM-038 | 2 | canonical_field_absent: CM-038: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-038: response does not satisfy the matrix Evidence Requirement | No |
| CM-039 | 2 | canonical_field_absent: CM-039: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-039: response does not satisfy the matrix Evidence Requirement | No |
| CM-040 | 2 | canonical_field_absent: CM-040: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-040: response does not satisfy the matrix Evidence Requirement | No |
| CM-041 | 2 | canonical_field_absent: CM-041: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-041: response does not satisfy the matrix Evidence Requirement | No |
| CM-042 | 2 | canonical_field_absent: CM-042: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-042: response does not satisfy the matrix Evidence Requirement | No |
| CM-043 | 2 | canonical_field_absent: CM-043: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-043: response does not satisfy the matrix Evidence Requirement | No |
| CM-049 | 1 | canonical_field_absent: CM-049: response does not expose the matrix concept fields | No |
| CM-053 | 2 | canonical_field_absent: CM-053: response does not expose the matrix concept fields<br>evidence_anchor_missing: CM-053: response does not satisfy the matrix Evidence Requirement | No |
| CM-054 | 1 | evidence_anchor_missing: CM-054: response does not satisfy the matrix Evidence Requirement | No |

Decisive answer:
- Total gaps: 75
- Total failing probes: 38
- Extra gaps: 37
- The extra 37 gaps are distinct concerns emitted by probes failing different criteria/root causes, such as matrix concept fields missing separately from matrix evidence requirements not being met.
- Same-root double-counted gaps: none found

VERDICT: unit of work for Build Prompt 2 = 38 needs-selector PROBES, not the raw gap count.

## Section 5 - Boundary Integrity Checklist Result

| Checklist Box | Result | Evidence |
|---|---|---|
| Every Portfolio-surface row has Read Boundary = portfolio-safe-aggregate | PASS | Portfolio rows inspected: CM-049 (portfolio-safe-aggregate), CM-050 (portfolio-safe-aggregate), CM-051 (portfolio-safe-aggregate), CM-052 (portfolio-safe-aggregate), CM-053 (portfolio-safe-aggregate), CM-054 (portfolio-safe-aggregate), CM-055 (portfolio-safe-aggregate), CM-056 (portfolio-safe-aggregate) |
| No Portfolio row sources document-facts, evidence-anchors, or ticket rows | PASS | Portfolio canonical sources inspected: CM-049 (Portfolio-aggregate), CM-050 (Portfolio-aggregate), CM-051 (Portfolio-aggregate), CM-052 (Portfolio-aggregate), CM-053 (Portfolio-aggregate), CM-054 (Portfolio-aggregate), CM-055 (Portfolio-aggregate), CM-056 (Portfolio-aggregate) |
| Every "Both" row has TWO read paths - no single shared selector | PASS | No rows with Surface = Both exist in the matrix. |
| Every Category 9 row marked needs-communication-event or needs-AI | PASS | Category 9 rows treated as CM-044-CM-048: CM-044 (needs-communication-event), CM-045 (needs-communication-event), CM-046 (needs-communication-event), CM-047 (needs-AI), CM-048 (needs-AI) |
| Selector names follow convention (selectProjectXxx / selectPortfolioXxx) | PASS | All selector names were checked against the row Surface. |
| No Portfolio row would require project-deep reads to answer | PASS | Portfolio evidence requirements inspected for project-deep/document/ticket dependencies. |

Gating boundary result: PASS for all three gating boxes.
