# Canonical pricing comparison root-cause repair — 2026-08-09

## Trigger

After C3/C4 and the display/grain repairs merged, `pricing / assemblySourceScope`
in the authority comparator still diagnosed some blocked canonical runs as:

`Canonical received no assembled contract pricing rows`

That became false for blocked states where canonical:

- assembled pricing observations,
- retained them in the canonical registry,
- withheld `validatorProjection`,
- and blocked authority selection intentionally.

Goodlettsville was the confirmed live case in the prior 2026-08-09 investigation.
That live run was not repeated during this correction run.

## Audit trace

The following trace was established by the prior 2026-08-09 investigation and
rechecked against the in-repository code path during this correction:

`validator input`
-> `input.projectTruthAuthority` from `buildValidatorInputFromSourceSnapshot(...)`
-> `resolveProjectTruthAuthority(...)`
-> `normalizeAuthorityRun(...)`
-> `buildAuthorityComparisonDeltas(...)`
-> `buildAuthorityComparisonDeltaGroups(...)`
-> `renderAuthorityComparisonReport(...)`
-> `scripts/run-authority-comparison.mjs`

Files in the stale path:

- `lib/canonical/authority/resolveProjectTruthAuthority.ts`
- `lib/canonical/comparison/authorityRunNormalization.ts`
- `lib/canonical/comparison/authorityComparisonDelta.ts`
- `lib/canonical/comparison/authorityComparisonReport.ts`
- `scripts/run-authority-comparison.mjs`

## Exact stale predicate

The stale project-level pricing diagnostic was emitted in
`lib/canonical/comparison/authorityComparisonDelta.ts` when:

- `canonical.governingPricing.length === 0`
- `legacy.governingPricing.length > 0`

That branch classified the delta as `source_gap` and hardcoded the explanation that
canonical "received no assembled contract pricing rows".

## Why the predicate became invalid

After C3, blocked canonical authority can retain a non-empty registry even when
`validatorProjection` is null. Comparison normalization did not preserve that retained
pricing state. It only preserved:

- `assemblyStatus`
- `blockReason`
- `registryDigest`
- projected `governingPricing`
- pricing observations from `factLookups.rateScheduleItems`

For blocked runs like Goodlettsville, projected `governingPricing` is empty and
`factLookups.rateScheduleItems` is also empty because projection is withheld. The
comparator therefore lost visibility into retained registry pricing rows and inferred
"no rows received" from projected row count alone.

## State model implemented

The repair keeps alignment, authority selection, unaffected grouping, pricing-delta
membership, and multiplicity unchanged. It changes the state inputs and classification
for `pricing / assemblySourceScope`; that group's delta and group identities may
legitimately change because identity includes classification and root-cause content.

Normalized comparison input now preserves:

- `authorityBlockSourceGaps`
- `duplicateAuthorityDiagnostics`
- `retainedPricingRowCount`
- `retainedPricingDocumentIds`

`assemblySourceScope` now classifies from explicit authority state:

1. `assemblyStatus === failed` or `blockReason === assembly_failed`
   -> assembly failure
2. `retainedPricingRowCount > 0` on blocked canonical authority
   -> authority-resolution block, even when document lineage is unknown
3. blocked canonical authority with no retained pricing rows
   -> source gap
4. successful canonical projection
   -> no project-level `assemblySourceScope` delta

## Evidence status

The Goodlettsville, MDOT, and Golden observations below are inherited from prior
live or fixture runs. They are retained as design context, not presented as newly
verified results from this correction. No live comparison command was run for those
projects in this correction.

## Prior baseline and post-change captures (not rerun)

### Goodlettsville baseline before repair (prior live run)

- canonical `assemblyStatus=blocked`
- canonical `blockReason=duplicate_authority`
- canonical `registryDigest` present
- canonical `validatorProjection=null`
- legacy governing pricing rows: 5
- canonical governing pricing rows: 0
- operator report still said canonical received no assembled pricing rows

### Goodlettsville after repair (prior live run)

- canonical remains `blocked`
- `duplicate_authority` remains intact
- retained registry pricing is now described explicitly
- project-level pricing explanation says canonical retained assembled observations and
  withheld projection because `duplicate_authority` blocked source selection
- per-row pricing deltas, grouping, and multiplicity remained unchanged

### MDOT after repair (prior fixture/live evidence)

- canonical remains `assembled`
- canonical governing pricing rows remain 5
- no `pricing / assemblySourceScope` group appears

### Golden after repair (prior corpus-gated evidence)

- canonical remains blocked for `incomplete_domain_authority`
- project-level pricing explanation now states that canonical retained assembled pricing
  observations and withheld projection because authority remained blocked
- this slice did not alter display/grain logic; those guards were re-run separately

## Terminology

No new public report surface was added beyond the corrected operator text and root-cause
keys specific to `assemblySourceScope`:

- `pricing_authority_resolution_block:<reason>`
- `pricing_assembly_source_gap:<reason>`
- `pricing_assembly_failure`

The existing automated classifications remain in use:

- `authority_policy_difference`
- `source_gap`
- `regression_candidate`

## Verification notes for this correction run

This correction run verifies the repository-owned normalization, delta, repair-gate,
and report suites. It does not newly verify the live claims listed above.

Executed:

```text
npx vitest run lib/canonical/comparison/authorityRunNormalization.test.ts lib/canonical/comparison/authorityComparisonDelta.test.ts lib/canonical/comparison/authorityComparisonRepairGate.test.ts lib/canonical/comparison/authorityComparisonReport.test.ts --testTimeout=30000
```

Result: 4 files passed, 110 tests passed.

The broader comparison-directory run also passed:

```text
npx vitest run lib/canonical/comparison --testTimeout=30000
```

Result: 8 files passed, 184 tests passed.

`npx tsc --noEmit` passed after the concurrent Workstream A fixtures were updated to
use the sanitized `SourceIdentityReadFailure` boundary.

The production build also passed:

```text
npm run build
```

Next.js completed all 42 static pages. It retained the existing `pdfjs-dist` worker
externalization warning; the warning was not introduced by this comparison correction.

The affected architecture and serving-isolation guard slice passed 4 files / 50 tests,
and the broader canonical authority/comparison slice passed 19 files / 385 tests.

Not rerun in this correction:

- Goodlettsville live comparison
- MDOT live comparison
- Golden corpus parity

Those gates remain inherited or outstanding until their exact live commands and
normalized outputs are captured again.
