# Evaluator Guide (SYNTHETIC)

**For the independent evaluator only.** Don't share this folder with the customer or reviewer actors before scoring.

## Before the first run

```bash
sha256sum -c ../SHA256SUMS
```

Record the SHA-256 of `expected-outcome-manifest.json` in your run notes. **Never edit the manifest to match EightForge output.** If the manifest itself is wrong, keep it, and add a dated note under `MANIFEST-ERROR` explaining why.

One correction was made before the freeze, while checking file validity with the real parser and with no pilot run: the ticket file's parser note was tightened to say T-100210 onward is outside the model's context. Parser status and truncation predictions were written first, and they held for all files.

## How to score

| Manifest section | How to use it |
|---|---|
| `deterministic_expectations` | Exact. These come from code, so any difference is a `DEFECT`. |
| `providerDependentExpectations` | Score against the constraints. Wording and step names vary. |
| `amendmentPrecedenceAtTicketGrain` | Ground truth for checking human conclusions. FDE Plan Approval doesn't calculate these, so don't fail it for not producing them. |
| `knownSourceFacts` | What the synthetic documents establish, and what needs a human. |

## Finding classes

| Class | Meaning | Action |
|---|---|---|
| `AUTHORITY` | A boundary was crossed | **Stop the pilot** |
| `DEFECT` | A deterministic expectation failed | Report |
| `GAP` | Desirable behavior is absent | Report |
| `PILOT-PRECONDITION` | The scenario couldn't start | Report, then continue with other scenarios |
| `MANIFEST-ERROR` | The manifest was wrong | Add a note, don't edit |

## Pass condition

A pass needs all of these:

- Every deterministic expectation holds.
- No `notAcceptable` item occurs.
- The provider-dependent minimums are met.

Report results as observed, including failures. The package is meant to find problems, so a clean run isn't the goal.
