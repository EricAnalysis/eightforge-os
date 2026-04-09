import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildProjectOperationalRollup,
  buildProjectOverviewModel,
  resolveProjectPendingActions,
  type ProjectDocumentRow,
  type ProjectOperationalRollup,
  type ProjectOverviewInvoiceItem,
  type ProjectRecord,
  type ProjectValidatorSummarySnapshot,
} from './projectOverview';

const baseProject: ProjectRecord = {
  id: 'project-1',
  name: 'Williamson Debris Ops',
  code: 'WDO-1',
  status: 'active',
  created_at: '2026-03-20T00:00:00Z',
};

function buildDocument(
  overrides: Partial<ProjectDocumentRow> = {},
): ProjectDocumentRow {
  return {
    id: 'doc-1',
    title: 'Debris DMS Checklist',
    name: 'dms-checklist.pdf',
    document_type: 'disposal_checklist',
    domain: 'operations',
    processing_status: 'decisioned',
    processing_error: null,
    created_at: '2026-03-20T00:00:00Z',
    processed_at: '2026-03-20T01:00:00Z',
    project_id: 'project-1',
    intelligence_trace: {
      facts: {},
      decisions: [
        {
          id: 'trace-decision-1',
          family: 'missing',
          severity: 'warning',
          title: 'Missing TDEC permit support',
          detail: 'Permit support is missing for dumpsite validation.',
          primary_action: {
            id: 'action-1',
            type: 'attach',
            target_object_type: 'document',
            target_label: 'TDEC permit',
            description: 'Attach TDEC permit for dumpsite validation',
            expected_outcome: 'Permit support is linked for reviewer validation.',
            resolvable: false,
          },
          suggested_actions: [],
          missing_source_context: ['TDEC permit'],
        },
      ],
      flow_tasks: [
        {
          id: 'trace-task-1',
          title: 'Attach TDEC permit for dumpsite validation',
          verb: 'attach',
          entity_type: 'review',
          expected_outcome: 'Permit support is linked for reviewer validation.',
          priority: 'high',
          auto_safe: false,
          source_decision_ids: ['trace-decision-1'],
          flow_type: 'documentation',
          suggested_owner: 'Field reviewer',
        },
      ],
      generated_at: '2026-03-20T01:00:00Z',
      engine_version: 'document_intelligence:v2',
    },
    ...overrides,
  };
}

describe('project operational rollup', () => {
  it('surfaces document-derived pending actions and blocks clear state', () => {
    const document = buildDocument();
    const rollup = buildProjectOperationalRollup({
      project: baseProject,
      documents: [document],
      decisions: [],
      tasks: [],
      documentReviews: [],
    });

    assert.equal(rollup.status.label, 'Needs Review');
    assert.equal(rollup.project_clear, false);
    assert.equal(rollup.needs_review_document_count, 1);
    assert.equal(rollup.unresolved_finding_count, 1);
    assert.equal(rollup.open_document_action_count, 1);
    assert.equal(
      rollup.pending_actions[0]?.href,
      '/platform/documents/doc-1?source=project&projectId=project-1',
    );

    const model = buildProjectOverviewModel({
      project: baseProject,
      documents: [document],
      documentReviews: [],
      decisions: [],
      tasks: [],
      activityEvents: [],
      members: [],
    });

    assert.equal(model.status.label, 'Needs Review');
    assert.equal(model.action_total, 1);
    assert.equal(
      model.actions[0]?.href,
      '/platform/documents/doc-1?source=project&projectId=project-1',
    );
    assert.equal(model.documents[0]?.status_label, 'Needs review');
  });

  it('prioritizes blocked findings ahead of review state', () => {
    const blockedDocument = buildDocument({
      intelligence_trace: {
        facts: {},
        decisions: [
          {
            id: 'trace-decision-blocked',
            family: 'mismatch',
            severity: 'critical',
            title: 'Permit conflicts with dumpsite record',
            detail: 'The linked permit does not match the disposal site in the checklist.',
          },
        ],
        flow_tasks: [],
        generated_at: '2026-03-20T01:00:00Z',
        engine_version: 'document_intelligence:v2',
      },
    });

    const rollup = buildProjectOperationalRollup({
      project: baseProject,
      documents: [blockedDocument],
      decisions: [],
      tasks: [],
      documentReviews: [],
    });

    assert.equal(rollup.status.label, 'Blocked');
    assert.equal(rollup.blocked_count, 1);
    assert.equal(rollup.project_clear, false);
  });
});

// ---------------------------------------------------------------------------
// Invoice-priority action queue (Phase 4)
// ---------------------------------------------------------------------------

function makeEmptyRollup(): ProjectOperationalRollup {
  return buildProjectOperationalRollup({
    project: baseProject,
    documents: [],
    decisions: [],
    tasks: [],
    documentReviews: [],
  });
}

function makeValidatorSummary(
  invoices: ProjectOverviewInvoiceItem[],
): ProjectValidatorSummarySnapshot {
  const blocked = invoices.filter((i) => i.approval_status === 'blocked');
  const blockedTotal = blocked.reduce((s, i) => s + (i.billed_amount ?? 0), 0);
  const requiresVerificationAmount = invoices.reduce(
    (sum, invoice) => sum + (invoice.requires_verification_amount ?? 0),
    0,
  );
  return {
    status: 'BLOCKED',
    critical_count: 0,
    warning_count: 0,
    info_count: 0,
    open_count: 0,
    blocked_reasons: [],
    trigger_source: null,
    nte_amount: null,
    total_billed: invoices.reduce((s, i) => s + (i.billed_amount ?? 0), 0),
    total_at_risk: invoices.reduce((s, i) => s + (i.at_risk_amount ?? 0), 0),
    requires_verification_amount:
      requiresVerificationAmount > 0 ? requiresVerificationAmount : null,
    validator_readiness: 'BLOCKED',
    reconciliation_overall: 'MISMATCH',
    invoice_summaries: invoices,
    blocked_amount: blockedTotal > 0 ? blockedTotal : null,
  };
}

function makeInvoice(
  overrides: Partial<ProjectOverviewInvoiceItem>,
): ProjectOverviewInvoiceItem {
  const billedAmount = overrides.billed_amount ?? 100_000;
  const approvalStatus = overrides.approval_status ?? 'blocked';
  const defaultRequiresVerification =
    approvalStatus === 'approved' || approvalStatus === 'approved_with_exceptions'
      ? 0
      : billedAmount;

  return {
    invoice_number: 'INV-001',
    approval_status: approvalStatus,
    billed_amount: billedAmount,
    supported_amount: 0,
    at_risk_amount: overrides.at_risk_amount ?? billedAmount,
    requires_verification_amount:
      overrides.requires_verification_amount ?? defaultRequiresVerification,
    reconciliation_status: 'MISMATCH',
    ...overrides,
  };
}

describe('invoice-priority action queue', () => {
  it('places a blocked invoice action before standard task actions', () => {
    const rollup = buildProjectOperationalRollup({
      project: baseProject,
      documents: [buildDocument()],   // has 1 trace task
      decisions: [],
      tasks: [],
      documentReviews: [],
    });

    const blockedInvoice = makeInvoice({
      invoice_number: 'INV-100',
      billed_amount: 200_000,
      at_risk_amount: 200_000,
    });
    const summary = makeValidatorSummary([blockedInvoice]);
    const actions = resolveProjectPendingActions(rollup, summary, 'project-1');

    assert.ok(actions.length >= 2, 'should have at least invoice + task action');
    assert.equal(actions[0]?.invoice_number, 'INV-100');
    assert.equal(actions[0]?.approval_status, 'blocked');
    assert.equal(actions[0]?.status_label, 'Blocked');
    assert.equal(actions[0]?.due_tone, 'danger');
  });

  it('orders blocked invoice before needs-review invoice', () => {
    const rollup = makeEmptyRollup();
    const invoices = [
      makeInvoice({ invoice_number: 'INV-NR', approval_status: 'needs_review', billed_amount: 80_000, at_risk_amount: 25_000 }),
      makeInvoice({ invoice_number: 'INV-BL', approval_status: 'blocked', billed_amount: 50_000, at_risk_amount: 50_000 }),
    ];
    const summary = makeValidatorSummary(invoices);
    const actions = resolveProjectPendingActions(rollup, summary, 'project-1');

    assert.equal(actions[0]?.invoice_number, 'INV-BL');
    assert.equal(actions[0]?.approval_status, 'blocked');
    assert.equal(actions[1]?.invoice_number, 'INV-NR');
    assert.equal(actions[1]?.approval_status, 'needs_review');
  });

  it('sorts blocked invoices by billed amount descending', () => {
    const rollup = makeEmptyRollup();
    const invoices = [
      makeInvoice({ invoice_number: 'INV-SMALL', billed_amount: 10_000 }),
      makeInvoice({ invoice_number: 'INV-LARGE', billed_amount: 500_000 }),
      makeInvoice({ invoice_number: 'INV-MED', billed_amount: 120_000 }),
    ];
    const summary = makeValidatorSummary(invoices);
    const actions = resolveProjectPendingActions(rollup, summary, 'project-1');

    assert.equal(actions[0]?.invoice_number, 'INV-LARGE');
    assert.equal(actions[1]?.invoice_number, 'INV-MED');
    assert.equal(actions[2]?.invoice_number, 'INV-SMALL');
  });

  it('excludes approved and approved_with_exceptions invoices from actions', () => {
    const rollup = makeEmptyRollup();
    const invoices = [
      makeInvoice({ invoice_number: 'INV-OK', approval_status: 'approved', at_risk_amount: 0 }),
      makeInvoice({ invoice_number: 'INV-AWE', approval_status: 'approved_with_exceptions', at_risk_amount: 0 }),
      makeInvoice({ invoice_number: 'INV-BL', approval_status: 'blocked', billed_amount: 75_000 }),
    ];
    const summary = makeValidatorSummary(invoices);
    const actions = resolveProjectPendingActions(rollup, summary, 'project-1');

    const ids = actions.map((a) => a.invoice_number);
    assert.ok(!ids.includes('INV-OK'), 'approved invoice should not generate action');
    assert.ok(!ids.includes('INV-AWE'), 'approved_with_exceptions should not generate action');
    assert.ok(ids.includes('INV-BL'), 'blocked invoice must generate action');
  });

  it('populates financial enrichment fields on invoice actions', () => {
    const rollup = makeEmptyRollup();
    const invoice = makeInvoice({
      invoice_number: 'INV-FIN',
      billed_amount: 150_000,
      at_risk_amount: 150_000,
      approval_status: 'blocked',
    });
    const summary = makeValidatorSummary([invoice]);
    const actions = resolveProjectPendingActions(rollup, summary, 'project-1');

    const action = actions[0];
    assert.ok(action, 'action must exist');
    assert.equal(action.invoice_number, 'INV-FIN');
    assert.equal(action.impacted_amount, 150_000);
    assert.equal(action.at_risk_amount, 150_000);
    assert.equal(action.requires_verification_amount, 150_000);
    assert.equal(action.blocked_amount, 150_000);
    assert.ok(action.next_step, 'next_step must be populated for invoice actions');
    assert.ok(action.href.includes('#project-validator'), 'href must point to validator tab');
  });

  it('returns no invoice actions when validator summary is absent', () => {
    const rollup = buildProjectOperationalRollup({
      project: baseProject,
      documents: [buildDocument()],
      decisions: [],
      tasks: [],
      documentReviews: [],
    });
    // no summary passed
    const actions = resolveProjectPendingActions(rollup);
    assert.ok(actions.length > 0, 'should still return task actions');
    assert.ok(
      actions.every((a) => a.approval_status == null),
      'no invoice-sourced actions without summary',
    );
  });

  it('preserves standard task actions even when invoice actions are present', () => {
    const rollup = buildProjectOperationalRollup({
      project: baseProject,
      documents: [buildDocument()],   // 1 trace task
      decisions: [],
      tasks: [],
      documentReviews: [],
    });
    const invoice = makeInvoice({ invoice_number: 'INV-PRES', billed_amount: 60_000 });
    const summary = makeValidatorSummary([invoice]);
    const actions = resolveProjectPendingActions(rollup, summary, 'project-1');

    const taskActions = actions.filter((a) => a.approval_status == null);
    assert.ok(taskActions.length > 0, 'standard task actions must still be present');
  });
});
