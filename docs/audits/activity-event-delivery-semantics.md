# Activity-event delivery semantics

`logActivityEvent` uses explicit best-effort delivery. Originating mutations and
`activity_events` inserts are separate PostgREST requests, so they are not atomic.
An event delivery failure does not roll back a successful mutation or turn an
otherwise successful user route into an error. Every failure is nevertheless
observable through the returned structured diagnostic and the centrally emitted
`ACTIVITY_EVENT_DELIVERY_FAILED` diagnostic.

The diagnostic contains the organization, project, entity type, entity ID and
event type needed to identify the missing event. It does not change the persisted
activity-event payload or the database event-type constraint.

## Audit-critical mutations

The following changes require an activity event. A delivery failure is an audit
gap and must produce the central diagnostic:

- Decision status, assignment, due date, review/feedback and closure changes.
- Workflow-task status, assignment and due-date changes.
- Document type, soft deletion, project movement/removal, review, fact review and
  fact override changes.
- Project archive, deletion and validation-phase changes.
- Governing-document, relationship, precedence and subtype changes.
- Execution-item creation, outcome changes and validation-run supersession.
- Manual rate-link finding closure/override.
- Validation request/completion and finding generation.
- Validator-owned primary approval decision creation or update.

For CS-11 supersession, the canonical state remains durable on the execution item:
`status = 'superseded'` and `superseded_by_run_id = <validation run id>`. The
secondary `status_changed` activity event records the prior state and the new
state including that run ID. A failed event is therefore an observable audit gap,
not loss of the supersession source of truth.

## Informational events

Document pipeline/evaluation processing summaries and generic generated-decision
creation notifications are informational. Their failure still emits the same
diagnostic, but canonical document intelligence, processing state and persisted
decision rows remain their sources of truth.
