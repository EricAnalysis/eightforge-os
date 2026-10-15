# Forgewing production environment manifest

The single list of every setting that decides whether, where and how Forgewing
(EightForge's AI layer) may call a model in production. Secrets are named, never
shown. Related:
- [architecture](../architecture/forgewing.md)
- [recovery activation](forgewing-recovery-activation.md)
- [Engineering Worker](forgewing-engineering-worker.md)

## How a provider call is allowed

Every gate fails closed, and every switch is strict `=== '1'`. `true`, `yes`,
`on`, `0` and empty all mean off. A call happens only when **all** of these hold:

1. **Kill switch.** `FORGEWING_SHADOW_ENABLED=1`. This is the master switch;
   every other flag is AND-ed with it.
2. **Workflow switch.** The workflow's own `*_ENABLED=1`.
3. **Qualification ceiling (code, not env).** The workflow's policy ceiling must
   allow it. No env value can raise a ceiling.
4. **Qualified model (code, not env).** The resolved model must be in
   `FORGEWING_QUALIFIED_MODELS` (`lib/forgewing/runtime/modelConfig.ts`).
   Otherwise the result is `model_unqualified`.
5. **Organization entitlement.** The latest `organization_forgewing_entitlement_events`
   row for the org has `enabled=true`. No row means not entitled.
6. **Data policy.** The latest `organization_forgewing_data_policy_events` row
   has `approved=true` for every content class the request sends
   (`text_excerpts`, `page_region_images`). No row means denied.
7. **Durable budget.** The workflow's daily cap is `> 0` (default `0`, which
   means no calls), and `reserve_forgewing_provider_call` grants a slot.
8. **Provider credentials.** `ANTHROPIC_API_KEY` is set.

Steps 5-7 apply to every customer-content workflow: Project Ask, value
reading, case investigation and Workflow Assessment (S3). Extraction shadow and
recovery tasks check the kill switch, their switch and entitlement, and use an
in-request call budget (`FORGEWING_MAX_CALLS`).

## Kill switch, model and provider

| Variable | Default | Meaning |
|---|---|---|
| `FORGEWING_SHADOW_ENABLED` | off | Master kill switch for all Forgewing provider work, entitlement lookups included |
| `ANTHROPIC_API_KEY` | none | Secret. Without it every provider path is "not configured" |
| `FORGEWING_MODEL` | none (falls back to `ANTHROPIC_MODEL`, then `claude-sonnet-4-6`) | **Set it to `claude-sonnet-4-6`.** Any model not in `FORGEWING_QUALIFIED_MODELS` disables Forgewing (`model_unqualified`). It never silently inherits a Claude 5 shared model |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Shared model for Ask, the orchestrator and the extractor diagnostic, which use model-aware sampling. Not a Forgewing qualification |
| `ANTHROPIC_EXTRACTOR_MODEL` | `ANTHROPIC_MODEL` | Extractor diagnostic only |

`FORGEWING_QUALIFIED_MODELS` is `['claude-sonnet-4-6']`. It is widened only in
code, after a canonical qualification result explicitly qualifies another model
(for example the separate Sonnet 5.5 contracts, #232 and #235).

## Workflows

| Workflow | Switch | Daily cap (per org, trailing 24 h) | Ceiling (code) | Content class | Output |
|---|---|---|---|---|---|
| Project Ask | `FORGEWING_PROJECT_ASK_ENABLED` | `FORGEWING_PROJECT_ASK_DAILY_CAP` (0-500) | `enabled` | `text_excerpts` | Read-only explanation |
| Value reading | `FORGEWING_VALUE_READING_ENABLED` | `FORGEWING_VALUE_READING_DAILY_CAP` | **`disabled`**: B4.6 failed; B4.6.1 not qualified | `page_region_images` (+`text_excerpts`) | Immutable proposal; truth only via a human assertion |
| Case investigation | `FORGEWING_CASE_INVESTIGATION_ENABLED` | `FORGEWING_CASE_INVESTIGATION_DAILY_CAP` | **`disabled`**: no qualification yet | `text_excerpts` | Advisory |
| Workflow Assessment (S3, #237) | `FORGEWING_WORKFLOW_ASSESSMENT_ENABLED` | `FORGEWING_WORKFLOW_ASSESSMENT_DAILY_CAP` | `enabled` | `text_excerpts` | Non-authoritative assessment; human review |
| Plan V2 repository guidance | `FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED` | none (worker-hosted, job-bounded) | env | repository content, plus the step text of the human-reviewed workflow specification (platform-internal; no entitlement or data-policy gate) | Non-authoritative plan; human engineering review |
| Region classification | `FORGEWING_REGION_CLASSIFICATION_ENABLED` | in-request `FORGEWING_MAX_CALLS` | env | document text | Shadow artifact (TTL) |
| Table continuation | `FORGEWING_TABLE_CONTINUATION_ENABLED` | in-request | env | document text | Shadow artifact |
| Column mapping | `FORGEWING_COLUMN_MAPPING_ENABLED` | in-request | env | document text | Shadow artifact (never activates a mapping) |
| Observation arbitration | `FORGEWING_OBSERVATION_ARBITRATION_ENABLED` | in-request | env | document text | Shadow artifact |
| Pricing interpretation | `FORGEWING_PRICING_INTERPRETATION_ENABLED` | in-request | env | document text | Shadow artifact |
| Recovery V2: continuation attribution, header-role selection | `FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED` | in-request | **`controlled`** (`corpus_qualified`) | document text | Immutable proposal; human review, then a processing run |
| Recovery V2: multi-observation pricing cluster | `FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED` | in-request | **`disabled`** | — | — |
| Recovery V1: pricing rate cluster | `FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_ENABLED` | in-request | **`disabled`** | — | — |

## Bounds (tuning, never enablement)

| Variable | Default | Range |
|---|---|---|
| `FORGEWING_MAX_CALLS` | 1 | 1-4 per document run |
| `FORGEWING_TIMEOUT_MS` | 3000 | 100-8000 (shadow and recovery tasks) |
| `FORGEWING_MAX_OUTPUT_TOKENS` | 800 | 128-2000 |
| `FORGEWING_WORKFLOW_ASSESSMENT_TIMEOUT_MS` | 15000 | 1000-18000 (a three-attempt sweep fits the 60 s route) |
| `FORGEWING_WORKFLOW_ASSESSMENT_MAX_OUTPUT_TOKENS` | 4000 | 800-8000 |
| `FORGEWING_REPOSITORY_PLAN_TIMEOUT_MS` | 60000 | 1000-120000 |
| `FORGEWING_REPOSITORY_PLAN_MAX_OUTPUT_TOKENS` | 8000 | 1024-16000 |
| `FORGEWING_SHADOW_TTL_DAYS` | 5 | Shadow artifact retention (cleanup cron `17 3 * * *`) |

Out-of-range values fall back to the default and log a warning. Non-Forgewing
Claude calls use fixed bounds in `lib/server/ai/claudeRequestOptions.ts`
(S6): reserved calls get 45 s and no retry; internal diagnostics get 90 s and
one retry.

## Organization ledgers (database, not env)

Entitlement and data policy are append-only audited events. They are written by
an operator on a trusted connection, and no product code grants them.

```sql
-- Entitle an organization (Core + Forgewing).
INSERT INTO public.organization_forgewing_entitlement_events (organization_id, enabled, reason, recorded_by)
VALUES ('<org uuid>', true, '<contract / order reference>', '<auth.users id of the approver>');

-- Authorize a content class for a provider. Required per class.
INSERT INTO public.organization_forgewing_data_policy_events
  (organization_id, provider, content_class, approved, terms_reference, reason, recorded_by)
VALUES ('<org uuid>', 'anthropic', 'text_excerpts', true, '<DPA clause / agreement id>', '<why>', '<auth.users id>');
```

Revoke by inserting `enabled=false` or `approved=false`; the latest event wins.
Always record `recorded_by`.

## Hosts, crons and secrets

| Item | Where | Notes |
|---|---|---|
| `CRON_SECRET` | Vercel | Internal routes return 503 without it. Crons: shadow cleanup `17 3 * * *`, Workflow Assessment sweep `41 4 * * *` (three attempts per sweep at most) |
| Engineering Worker | Separate host (`Dockerfile.worker`) | `FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN` (dedicated-role JWT), `FORGEWING_REPOSITORY_ROOT=/repository`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ANTHROPIC_API_KEY`, optionally `FORGEWING_REPOSITORY_PLAN_POLL_INTERVAL_MS` / `FORGEWING_REPOSITORY_PLAN_ONE_SHOT`. Never on Vercel |
| Legacy OpenAI Instructor assist | Vercel | Off unless `EIGHTFORGE_INSTRUCTOR_ENABLED=1` **and** `OPENAI_API_KEY` (S1). Evidence-only: never writes typed fields |
| Legacy document AI enrichment | Per org | `organizations.analysis_mode='ai_enriched'`. Evidence-only: never creates decisions or tasks (S1) |

## Intended production state (hardening complete, nothing newly enabled)

```text
FORGEWING_SHADOW_ENABLED=<as currently operated>
FORGEWING_MODEL=claude-sonnet-4-6
# Every workflow switch stays as currently operated. Qualification-blocked
# workflows (value reading, case investigation, V1 / multi-cluster recovery)
# cannot run regardless of their switch.
# Daily caps default to 0: set a cap only when enabling that workflow for an
# entitled, data-policy-approved organization.
```

## Rollback

Each line is the fastest safe stop. Nothing is deleted, and reviewed values stay
valid.

- **Everything:** unset `FORGEWING_SHADOW_ENABLED`. Every provider path stops.
  Pending proposals stay as evidence.
- **One workflow:** unset its `*_ENABLED`, or set its daily cap to `0`.
- **One organization:** insert a revoking entitlement event, or a revoking
  data-policy event per class.
- **The Engineering Worker:** stop its container. Queued jobs wait.
- **A model problem:** pin `FORGEWING_MODEL=claude-sonnet-4-6`. An unqualified
  model already fails closed.
