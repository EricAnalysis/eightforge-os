# Precedence read failure during validation (2026-11-01)

**Finding: a real defect, fixed here. If the precedence read failed, validation carried
on as though the project had no contract, and saved that result.** The read was the only
source read in `loadValidatorSourceReads` whose failure was swallowed, and nothing was
logged. It dated from at least the squashed baseline (`f5a7839`, 2026-04-16).

Not checked: how often this happened. No production data was read.

## The path, before the fix

Line numbers are from `1e34179`.

1. `projectValidator.ts:3552-3565`: `catch {}` set families and relationships to empty.
   Every other read in that function throws.
2. `:1566`, `:1609-1618`: with no families, `contract_identity` and `pricing` were empty,
   while `familyDocumentIds.contract` still listed the contract.
3. `requiredSources.ts:22, 49-52`: `hasContract` reads only `contract_identity`, so
   `SOURCES_NO_CONTRACT` opened as critical.
4. Fact lookups (`projectValidator.ts:2952-2965`): contract and pricing facts are looked
   up by those empty lists, so `contractCeilingType` was null and contract-based rules
   stopped firing.
5. `triggerProjectValidation.ts:500`: the run was persisted like any other.

## What a saved run did

| Effect | Where | Evidence |
| --- | --- | --- |
| False critical `SOURCES_NO_CONTRACT`, project `BLOCKED` | `requiredSources.ts:49-77` | Test run before the fix |
| Real findings missing from the run, for example `FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED` | `rateBasedContractValidation.ts:295` | Test run before the fix |
| Those findings closed as "not observed" | `persistValidationRun.ts:488-533` | Code, plus `persistValidationRun.test.ts:1284, 1305`; not run end to end |
| Their execution items marked superseded | `syncExecutionItems.ts:600-628` | Code only |
| Duplicate and voided documents no longer excluded | `projectValidator.ts:683-716` | Test at the builder |
| Project status, approval snapshot and activity written from this result | `persistValidationRun.ts:1082, 1134-1155` | Code only |
| Later runs skipped as `unchanged` until an input changed or a run was forced | `triggerProjectValidation.ts:410-420, 648-660` | Code only |

**It failed closed, not open.** The critical finding blocked the project, so this gave a
false block rather than a false approval, unless `SOURCES_NO_CONTRACT` was disabled in
rule state. The harm was a wrong status that could persist, plus churn in finding and
execution-item history.

Other callers read the same way: `resolutionImpactPreview.ts:196`,
`manualRateLinkOptions.ts:72` and the shadow comparison. They now get the error too.

## The fix

The `try/catch` is gone, so this read throws like every other read in the function.

- The run stops before anything is persisted, and `triggerProjectValidation` logs it and
  returns `failed`. The last good result stands.
- A genuinely missing relationships table is still handled inside the loader.
- The project is simply not revalidated until a later trigger succeeds. Nothing retries
  automatically, and that is a deliberate trade: a stale good result over a saved false one.

Runs already saved from this failure are not repaired by this change. A later run does
that once something triggers one with changed inputs, or a forced run.

## Proof

`lib/validator/precedenceReadFailure.test.ts` runs the real read path, rule packs and
resolvers. The failure is real: the relationships query returns an error, which the real
loader throws. Only the database is a stand-in, and persistence is mocked to prove it is
never reached. Three of its tests fail without the fix.

`lib/validator`, `lib/canonical`, `lib/evaluation` and the affected server and boundary
tests pass with the fix, apart from `goldenTransactionFixtureManifest.test.ts`. That test
fails identically without the fix and in another checkout: the diff is only working-copy
line endings under `core.autocrlf=true`. No Golden count moved.

## Related, not changed

`isMissingRelationshipTable` (`server/documentPrecedence.ts:52-54`) treats any error whose
message mentions `document_relationships` as a missing table. A real error naming that
table would give precedence with no relationships, with no throw, so duplicates would not
be excluded. Narrowing it to `42P01` looks right, but was not tested here.
