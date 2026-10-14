# Forgewing production hardening: engineering log

Append-only. Each entry records the change, the reason, the proof, the PR or commit, the migration status and any remaining blocker. Never edit an earlier entry; correct it with a later one.

Authority and plan:
- Owner-approved hardening plan S1–S10, then P3 / P3.2 (2026-10-13).
- Owner continuation and merge approvals (2026-10-14).

| # | Date | Change | Reason | Proof | PR / commit | Migration | Remaining blocker |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-13 | S1: OpenAI Instructor assist explicit opt-in and evidence-only; AI-enrichment detections kept out of `decisions` and workflows | Ungated AI paths wrote typed fields and operator decisions | Unit and architecture tests; full CI | #231 (c7becd5) | none | — |
| 2 | 2026-10-14 | S2: `FORGEWING_QUALIFIED_MODELS = ['claude-sonnet-4-6']`; unqualified model gives `model_unqualified` | A Claude 5 shared model silently broke every `temperature: 0` call | modelConfig and route tests; boundary guard | #233 (aa498a6) | none | — |
| 3 | 2026-10-14 | #236 test fix closed | Superseded by Codex #242 (same guard) | — | #236 closed | none | — |
| 4 | 2026-10-14 | S3: Workflow Assessment behind entitlement, data policy and durable budget; gates resolved before claim; budget reserved atomically with the claim | Customer content reached the provider gated only by env flags | Linux replay plus `WORKFLOW ASSESSMENT FORGEWING GATES: PASS`; owner-approved | #237 (5169c13; re-land of #234) | `20261014150000` **applied** | — |
| 5 | 2026-10-14 | S5: Forgewing grants require `recorded_by` (NOT VALID, new rows only); route actor attribution guard | Activations could be unattributed | Linux replay plus B4.1 probe; owner-approved | #241 (313ed3f) | `20261014160000` **applied** | Service-role actor attestation (accepted residual) |
| 6 | 2026-10-14 | S6: explicit timeouts and bounded retries everywhere; typed Ask failure; provider test routes closed in production | SDK default 10-minute / 2-retry calls; key diagnostics exposed | Reliability guard; Ask route tests | included in #244 (S6 commit stacked) | none | — |
| 7 | 2026-10-14 | S7: content-free `forgewing_provider_call_observations` ledger; Ask and Workflow Assessment wired | No production cost / latency / failure record | Linux replay plus `FORGEWING PROVIDER CALL TELEMETRY: PASS`; owner-approved | #244 (3b159bf) | `20261014170000` **applied** | — |
| 8 | 2026-10-14 | S4: reviewed-value writer split from the read module; transitive AI-surface → human-writer guard | Five AI surfaces could reach the truth writer | New guard; tests | #238 (48c31ed) | none | — |
| 9 | 2026-10-14 | S9 + S10: recovery re-entry semantics corrected; production environment manifest | Ambiguous runbook; no single env list | Docs | #240 (989bc0e) | none | — |
| 10 | 2026-10-14 | S8: `Dockerfile.worker`, fail-closed worker startup, bounded Plan V2 polling, runbook | No deployable worker host | Image built and smoke-tested; tests | #243 (661c4af) | none | Worker host not yet deployed |
| 11 | 2026-10-14 | P3a: deterministic B6 investigation of Validator findings; `case_evidence` classed as `text_excerpts` | Baseline for case investigation; data-policy leak | Resolution tests | #245 (5258c39) | none | — |
| 12 | 2026-10-14 | P3b: hardened operator-invoked case investigation (Validator findings only, navigation-only ranking, cited evidence, no invented numbers) | Production-capable but still ceiling-disabled | Runner, route and client tests | #246 (f042b7c) | none | Qualification (owner approval of contract) |
| 13 | 2026-10-14 | Telemetry extended to five shadow tasks and Recovery V2 | Same ledger, no new store | Request-identity tests per task | #251 (d3d92ea) | none | Plan V2 telemetry needs a worker-role grant (migration) |
| 14 | 2026-10-14 | P3.2 V1 `amends` relationship proposals; confirmation only through `link_relationship` | Owner-approved product direction | Local replay plus `FORGEWING RELATIONSHIP PROPOSALS: PASS`; tests | #252 | `20261014190000` **awaiting owner approval** | Owner merge approval; UI follow-up |
| 15 | 2026-10-14 | P3c durable Case Investigation records | Owner-approved product direction | Local replay plus `FORGEWING CASE INVESTIGATION RECORDS: PASS`; tests | (this batch) | `20261014200000` **awaiting owner approval**; must merge after #252 | Owner merge approval |
| 16 | 2026-10-14 | S8 deployment procedure and host preflight script | Image and runbook are not a deployment | Preflight tests | (this PR) | none | Owner deploys the host |
