# Forgewing project intelligence

Status: implemented foundation. Recorded 2026-11-01. The Phase A audit behind it is
[forgewing-project-intelligence-phase-a-2026-11-01](../audits/forgewing-project-intelligence-phase-a-2026-11-01.md).
Direction lives in [forgewing.md](forgewing.md) and [forward-deployment.md](forward-deployment.md).

## The loop

```
question
  -> classifyOperatorIntent            what is being asked
  -> planProjectContext                what may be read (the rest is never read)
  -> readProjectIntelligenceSources    existing scoped loaders and resolvers
  -> assembleProjectContext            sections, records, omissions, digests
  -> assessProjectEvidence             what the evidence says (deterministic)
  -> deterministicRecommendation       the floor: always available, no provider
  -> Ask gates + guidance switch       may a model explain it?
  -> askOperatorGuidanceWithClaude     on Ask's model, Ask's budget
  -> acceptModelRecommendation         factual and authority validation
  -> OperatorRecommendation            to the operator
  -> deriveProductImprovementSignals   internal only, separate route
```

Roles: EightForge is the trusted world. This layer is retrieval and orchestration.
Claude reasons over what it is given. The operator decides.

## Components

Identifiers avoid the `Forgewing…` prefix because `importBoundaries` refuses it
outside `lib/forgewing`, and `lib/forgewing` may not read a database. Project Ask has
always lived on this side of that line, and this layer sits with it.

| Concept | Implementation |
| --- | --- |
| Intent and context plan | `lib/projectIntelligence/contextPlan.ts` |
| Unified project context (`ForgewingProjectContext`) | `lib/projectIntelligence/projectContext.ts`, read by `lib/server/projectIntelligenceRead.ts` |
| Evidence reading | `lib/projectIntelligence/evidenceAssessment.ts` |
| Operator recommendation | `lib/projectIntelligence/operatorRecommendation.ts`, validated in `lib/server/ai/operatorGuidance.ts` |
| Product signal (`ForgewingImprovementSignal`) | `lib/projectIntelligence/improvementSignal.ts`, read at `GET /api/internal/project-intelligence/signals` |
| Readiness plan | `lib/projectIntelligence/fdeReadiness.ts`, shown on the workflow review page |
| Entry point | `POST /api/projects/[id]/ask` with `mode: 'operator_guidance'`, optionally `findingId` |

## Intents and what they load

| Question | Intent | Sections |
| --- | --- | --- |
| What am I missing? | `whats_missing` | findings, documents, relationships, decisions |
| Do I need another document? | `need_document` | findings, documents, relationships, facts |
| Why is this flagged? | `why_flagged` | findings, facts, documents, relationships, reviewed truth |
| What should I do? | `what_to_do` | findings, documents, relationships, decisions, reviewed truth |

Project identity is always included. Anything else, such as a fact lookup, stays on
plain Ask. Asked from a finding, an unplaced question is about that finding.

A question that names tickets, transactions, loads, trucks, trailers, CYD, tonnage or
mileage also reads `transaction_context`, whatever its intent: the newest uploads'
persisted aggregates and the open ticket findings, never a transaction row or grouped
rollup. It goes by the question's words and not by the finding it was asked from.
Ticket-grain totals stay per upload and are never added across uploads.

## The reading

| Reading | Means | Leads with |
| --- | --- | --- |
| `source_missing` | No such document in the project | Upload or request |
| `source_present` | Present, read, linked; validation has not re-run since | Review, re-run validation |
| `source_present_unread` | Present, not read successfully | Review the document |
| `source_present_relationship_unresolved` | Present and read, but unlinked or authority unsettled | Link the document |
| `likely_system_issue` | Present, read, linked, validation current, still flagged | Report it |
| `not_a_source_gap` | The finding is not about an absent source | From the rule catalogue |
| `evidence_unavailable` | The records could not be read | Nothing is concluded |

These words are routing for one answer. They are not stored, and no rule reads them.

## Why a model cannot repeat Case Investigation's failure

Case Investigation stays parked. This path does not use its workflow, prompt or
budget, and it borrows only two pure helpers (citation refs and the invented-number
check). It avoids the two ways that workflow failed:

- **Ranking:** the model does not rank. It may only pick from the next steps the
  evidence reading already allows, so it cannot turn "already in the project" into
  "upload it".
- **Invented numbers:** an answer containing a number the context did not carry is
  dropped whole, and the operator gets the deterministic answer.

So those failures cost a better sentence, not a wrong answer. This has **not** been
proven against a live model, which is why the provider switch ships off.

## Keeping these separate

| Concern | Where | Value |
| --- | --- | --- |
| Provider token ceiling | `OPERATOR_GUIDANCE_MAX_OUTPUT_TOKENS` | 2,400 |
| Cost ceiling | `FORGEWING_PROJECT_ASK_DAILY_CAP` | Shared with Ask |
| Retrieval and context bounds | `PROJECT_CONTEXT_BOUNDS` | 24,000 characters sent |
| Formatting | Output schema | 4,000-character answer |
| Factual validation | `acceptModelRecommendation` | Citations, numbers, allowed step |
| Authority validation | `authorityClaimIn`, closed step list, no write path | Refused, never repaired |

## Authority

Forgewing may explain, retrieve, compare, diagnose, recommend, identify what is
missing and raise signals. It may not approve relationships, clear findings, change
truth, establish authority, activate mappings, change rules or severity, change
configuration or write code. Structurally: the pure layer has no database or provider
import, the read seam has no write call, a recommendation has no field that acts, and
the S4 guard derives this path as an AI surface that may not reach a human-authority
writer. The only writes are the budget reservation and content-free telemetry, as Ask.

## Data policy and tenancy

Same provider, model, content class and gates as Ask. The sections send what Ask
already sends (findings, documents, facts, decisions, reviewed truth) plus document
precedence metadata. Every read is bound to the actor's organization or to a project
already resolved through it, and a record from another project stops the request.
Telemetry holds closed vocabularies and counts, with no question, title, project or
organization. Signals hold codes and references only.

## Forward deployment

The seven questions stay the opening scaffold, unchanged, and no new provider call
is added. `buildFdeReadinessPlan` reads the persisted assessment and supplied-file
labels, then starts each step on the lowest plausible rung of the ladder, listing the
rungs to rule out first. Follow-ups come only from gaps the assessment recorded after
reading the intake and files, capped at six, and a likely-relevant file is named so a
person checks it before asking anyone. Everything stays non-authoritative and reviewed.

## Known gaps

- The live provider path is unexercised: no model has answered a qualification case. The v1
  attempt is void, and v2 is frozen and not yet run.
- Guidance answers and signals are stored as content-free rows
  (`project_intelligence_guidance_events`, `project_intelligence_signals`), read only by the
  platform-gated signals route. Cost is not stored: it is tokens at the price of the day.
- A signal's review is a disposition and goes no further. Taking an accepted signal into
  `improvement_signal_submissions` and triage is still a person's manual step, because that
  table holds organization-level patterns and one signal is one observation.
- Follow-up answers are stored beside the assessment and rebuild its readiness. They are not
  fed back into a new assessment run, so a revised assessment still needs a person to weigh them.
- The capability catalogue matches a step's wording. A match is a candidate for a reviewer,
  not proof the step is covered.
- The relationship reading uses document links and precedence, not the canonical
  relationship assembly, which needs a full truth run.
- Ticket context reads what the upload persisted, not the row-backed summary that
  `resolveCanonicalProjectTruthSections` prefers, because reading every row for one
  question is too heavy. An older upload can differ until it is reprocessed.
- A question asked from a ticket finding without ticket words reads no ticket data.
  That keeps every frozen qualification request unchanged. Widening it needs a new contract.
