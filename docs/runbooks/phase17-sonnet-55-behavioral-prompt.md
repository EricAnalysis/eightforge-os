# Phase17 v12: one owner-authorized behavioral prompt revision

The owner authorized ONE general behavioral prompt revision after v11 failed.
The exact v11 prompt is preserved as prefix. The addition separates source
observations from proposed compositions, determines row ownership from supplied
source-page geometry and row structure before selecting an ID, rejects semantic
similarity as sole proof, and requires one supplied ID with an existing bounded
rationale. No unit IDs, known answers, page-specific answers, candidate hints,
benchmark examples or reviewer labels are present. Independent scope review PASS.

New immutable prompt identity: forgewing-recovery-candidate-v2-phase17-behavioral-prompt,
version v12-owner-approved-20261015. Exact prompt SHA256:
4fc7afc5f4a94f15d9451a6dcb955e29608df384b0e9a9901161c94f0c0afc5a.

Only the system prompt changes on the wire relative to v11. Transmitted schema,
between_tools transport, all48 inputs/candidates, corpus,13 labels, scoring,
correctness/latency/cost thresholds,400-token cap,3000ms timeout,zero retries,
authority rules and production configuration remain unchanged. V11 stays FAIL.
B4.6.1 PASS is independent and reused; no unaffected benchmark/audit is repeated.

## Required execution discipline

1. Static prompt diff/prefix proof and generality review.
2. Focused local parity/pins/freeze/isolation tests; required CI before merge.
3. No provider compatibility probe: the schema and transport are identical to
   v11's40 completed Sonnet5.5 responses. Do not spend a cohort on schema discovery.
4. Zero-call preflight from the clean merged revision, verify all protected inputs,
   and freeze all48 request-body/options/input digests before provider execution.
5. Run exactly ONE complete48 cohort via
   `npm run eval:phase17-sonnet-5-5-behavioral-prompt`, within the unchanged ceiling.

No selective retries, exclusions, output repair or post-output label changes.
If genuine wrong selections, instruction-following failures or provider tail
latency/timeouts remain and no concrete implementation defect is demonstrated,
STOP: record `CLAUDE-SONNET-5-5 PHASE 17 = NOT QUALIFIED`, keep
`FORGEWING_MODEL=claude-sonnet-4-6`, preserve B4.6.1 PASS, and do not rewrite the
prompt again against this benchmark. Only a newly demonstrated engineering defect
can justify further work. Passing all frozen gates permits remaining production
parity/promotion checks; local success never itself grants canonical authority.
