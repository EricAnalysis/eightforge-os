# CS-13 Operations Query Follow-up

## Scope decision

`lib/operationsQuery/executeOperationsQuery.ts` and
`lib/operationsQuery/askOperationsChips.ts` remain unchanged in CS-13.

Their `model.decisions` value is not the legacy project Overview model. It is
`OperationalQueueModel.decisions`, a portfolio projection that deliberately
combines persisted decisions, document-trace decisions, and execution items.
The two consumers also depend on portfolio-only fields such as `review_status`,
`kind`, `blocked`, and `project_id`.

`resolveProjectIssueObjects` operates at project scope and requires canonical
project findings plus optional evidence, execution items, activity events, and
documents. `OperationalQueueModel` does not retain that complete grouped input,
and an `OperationalDecisionQueueItem` cannot be losslessly converted back to a
`ProjectDecisionRow` or `IssueObject`.

## Recommendation

Do not adapt only the two query consumers. That would create an incomplete
issue-object projection and change trace-decision/execution-item behavior.

A complete follow-up should migrate the portfolio queue builder upstream:

1. group the canonical project inputs needed by `resolveProjectIssueObjects`;
2. resolve issue objects once per project;
3. define and test a portfolio issue projection that preserves all current
   persisted-decision, trace-decision, and execution-item rows;
4. prove parity for critical/open counts, invoice review signals, ordering,
   routing targets, source references, and evidence summaries;
5. switch `executeOperationsQuery` and `askOperationsChips` together.

Until those inputs and parity fixtures exist, retaining the current
`OperationalQueueModel.decisions` consumers is the deterministic, non-partial
choice.
