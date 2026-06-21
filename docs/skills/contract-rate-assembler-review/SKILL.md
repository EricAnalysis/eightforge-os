---
name: contract-rate-assembler-review
description: Audit EightForge Contract Rate Assembler results against a real source rate document and an operator-expected category/unit/rate table. Use for assembleContractPricingRows categorization reviews, taxonomy or display-label mismatches, route-recovery checks, duplicate derivations, validation-rule investigations, and approval-gated minimal fixes with file:line evidence.
---

# Contract Rate Assembler Review

Audit the production assembly path deeply before proposing a minimal fix. Separate analysis, authorization, implementation, and verification. Treat source evidence and operator expectations as distinct inputs; never make the expected table appear correct by silently changing extraction, provenance, or scope.

## Operating constraints

- Use PowerShell only.
- Never run an `npx` command. Give the exact command to the operator and wait for its output when an `npx` command is required.
- Preserve unrelated user changes. If overlapping dirty changes prevent reliable attribution, stop and report them.
- Cite findings with repository-relative `file:line` evidence. Cite commands and observed output for runtime claims.
- Preserve evidence anchors, row provenance, source identifiers, and deterministic ordering.
- Do not implement during Phase A. Do not combine Phase A and Phase B in one response.

## Mandatory gate

Make the first repository action:

```powershell
git status --short
git branch --show-current
```

Report both results. Continue only on the operator-approved branch, normally `main`. If on another branch, stop immediately; do not inspect further, edit files, or switch branches.

If the operator names prerequisite PRs or commits, confirm each is merged into the approved branch before continuing. Prefer `gh pr view <number> --json number,title,state,mergedAt,mergeCommit,baseRefName,url`, then verify the merge commit is reachable from the current branch when needed. If a prerequisite is missing, ambiguous, or targets another base, stop and report it.

## Inputs to establish

Record before auditing:

- source document path, page/table/anchor, and expected source row count;
- verified source rows, including description, unit, route/origin-destination, and rate;
- operator-expected category/unit/rate table;
- settled domain notes that must remain on record;
- named regression gates, protected fixtures, prerequisite changes, and excluded branches or features;
- approved branch and any environment-specific command restrictions.

Do not reopen settled domain choices unless repository evidence contradicts them. If it does, report the contradiction as a material-gap stop rather than silently revising the premise.

## Phase A: audit only

Keep Phase A read-only. Do not edit tracked or untracked files, add snapshots, generate fixtures, or create a repro file. Use an existing test/harness or a read-only inline repro. If the only available runner requires `npx`, provide the command for the operator to run and pause until the output is returned.

### 1. Trace the production path

Locate `assembleContractPricingRows()` and trace the real fixture from extraction/persistence into assembly. Confirm that the repro exercises production mappings and categorization rather than a hand-built approximation. Record the exact source table/anchor and row count.

### 2. Capture actual output verbatim

Report every assembled row in source order with:

- source description or stable row identifier;
- actual category value and, when distinct, its display label;
- actual normalized unit plus raw/source unit when relevant;
- actual numeric/display rate;
- evidence/provenance identifier sufficient to tie it back to the source.

Do not normalize the report into the expected answer. Preserve the exact values produced by the code.

### 3. Produce a row-by-row diff

Compare expected versus actual category, unit, and rate independently. Mark each field `MATCH` or `MISMATCH`. Also report unexpected, missing, duplicated, or reordered rows.

### 4. Recursively deepen every mismatch

Do not stop at the first plausible explanation. Follow the value backward and test competing explanations until one root cause is supported and the others are excluded:

1. Check duplicate derivations or unmerged taxonomies.
2. Check canonical-key versus display-label or alias mapping.
3. Check route/lifecycle recovery, especially when identical verbs describe different legs.
4. Check validation and normalization rules.
5. Check whether extraction, column mapping, persistence, or recent prerequisite changes exposed a different problem.

For shared category labels, verify each source action independently; do not infer that one passing row proves all members of the category. For haul rows, use route/lifecycle evidence rather than the verb alone. Inspect every operator-named duplicate category pair and state whether its merge or alias exists now.

Known domain reference gap: `docs/domain/debris-material-lifecycle-model.md` does not currently exist in this repository; it was confirmed absent on `main` as of this reference copy. When or if that domain document lands, update this skill to reference it. Until then, remember that category labels may conflate material type and lifecycle stage or activity, so categorization audits should consider whether a mismatch is really a missing lifecycle-stage distinction rather than a simple miscategorization.

Classify each confirmed root cause as one of:

- duplicate derivation issue;
- mapping issue;
- route-recovery logic issue;
- validation rule issue;
- other, with a precise name.

Support the classification with file:line evidence for the producing rule, downstream mapping, and relevant tests. Distinguish observed facts from inference.

### 5. Assess blast radius

Identify whether a proposed fix could affect:

- named Golden Project/page/quantity gates;
- unit normalization and prior unit fixes;
- extraction, OCR, column mapping, or provenance;
- validator canonical keys and persisted historical values;
- deferred or conflicting branches explicitly excluded by the operator;
- unrelated taxonomies, categories, or contract families.

State why each protected area is touched or not touched. Use aliases rather than deleting established canonical keys when backward compatibility is required.

### 6. Propose the minimal diff

Name the smallest files and rules that would change, the tests to add or update, compatibility behavior, and explicit non-goals. Do not write the patch. Avoid speculative cleanup, taxonomy redesign, or adjacent refactors.

## Phase A stop conditions

Stop and issue a standalone Phase A report without proposing a scope-narrowed fix when any of these occurs:

- the branch or prerequisite merge gate fails;
- actual row count differs, including a missing, duplicate, or reappearing row;
- descriptions, units, rates, provenance, or column mapping differ materially from the verified source premise;
- the mismatch pattern is materially different from the operator-described categorization problem;
- the evidence supports a different root cause or requires broader/narrower scope than requested;
- production behavior cannot be reproduced without changing repository state;
- overlapping worktree changes make attribution unsafe;
- required evidence is unavailable or contradictory.

Explain the newly discovered gap and its likely scope. Do not silently reinterpret the task, continue with a partial categorization fix, or broaden implementation.

## Approval gate

End Phase A with:

- branch and prerequisite status;
- exact actual-output table;
- row-by-row diff;
- root-cause classification and file:line evidence;
- recursive-deepening conclusions;
- risk assessment;
- minimal-diff proposal and non-goals;
- an explicit statement that no files were changed.

Then stop. Require unambiguous operator approval of the identified root cause and proposed scope before Phase B. Questions, acknowledgements, or approval of a different scope do not authorize implementation.

## Phase B: implement after approval

Reconfirm branch and worktree state before editing. Implement only the approved minimal diff.

- Do not touch protected page gates, fixtures, extraction, or provenance unless explicitly approved.
- Preserve old canonical keys through aliases when compatibility is required; do not delete them casually.
- Add focused regression coverage for the real rows and exact expected category/unit/rate outputs.
- Stop and report before editing further if implementation reveals a different root cause, requires scope expansion, or conflicts with concurrent changes.

Use `apply_patch` for manual edits. Do not run `npx`.

## Phase C: verify and accept

Verify in this order:

1. Re-run the real fixture and show that every expected row matches category, unit, and rate exactly.
2. Run focused assembler, categorization, extraction, and validator tests named by the task.
3. Run protected Golden Project/regression gates.
4. Run lint and TypeScript/build checks.
5. Inspect the final diff for scope, provenance preservation, compatibility, and unrelated changes.

Run non-`npx` commands directly when safe. For every required `npx` command, give the exact PowerShell command to the operator and wait for the returned output; never claim it passed without evidence.

If live-application verification requires operator credentials that are unavailable in the current environment, such as Supabase authentication returning `401`, treat this as an acceptable stop condition. Report `blocked-pending-credentials`, preserve the completed local verification evidence, and wait for operator action. Do not bypass authentication, weaken the verification claim, or substitute unauthenticated behavior for a credentialed check.

Report an acceptance checklist, commands and results, changed files, and remaining risks. If verification fails, stop with the failure evidence; do not weaken assertions, alter expected source truth, or expand scope without approval.
