# Forgewing project intelligence: Phase A audit (2026-11-01)

Read-only audit of `main` at `1e34179`, for the FDE Intake and unified project
intelligence phase. Scope: what exists, what can be reused, what is missing.

## Which gated path can serve operator answers

| Candidate | Verdict | Why |
| --- | --- | --- |
| `case_investigation` | **No** | Ceiling `disabled`, model-blocked and parked (log 49, 53, 55). The prompt, adapter and runner stay closed. |
| `project_ask` | **Yes** | Ceiling `enabled`, content class `text_excerpts`, its own model guard (`askModel.ts`, `claude-sonnet-4-6`), its own daily cap, durable reservation and telemetry ledger. Its stated purpose is answering an operator's question from project truth. |
| New `GatedWorkflow` | No | `reserve_forgewing_provider_call` and the telemetry ledger constrain workflow names, so it would need a migration and no new authority is needed. |

Two honest limits on that verdict:

1. Ask is `production_qualified` by declaration (commit 273f531), with no recorded
   provider call and no benchmark. Its contract `project_ask_v1` is a plain-text
   answer. A structured recommendation is a sibling request contract, so it gets its
   own fail-closed switch beneath the Ask gates. Merging it activates nothing.
2. Case Investigation failed on an invented number and on top-1 ranking. Reusing the
   same *kind* of task through Ask would be the same risk by another door unless
   those failure modes are removed structurally. So the model does not choose the
   evidence state or rank freely: deterministic code decides both, and the model
   explains. An answer that fails validation never reaches the operator; the
   deterministic recommendation does.

## What each path builds today

| Path | Builds | Reusable as |
| --- | --- | --- |
| Project Ask (`lib/ask/retrieval.ts`, `askProjectContext.ts`) | Facts, open findings, decisions, documents, execution summary, reviewed truth. Intent-driven, always loads execution summary and facts. `ValidatorFinding` drops `rule_id`. | Loaders (`loadValidatorFindings`, `loadProjectDocuments`, `loadDecisions`, `loadFactsByFieldKeys`) are private but correctly scoped. Export them; do not rewrite them. |
| Case investigation (`investigationContext.ts`, `caseInvestigationRunner.ts`) | Per-case slices with provenance, omissions and digests. Letter-ref citations, `unsupportedNumbers`. | The slice/omission/digest *pattern*, and the pure citation and number helpers by import. The runner and `caseInvestigation.ts` are source-pinned by frozen qualification manifests, so they are not edited. |
| Resolution queue (`resolutionQueueRead.ts`) | Derived cases, but reads extraction blobs. | Not used here: CLAUDE.md prefers canonical tables over large blobs, and project questions do not need page rows. |
| Precedence (`documentPrecedence.ts`, `server/documentPrecedence.ts`) | Families, governing document, roles, subtypes, relationships, duplicates. | The one source for "is it present, is it linked, who governs". Reused as is. |
| Rule catalogue (`ruleExplanations.ts`, `ruleActions.ts`) | Title, explanation, required action, fixed action vocabulary, per-finding routes. | The authority for explaining a finding and for action links. Reused as is. |
| Gap routing (`lib/ask/actionableGapResponse.ts`) | Deterministic "not answerable" routing with `AllowedNextAction`. | Different question (what Ask cannot answer). Left alone. |
| Improvement path (`frictionReport.ts`, `frictionSignalAllowlist.ts`, `improvementSignalSubmissions.ts`, `orchestratorTaxonomy.ts`) | Allowlisted, content-free signals. `resolveWorkflowPlatformReviewAccess` gates platform reviewers. | Allowlists, root-cause taxonomy and the access seam. A durable new signal kind needs a CHECK change, so a migration: deferred. |
| Workflow Assessment (`workflowAssessment.ts`, `workflowAssessmentReviewRead.ts`) | Seven-question intake, non-authoritative assessment with determinism gaps, unresolved assumptions and limitations, supporting-file contexts. | The scaffold and the input to a readiness plan. No prompt or schema change needed. |
| Telemetry (`forgewingProviderTelemetry.ts`) | Content-free provider-call ledger, fixed columns. | Provider metrics. Intent and section fields have no column; a durable record needs a migration, so they go to a content-free structured log for now. |

## Deterministically retrievable

Open findings with evidence, documents with processing state, precedence families
and governing document, relationships, duplicate dispositions, decisions, reviewed
truth, field-keyed facts. No retrieval gap requires a vector store, embeddings,
graph database or agent framework. **No true blocker.**

## Guards that constrain the design

- `forgewingGatesBoundaries`: only named files may spend budget. The Ask route is
  one. A new spender route would widen the list, so guidance runs inside the
  existing Ask route.
- `importBoundaries`: `lib/forgewing` may not read a database, and `Forgewing[A-Z]…`
  identifiers are refused outside the boundary. Ask already lives outside
  `lib/forgewing`, so the new layer does too, with neutral identifiers.
- `aiProviderReliabilityBoundaries`: `askProject.ts` is the listed non-Forgewing
  Claude caller, with budgeted request options. The new call lives there.
- `forgewingAuthorityWriterBoundaries`: derives AI surfaces from the import graph, so
  the new path is covered automatically and may not reach a human-authority writer.

## What is actually missing

1. A question-intent to context-section plan. Ask's retrieval has early returns, not
   a plan, and cannot say what it deliberately did not load.
2. A deterministic reading of "missing, present, present but unlinked, or likely
   ours". Nothing distinguishes these today.
3. A recommendation contract separating findings, next step, uncertainty and evidence.
4. A structurally separate product signal at question time.
5. A readiness view over an assessment, following the forward-deployment ladder.

## Observed, out of scope

`resolveDocumentTruthCategoryIds` appends the contract's own ids to `pricing`, and
`runRequiredSourcesRules` treats a non-empty `pricing` list as a pricing schedule.
With that resolver's output, `SOURCES_NO_RATE_SCHEDULE` looks unreachable whenever a
contract exists. Not changed here: it is Validator behaviour. Worth a separate check.
