import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { ValidationFinding } from '@/types/validator';
import {
  buildProjectOperationalRollup,
  buildProjectOverviewModel,
  documentNeedsExtractionFollowUp,
  parseDocumentExecutionTrace,
  resolveProjectAuditEvents,
  resolveProjectDecisionSummary,
  resolveProjectIssueObjectDecisionSummary,
  resolveProjectPendingActions,
  type ProjectActivityEventRow,
  type ProjectDecisionRow,
  type ProjectDocumentRow,
  type ProjectMember,
  type ProjectOperationalRollup,
  type ProjectOverviewInvoiceItem,
  type ProjectRecord,
  type ProjectTaskRow,
  type ProjectValidatorSummarySnapshot,
} from './projectOverview';
import { resolveProjectIssueObjects } from './resolveProjectIssueObjects';

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

  it('does not mark invoice documents clear when contractor or client hints are missing from extraction', () => {
    const invoiceDocument = buildDocument({
      id: 'invoice-missing-client',
      title: 'Monthly invoice',
      name: 'invoice.pdf',
      document_type: 'invoice',
      intelligence_trace: {
        classification: { label: 'Invoice', family: 'invoice' },
        facts: {
          vendor_name: 'Aftermath Disaster Recovery, Inc.',
          invoice_number: 'INV-009',
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-20T01:00:00Z',
        engine_version: 'document_intelligence:v2',
      },
    });

    const trace = parseDocumentExecutionTrace(invoiceDocument.intelligence_trace);
    assert.ok(trace);
    assert.equal(documentNeedsExtractionFollowUp(invoiceDocument, trace), true);

    const rollup = buildProjectOperationalRollup({
      project: baseProject,
      documents: [invoiceDocument],
      decisions: [],
      tasks: [],
      documentReviews: [
        {
          document_id: invoiceDocument.id,
          status: 'approved',
          reviewed_at: '2026-03-20T02:00:00Z',
        },
      ],
    });

    assert.equal(rollup.document_status_by_id[invoiceDocument.id]?.label, 'Needs review');
    assert.equal(rollup.needs_review_document_count, 1);

    const completeInvoice = buildDocument({
      id: 'invoice-complete-parties',
      title: 'Monthly invoice',
      name: 'invoice.pdf',
      document_type: 'invoice',
      intelligence_trace: {
        classification: { label: 'Invoice', family: 'invoice' },
        facts: {
          contractor_name: 'Aftermath Disaster Recovery, Inc.',
          client_name: 'Williamson County',
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-20T01:00:00Z',
        engine_version: 'document_intelligence:v2',
      },
    });

    const rollupComplete = buildProjectOperationalRollup({
      project: baseProject,
      documents: [completeInvoice],
      decisions: [],
      tasks: [],
      documentReviews: [
        {
          document_id: completeInvoice.id,
          status: 'approved',
          reviewed_at: '2026-03-20T02:00:00Z',
        },
      ],
    });

    const completeTrace = parseDocumentExecutionTrace(completeInvoice.intelligence_trace);
    assert.ok(completeTrace);
    assert.equal(documentNeedsExtractionFollowUp(completeInvoice, completeTrace), false);
    assert.equal(rollupComplete.document_status_by_id[completeInvoice.id]?.label, 'Reviewed');
  });

  it('keeps reviewed documents out of Needs Review when only non-blocking warnings remain', () => {
    const document = buildDocument({
      intelligence_trace: {
        facts: {},
        decisions: [
          {
            id: 'trace-warning-1',
            family: 'risk',
            severity: 'warning',
            title: 'OCR confidence warning',
            detail: 'A low-confidence diagnostic remains visible for operator awareness.',
            suggested_actions: [],
          },
        ],
        flow_tasks: [],
        generated_at: '2026-03-20T01:00:00Z',
        engine_version: 'document_intelligence:v2',
      },
    });

    const rollup = buildProjectOperationalRollup({
      project: baseProject,
      documents: [document],
      decisions: [],
      tasks: [],
      documentReviews: [
        {
          document_id: document.id,
          status: 'approved',
          reviewed_at: '2026-03-20T02:00:00Z',
        },
      ],
    });

    assert.equal(rollup.needs_review_document_count, 0);
    assert.equal(rollup.document_status_by_id[document.id]?.label, 'Warning');
  });

  it('returns a stale approved document to Needs Review after a newer extraction', () => {
    const document = buildDocument({
      processed_at: '2026-03-20T03:00:00Z',
      intelligence_trace: {
        facts: {},
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-20T03:00:00Z',
        engine_version: 'document_intelligence:v2',
      },
    });

    const rollup = buildProjectOperationalRollup({
      project: baseProject,
      documents: [document],
      decisions: [],
      tasks: [],
      documentReviews: [
        {
          document_id: document.id,
          status: 'approved',
          reviewed_at: '2026-03-20T02:00:00Z',
        },
      ],
    });

    assert.equal(rollup.needs_review_document_count, 1);
    assert.equal(rollup.document_status_by_id[document.id]?.label, 'Needs review');
  });

  it('tracks linked documents separately from processed document counts', () => {
    const processedDocument = buildDocument({
      intelligence_trace: null,
    });
    const linkedUnprocessedDocument = buildDocument({
      id: 'doc-2',
      title: 'Unsigned field ticket',
      name: 'field-ticket.pdf',
      processing_status: 'uploaded',
      processed_at: null,
      intelligence_trace: null,
    });

    const rollup = buildProjectOperationalRollup({
      project: baseProject,
      documents: [processedDocument, linkedUnprocessedDocument],
      decisions: [],
      tasks: [],
      documentReviews: [],
    });

    assert.equal(rollup.linked_document_count, 2);
    assert.equal(rollup.processed_document_count, 1);
    assert.equal(rollup.needs_review_document_count, 0);
  });

  it('projects decision execution details onto project decisions', () => {
    const decisions: ProjectDecisionRow[] = [
      {
        id: 'decision-1',
        document_id: 'doc-invoice-1',
        source: 'project_validator',
        decision_type: 'invoice_review',
        title: 'Invoice 2026-003 support mismatch',
        summary: 'Invoice 2026-003 is not fully supported by transaction evidence.',
        severity: 'critical',
        status: 'open',
        confidence: 0.91,
        last_detected_at: '2026-03-24T10:00:00Z',
        created_at: '2026-03-24T09:00:00Z',
        due_at: '2026-03-28T00:00:00Z',
        assigned_to: 'member-1',
        details: {
          problem: 'Invoice 2026-003 billed amount is not fully supported by transaction truth.',
          impact: '$280,802.25 remains at risk until support is reconciled.',
          required_action: 'Confirm billed quantity and line support for invoice 2026-003.',
          evidence_refs: ['invoice:2026-003:line-1', 'transaction:billing-group-44'],
          source_family: 'invoice',
          primary_action: {
            id: 'action-1',
            type: 'document',
            target_object_type: 'document',
            target_label: 'Invoice 2026-003',
            description: 'Confirm billed quantity and line support for invoice 2026-003.',
            expected_outcome: 'Invoice support is reconciled and ready for approval.',
            resolvable: false,
          },
        },
        assignee: { id: 'member-1', display_name: 'Avery Ops' },
        documents: {
          id: 'doc-invoice-1',
          project_id: 'project-1',
          title: 'Invoice 2026-003',
          name: 'invoice-2026-003.pdf',
          document_type: 'invoice',
        },
      },
    ];
    const tasks: ProjectTaskRow[] = [
      {
        id: 'task-1',
        decision_id: 'decision-1',
        document_id: 'doc-invoice-1',
        task_type: 'review_validator_finding',
        title: 'Reconcile invoice 2026-003 support',
        description: 'Review the invoice support trail and confirm line-level backing.',
        priority: 'high',
        status: 'open',
        created_at: '2026-03-24T09:15:00Z',
        updated_at: '2026-03-24T09:30:00Z',
        due_at: '2026-03-29T00:00:00Z',
        assigned_to: 'member-1',
        details: {
          required_action: 'Review invoice support trail and confirm line-level backing.',
        },
        source_metadata: {
          origin: 'project_validator',
        },
        assignee: { id: 'member-1', display_name: 'Avery Ops' },
        documents: {
          id: 'doc-invoice-1',
          project_id: 'project-1',
          title: 'Invoice 2026-003',
          name: 'invoice-2026-003.pdf',
          document_type: 'invoice',
        },
      },
    ];
    const members: ProjectMember[] = [{ id: 'member-1', display_name: 'Avery Ops' }];

    const summary = resolveProjectDecisionSummary(decisions, tasks, members, 'project-1', [
      {
        id: 'activity-1',
        project_id: 'project-1',
        entity_type: 'decision',
        entity_id: 'decision-1',
        event_type: 'review_recorded',
        old_value: { status: 'open' },
        new_value: {
          feedback_type: 'needs_review',
          operator_action: 'needs_review',
          status_after_feedback: 'in_review',
        },
        changed_by: 'member-1',
        created_at: '2026-03-24T11:00:00Z',
      },
    ]);
    const decision = summary[0];

    assert.ok(decision, 'decision projection must exist');
    assert.equal(decision.problem, 'Invoice 2026-003 billed amount is not fully supported by transaction truth.');
    assert.equal(decision.impact, '$280,802.25 remains at risk until support is reconciled.');
    assert.equal(decision.required_action, 'Confirm billed quantity and line support for invoice 2026-003.');
    assert.equal(decision.owner_label, 'Avery Ops');
    assert.equal(decision.due_at, '2026-03-28T00:00:00Z');
    assert.equal(decision.source_document_title, 'Invoice 2026-003');
    assert.equal(decision.source_document_href, '/platform/documents/doc-invoice-1?source=project&projectId=project-1');
    assert.ok(decision.source_evidence_label.includes('Validator output'));
    assert.ok(decision.source_evidence_label.includes('2 evidence refs'));
    assert.equal(decision.lifecycle_state, 'needs_verification');
    assert.equal(decision.last_operator_action, 'Needs Review');
    assert.equal(decision.evidence_summaries[0]?.document_title, 'Invoice 2026-003');
    assert.equal(decision.evidence_summaries[0]?.anchor_summary, '2026-003 / line-1');
  });

  it('keeps invoice-line rate blockers specific across multiple invoices', () => {
    const decisions: ProjectDecisionRow[] = [
      {
        id: 'decision-2026-002',
        document_id: 'doc-invoice-002',
        source: 'project_validator',
        decision_type: 'validator_invoice_approval',
        title: 'Invoice 2026-002 approval status',
        summary: 'Invoice line is missing a confirmed contract rate match.',
        severity: 'critical',
        status: 'open',
        confidence: null,
        last_detected_at: '2026-03-24T10:00:00Z',
        created_at: '2026-03-24T09:00:00Z',
        due_at: null,
        assigned_to: null,
        details: {
          origin: 'project_validator',
          primary_rule_id: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
          problem: 'Invoice line is missing a confirmed contract rate match.',
          impact: 'This invoice line has a billed rate or category, but EightForge could not confirm the matching governing contract schedule row.',
          required_action: 'Verify the contract rate schedule row, correct the line mapping, or override with a reason.',
          validator_finding_ids: ['finding-2026-002'],
          evidence_refs: ['invoice_line:typed:abc:invoice:line:4'],
          invoice_line_contexts: [
            {
              invoice_number: '2026-002',
              rate_code: '1F',
              line_description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30',
              quantity: '916',
              unit_price: '14.50',
              line_total: '13282.00',
            },
          ],
        },
        documents: {
          id: 'doc-invoice-002',
          project_id: 'project-1',
          title: 'Invoice 2026-002',
          name: 'invoice-2026-002.pdf',
          document_type: 'invoice',
        },
      },
      {
        id: 'decision-2026-003',
        document_id: 'doc-invoice-003',
        source: 'project_validator',
        decision_type: 'validator_invoice_approval',
        title: 'Invoice 2026-003 approval status',
        summary: 'Invoice line is missing a confirmed contract rate match.',
        severity: 'critical',
        status: 'open',
        confidence: null,
        last_detected_at: '2026-03-24T10:01:00Z',
        created_at: '2026-03-24T09:01:00Z',
        due_at: null,
        assigned_to: null,
        details: {
          origin: 'project_validator',
          primary_rule_id: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
          problem: 'Invoice line is missing a confirmed contract rate match.',
          validator_finding_ids: ['finding-2026-003'],
          invoice_line_contexts: [
            {
              invoice_number: '2026-003',
              rate_code: '2A',
              quantity: '12',
            },
          ],
        },
        documents: {
          id: 'doc-invoice-003',
          project_id: 'project-1',
          title: 'Invoice 2026-003',
          name: 'invoice-2026-003.pdf',
          document_type: 'invoice',
        },
      },
    ];

    const summary = resolveProjectDecisionSummary(decisions, [], [], 'project-1');
    const invoice002 = summary.find((decision) => decision.id === 'decision-2026-002');
    const invoice003 = summary.find((decision) => decision.id === 'decision-2026-003');

    assert.ok(invoice002, 'invoice 2026-002 decision should be projected');
    assert.ok(invoice003, 'invoice 2026-003 decision should be projected');
    assert.ok(invoice002.metadata.includes('Invoice 2026-002'));
    assert.ok(invoice002.metadata.includes('Line 1F - Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30'));
    assert.ok(invoice002.metadata.includes('Quantity 916.00'));
    assert.ok(invoice002.metadata.includes('Unit price $14.50'));
    assert.ok(invoice002.metadata.includes('Line total $13,282.00'));
    assert.equal(invoice002.evidence_summaries[0]?.anchor_summary, 'Invoice 2026-002 · Line 1F · Contract rate match');
    assert.ok(invoice003.metadata.includes('Invoice 2026-003'));
    assert.ok(!invoice003.metadata.includes('Invoice 2026-002'));
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

  it('uses canonical approval blockers for the header status even when the operational rollup has none', () => {
    const model = buildProjectOverviewModel({
      project: {
        ...baseProject,
        validation_status: 'BLOCKED',
        validation_summary_json: {
          validator_status: 'BLOCKED',
          validator_blockers: [
            {
              rule_id: 'invoice-support-1',
              severity: 'critical',
              subject_type: 'invoice',
              subject_id: 'inv-1',
              message: 'Missing ticket support for invoice group 1.',
            },
            {
              rule_id: 'invoice-support-2',
              severity: 'critical',
              subject_type: 'invoice',
              subject_id: 'inv-2',
              message: 'Missing ticket support for invoice group 2.',
            },
            {
              rule_id: 'invoice-support-3',
              severity: 'critical',
              subject_type: 'invoice',
              subject_id: 'inv-3',
              message: 'Missing ticket support for invoice group 3.',
            },
            {
              rule_id: 'invoice-support-4',
              severity: 'critical',
              subject_type: 'invoice',
              subject_id: 'inv-4',
              message: 'Missing ticket support for invoice group 4.',
            },
          ],
        },
      },
      documents: [],
      documentReviews: [],
      decisions: [],
      tasks: [],
      activityEvents: [],
      members: [],
    });

    assert.equal(model.validator_summary.approval_blocker_count, 4);
    assert.equal(model.status.label, 'Blocked');
    assert.match(model.status.detail, /^4 approval blockers are preventing payment\./);
  });

  it('does not mark the header blocked from exposure or stale approval decisions when validator readiness has no blockers', () => {
    const model = buildProjectOverviewModel({
      project: {
        ...baseProject,
        validation_status: 'FINDINGS_OPEN',
        validation_summary_json: {
          readiness: 'NEEDS_REVIEW',
          blocker_count: 0,
          validator_blockers: [],
          open_count: 1,
          requires_review_count: 1,
          exposure: {
            total_billed_amount: 100000,
            total_contract_supported_amount: 20480,
            total_transaction_supported_amount: 20480,
            total_fully_reconciled_amount: 20480,
            total_unreconciled_amount: 79520,
            total_at_risk_amount: 79520,
            total_requires_verification_amount: 79520,
            support_gap_tolerance_amount: 500,
            at_risk_tolerance_amount: 500,
            moderate_severity: 'warning',
            invoices: [
              {
                invoice_number: 'GOLDEN-001',
                billed_amount: 100000,
                billed_amount_source: 'invoice_total',
                contract_supported_amount: 20480,
                transaction_supported_amount: 20480,
                fully_reconciled_amount: 20480,
                supported_amount: 20480,
                unreconciled_amount: 79520,
                at_risk_amount: 79520,
                requires_verification_amount: 79520,
                reconciliation_status: 'MISMATCH',
              },
            ],
          },
        },
      },
      documents: [],
      documentReviews: [],
      decisions: [
        {
          id: 'stale-primary-project-approval',
          document_id: null,
          project_id: baseProject.id,
          source: 'project_validator',
          decision_type: 'validator_project_approval',
          title: 'Project approval status',
          summary: 'Approval is blocked.',
          severity: 'critical',
          status: 'open',
          confidence: 1,
          last_detected_at: '2026-07-01T21:15:09.612Z',
          created_at: '2026-07-01T21:15:09.612Z',
          due_at: null,
          assigned_to: null,
          details: {
            origin: 'project_validator',
            primary_approval_decision: true,
            approval_context: 'project',
            approval_status: 'blocked',
            gate_approval_status: 'blocked',
            blocked_amount: 534757.1,
            at_risk_amount: 79520,
            requires_verification_amount: 79520,
            required_reviews: 1,
            blocking_reasons: ['Stale project approval decision'],
          },
          assignee: null,
          documents: null,
        },
      ],
      tasks: [],
      activityEvents: [],
      members: [],
    });

    assert.equal(model.validator_summary.validator_readiness, 'NEEDS_REVIEW');
    assert.equal(model.validator_summary.approval_blocker_count, 0);
    assert.equal(model.validator_summary.total_at_risk, 79520);
    assert.equal(model.validator_summary.reconciliation_overall, null);
    assert.equal(model.status.label, 'Needs Review');
  });

  it('prefers live unresolved validator findings for overview counts while keeping validator amounts', () => {
    const model = buildProjectOverviewModel({
      project: {
        ...baseProject,
        validation_status: 'VALIDATED',
        validation_summary_json: {
          validator_status: 'READY',
          critical_count: 0,
          warning_count: 0,
          open_count: 0,
          total_billed: 200000,
          at_risk_amount: 35000,
          requires_verification_amount: 15000,
        },
      },
      documents: [],
      documentReviews: [],
      decisions: [],
      tasks: [],
      activityEvents: [],
      members: [],
      validationFindings: [
        buildValidationFinding(),
        buildValidationFinding({
          id: 'finding-2',
          rule_id: 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR',
          check_key: 'contract.pricing_applicability',
          severity: 'warning',
          subject_type: 'contract',
          subject_id: 'contract-1',
          blocked_reason: null,
          finding_disposition: 'requires_review',
          business_severity: 'high',
          problem: 'Pricing basis still needs operator review.',
          impact: 'Approval should pause for operator review until pricing is confirmed.',
          required_action: 'Confirm the governing pricing clause for this billed work.',
          evidence_refs: ['contract:pricing'],
          source_family: 'contract',
          affected_amount: null,
          approval_gate_effect: 'requires_operator_review',
        }),
      ],
    });

    assert.equal(model.validator_summary.approval_blocker_count, 1);
    assert.equal(model.validator_summary.warning_count, 0);
    assert.equal(model.validator_summary.requires_review_count, 1);
    assert.equal(model.validator_summary.total_at_risk, 35000);
    assert.equal(model.validator_summary.requires_verification_amount, 15000);
    assert.equal(model.status.label, 'Blocked');
  });

  it('falls back to canonical invoice documents for billed totals and invoice breakdowns', () => {
    const model = buildProjectOverviewModel({
      project: {
        ...baseProject,
        validation_status: 'NOT_READY',
        validation_summary_json: null,
      },
      documents: [
        buildDocument({
          id: 'invoice-doc-2026-002',
          title: 'Invoice 2026-002',
          name: 'invoice-2026-002.pdf',
          document_type: 'invoice',
          intelligence_trace: {
            facts: {},
            decisions: [],
            flow_tasks: [],
            extracted: {
              invoice_number: '2026-002',
              total_amount: 534757.1,
              period_start: '2026-02-23',
              period_end: '2026-03-18',
            },
          },
        }),
        buildDocument({
          id: 'invoice-doc-2026-003',
          title: 'Invoice 2026-003',
          name: 'invoice-2026-003.pdf',
          document_type: 'invoice',
          created_at: '2026-04-04T00:00:00Z',
          processed_at: '2026-04-04T01:00:00Z',
          intelligence_trace: {
            facts: {},
            decisions: [],
            flow_tasks: [],
            extracted: {
              invoice_number: '2026-003',
              total_amount: 280802.25,
              period_start: '2026-02-23',
              period_end: '2026-03-22',
            },
          },
        }),
      ],
      documentReviews: [],
      decisions: [],
      tasks: [],
      activityEvents: [],
      members: [],
    });

    assert.equal(model.validator_summary.total_billed, 815559.35);
    assert.equal(model.validator_summary.invoice_summaries.length, 2);
    assert.deepEqual(
      model.validator_summary.invoice_summaries.map((invoice) => invoice.invoice_number).sort(),
      ['2026-002', '2026-003'],
    );
  });

  it('uses reconciled approval-context subtitle for approved projects with only non-blocking warnings', () => {
    const model = buildProjectOverviewModel({
      project: {
        ...baseProject,
        validation_status: 'VALIDATED',
        validation_summary_json: {
          validator_status: 'READY',
          critical_count: 0,
          warning_count: 6,
          requires_review_count: 0,
          open_count: 6,
          exposure: {
            total_billed_amount: 815559.35,
            total_contract_supported_amount: 815559.35,
            total_transaction_supported_amount: 815559.35,
            total_fully_reconciled_amount: 815559.35,
            total_unreconciled_amount: 0,
            total_at_risk_amount: 0,
            total_requires_verification_amount: 0,
            support_gap_tolerance_amount: 500,
            at_risk_tolerance_amount: 500,
            moderate_severity: 'warning',
            invoices: [
              {
                invoice_number: '2026-002',
                billed_amount: 534757.1,
                billed_amount_source: 'invoice_total',
                contract_supported_amount: 534757.1,
                transaction_supported_amount: 534757.1,
                fully_reconciled_amount: 534757.1,
                supported_amount: 534757.1,
                unreconciled_amount: 0,
                at_risk_amount: 0,
                requires_verification_amount: 0,
                reconciliation_status: 'MATCH',
              },
              {
                invoice_number: '2026-003',
                billed_amount: 280802.25,
                billed_amount_source: 'invoice_total',
                contract_supported_amount: 280802.25,
                transaction_supported_amount: 280802.25,
                fully_reconciled_amount: 280802.25,
                supported_amount: 280802.25,
                unreconciled_amount: 0,
                at_risk_amount: 0,
                requires_verification_amount: 0,
                reconciliation_status: 'MATCH',
              },
            ],
          },
        },
      },
      documents: [
        buildDocument({ id: 'doc-contract', title: 'Contract', name: 'contract.pdf', document_type: 'contract' }),
        buildDocument({ id: 'doc-invoice-002', title: 'Invoice 2026-002', name: 'invoice-002.pdf', document_type: 'invoice' }),
        buildDocument({ id: 'doc-invoice-003', title: 'Invoice 2026-003', name: 'invoice-003.pdf', document_type: 'invoice' }),
        buildDocument({ id: 'doc-support', title: 'Support Workbook', name: 'support.xlsx', document_type: 'transaction_data' }),
      ],
      documentReviews: [],
      decisions: [],
      tasks: [],
      activityEvents: [],
      members: [],
    });

    assert.equal(model.status.label, 'Approved');
    assert.equal(
      model.status.detail,
      '4 linked documents are reconciled in the current approval context. 6 non-blocking warnings remain.',
    );
  });

  it('uses standardized validator-backed metric labels in Overview', () => {
    const model = buildProjectOverviewModel({
      project: {
        ...baseProject,
        validation_status: 'BLOCKED',
        validation_summary_json: {
          validator_status: 'BLOCKED',
          exposure: {
            total_billed_amount: 100000,
            total_contract_supported_amount: 95000,
            total_transaction_supported_amount: 93000,
            total_fully_reconciled_amount: 90000,
            total_unreconciled_amount: 10000,
            total_at_risk_amount: 10000,
            total_requires_verification_amount: 7000,
            support_gap_tolerance_amount: 500,
            at_risk_tolerance_amount: 500,
            moderate_severity: 'warning',
            invoices: [
              {
                invoice_number: 'INV-001',
                billed_amount: 100000,
                billed_amount_source: 'invoice_total',
                contract_supported_amount: 95000,
                transaction_supported_amount: 93000,
                fully_reconciled_amount: 90000,
                supported_amount: 93000,
                unreconciled_amount: 10000,
                at_risk_amount: 10000,
                requires_verification_amount: 7000,
                reconciliation_status: 'MISMATCH',
              },
            ],
          },
        },
      },
      documents: [],
      decisions: [],
      tasks: [],
      documentReviews: [],
      activityEvents: [],
      members: [],
    });

    assert.deepEqual(
      model.metrics.map((metric) => metric.label),
      [
        'Invoice Billed Amount',
        'Blocked Amount',
        'At Risk Amount',
        'Requires Verification',
        'Required Reviews',
        'Approval Status',
      ],
    );
  });

  it('uses open validator-backed decisions for required review counts instead of legacy action totals', () => {
    const model = buildProjectOverviewModel({
      project: {
        ...baseProject,
        validation_status: 'FINDINGS_OPEN',
        validation_summary_json: {
          validator_status: 'NEEDS_REVIEW',
          critical_count: 0,
          warning_count: 1,
          requires_review_count: 1,
          open_count: 2,
          total_billed: 100000,
        },
      },
      documents: [],
      documentReviews: [],
      decisions: [
        {
          id: 'validator-review-1',
          document_id: null,
          source: 'project_validator',
          decision_type: 'validator_invoice_review',
          title: 'Invoice 2026-003 requires review',
          summary: 'Validator-backed review decision.',
          severity: 'high',
          status: 'open',
          confidence: 1,
          last_detected_at: '2026-04-11T00:00:00Z',
          created_at: '2026-04-11T00:00:00Z',
          due_at: null,
          assigned_to: null,
          details: {
            origin: 'project_validator',
            problem: 'Invoice support remains unresolved.',
            impact: 'Approval stays open until support is confirmed.',
            required_action: 'Review the invoice support trail.',
            validator_finding_ids: ['finding-1'],
          },
          assignee: null,
          documents: null,
        },
      ],
      tasks: [],
      activityEvents: [],
      members: [],
    });

    assert.equal(model.metrics.find((metric) => metric.key === 'required-reviews')?.value, '2');
    assert.equal(model.facts.find((fact) => fact.label === 'Required Reviews')?.value, '2');
    assert.equal(model.metrics.some((metric) => metric.label === 'Open Actions'), false);
  });

  it('keeps overview approval status on validator summary even when a primary approval decision is stale', () => {
    const model = buildProjectOverviewModel({
      project: {
        ...baseProject,
        validation_status: 'VALIDATED',
        validation_summary_json: {
          validator_status: 'READY',
          critical_count: 0,
          warning_count: 0,
          open_count: 0,
          total_billed: 815559.35,
          at_risk_amount: 0,
          unsupported_amount: 0,
          requires_verification_amount: 0,
        },
      },
      documents: [],
      documentReviews: [],
      decisions: [
        {
          id: 'primary-project-approval',
          document_id: null,
          source: 'project_validator',
          decision_type: 'validator_project_approval',
          title: 'Project approval status',
          summary: 'Approval is blocked.',
          severity: 'critical',
          status: 'open',
          confidence: 1,
          last_detected_at: '2026-04-29T00:00:00Z',
          created_at: '2026-04-29T00:00:00Z',
          due_at: null,
          assigned_to: null,
          details: {
            origin: 'project_validator',
            primary_approval_decision: true,
            approval_context: 'project',
            approval_status: 'blocked',
            gate_approval_status: 'blocked',
            blocked_amount: 35559.35,
            unsupported_amount: 35559.35,
            at_risk_amount: 35559.35,
            requires_verification_amount: 35559.35,
            required_reviews: 2,
            required_action: 'Review the unsupported invoice amount before approving payment.',
            blocking_reasons: ['Unsupported invoice amount requires review'],
          },
          assignee: null,
          documents: null,
        },
      ],
      tasks: [],
      activityEvents: [],
      members: [],
    });

    assert.equal(model.status.label, 'Approved');
    assert.equal(model.validator_summary.required_review_total, 2);
    assert.equal(model.validator_summary.blocked_amount, null);
    assert.equal(model.metrics.find((metric) => metric.label === 'Blocked Amount')?.value, '$0');
    assert.equal(model.facts.find((fact) => fact.label === 'Blocked Amount')?.value, '$0');
  });

  it('does not let direct contract intelligence bypass validator decisions when validator has not run', () => {
    const model = buildProjectOverviewModel({
      project: {
        ...baseProject,
        validation_status: 'NOT_READY',
        validation_summary_json: null,
      },
      documents: [
        buildDocument({
          id: 'doc-contract-1',
          title: 'Prime Contract',
          name: 'prime-contract.pdf',
          document_type: 'contract',
        }),
      ],
      documentReviews: [],
      decisions: [
        {
          id: 'legacy-contract-decision-1',
          document_id: 'doc-contract-1',
          source: 'deterministic',
          decision_type: 'contract_pricing_review',
          title: 'Contract pricing language needs review',
          summary: 'Legacy contract intelligence flagged ambiguous pricing language.',
          severity: 'high',
          status: 'open',
          confidence: 0.88,
          last_detected_at: '2026-04-10T00:00:00Z',
          created_at: '2026-04-10T00:00:00Z',
          due_at: null,
          assigned_to: null,
          details: {
            document_family: 'contract',
            problem: 'Contract pricing language is ambiguous.',
            impact: 'Legacy intelligence would previously surface this as an approval decision.',
            required_action: 'Review the contract pricing language.',
          },
          assignee: null,
          documents: {
            id: 'doc-contract-1',
            project_id: 'project-1',
            title: 'Prime Contract',
            name: 'prime-contract.pdf',
            document_type: 'contract',
          },
        },
      ],
      tasks: [],
      activityEvents: [],
      members: [],
    });

    const issueObjects = resolveProjectIssueObjects({
      projectId: baseProject.id,
      findings: [],
      decisions: [],
    });
    const decisionCards = resolveProjectIssueObjectDecisionSummary(
      issueObjects,
      [],
      [],
      baseProject.id,
    );

    assert.equal(model.decision_total, 0);
    assert.equal(decisionCards.length, 0);
    assert.match(
      model.decision_empty_state,
      /Validator has not produced decision outputs yet/,
    );
  });

  it('shows validator-backed decisions and hides legacy intelligence decisions from the active Decisions surface', () => {
    const model = buildProjectOverviewModel({
      project: {
        ...baseProject,
        validation_status: 'BLOCKED',
        validation_summary_json: {
          validator_status: 'BLOCKED',
          critical_count: 1,
          warning_count: 0,
          open_count: 1,
        },
      },
      documents: [
        buildDocument({
          id: 'doc-invoice-1',
          title: 'Invoice 2026-003',
          name: 'invoice-2026-003.pdf',
          document_type: 'invoice',
        }),
      ],
      documentReviews: [],
      decisions: [
        {
          id: 'legacy-contract-decision-1',
          document_id: 'doc-invoice-1',
          source: 'deterministic',
          decision_type: 'contract_pricing_review',
          title: 'Legacy contract review',
          summary: 'Legacy contract intelligence decision.',
          severity: 'high',
          status: 'open',
          confidence: 0.75,
          last_detected_at: '2026-04-10T00:00:00Z',
          created_at: '2026-04-10T00:00:00Z',
          due_at: null,
          assigned_to: null,
          details: {
            document_family: 'contract',
            problem: 'Legacy contract issue.',
            impact: 'Legacy contract impact.',
            required_action: 'Review legacy contract issue.',
          },
          assignee: null,
          documents: {
            id: 'doc-invoice-1',
            project_id: 'project-1',
            title: 'Invoice 2026-003',
            name: 'invoice-2026-003.pdf',
            document_type: 'invoice',
          },
        },
        {
          id: 'validator-decision-1',
          document_id: 'doc-invoice-1',
          source: 'project_validator',
          decision_type: 'validator_invoice_approval',
          title: 'Invoice 2026-003 cannot be approved',
          summary: 'Validator-backed invoice approval decision.',
          severity: 'critical',
          status: 'open',
          confidence: 1,
          last_detected_at: '2026-04-11T00:00:00Z',
          created_at: '2026-04-11T00:00:00Z',
          due_at: null,
          assigned_to: null,
          details: {
            origin: 'project_validator',
            source_label: 'Validator output',
            problem: 'Invoice 2026-003 includes unsupported billed amount.',
            impact: '$40,802.25 is blocking approval.',
            required_action: 'Resolve the unsupported billed amount on this invoice before payment approval proceeds.',
            validator_finding_ids: ['finding-1'],
            evidence_refs: ['record:invoice-line-1'],
          },
          assignee: null,
          documents: {
            id: 'doc-invoice-1',
            project_id: 'project-1',
            title: 'Invoice 2026-003',
            name: 'invoice-2026-003.pdf',
            document_type: 'invoice',
          },
        },
      ],
      tasks: [],
      activityEvents: [],
      members: [],
    });

    const issueObjects = resolveProjectIssueObjects({
      projectId: baseProject.id,
      findings: [
        buildValidationFinding({
          id: 'finding-1',
          linked_decision_id: 'validator-decision-1',
        }),
      ],
      decisions: [
        {
          id: 'validator-decision-1',
          project_id: baseProject.id,
          document_id: 'doc-invoice-1',
          source: 'project_validator',
          decision_type: 'validator_invoice_approval',
          title: 'Invoice 2026-003 cannot be approved',
          summary: 'Validator-backed invoice approval decision.',
          severity: 'critical',
          status: 'open',
          confidence: 1,
          last_detected_at: '2026-04-11T00:00:00Z',
          created_at: '2026-04-11T00:00:00Z',
          due_at: null,
          assigned_to: null,
          details: {
            origin: 'project_validator',
            source_label: 'Validator output',
            validator_finding_ids: ['finding-1'],
            evidence_refs: ['record:invoice-line-1'],
          },
        },
      ],
    });
    const decisionCards = resolveProjectIssueObjectDecisionSummary(
      issueObjects,
      [],
      [],
      baseProject.id,
    );

    assert.equal(model.decision_total, 1);
    assert.equal(decisionCards.length, 1);
    assert.equal(decisionCards[0]?.title, 'Invoice 2026-003 cannot be approved');
    assert.ok(decisionCards[0]?.source_evidence_label.includes('Validator output'));
  });

  it('preserves decision-card count, order, titles, statuses, IDs, evidence, and provenance through issue objects', () => {
    const decisions: ProjectDecisionRow[] = [
      {
        id: 'decision-warning',
        project_id: baseProject.id,
        document_id: 'doc-invoice-1',
        source: 'project_validator',
        decision_type: 'validator_invoice_warning',
        title: 'Verify invoice support',
        summary: 'Support requires review.',
        severity: 'warning',
        status: 'in_review',
        confidence: 0.9,
        last_detected_at: '2026-04-12T00:00:00Z',
        created_at: '2026-04-12T00:00:00Z',
        due_at: null,
        assigned_to: null,
        details: {
          origin: 'project_validator',
          validator_finding_ids: ['finding-warning'],
          evidence_refs: ['record:invoice-line-warning'],
          source_label: 'Validator output',
        },
      },
      {
        id: 'decision-critical',
        project_id: baseProject.id,
        document_id: 'doc-invoice-1',
        source: 'project_validator',
        decision_type: 'validator_invoice_approval',
        title: 'Invoice cannot be approved',
        summary: 'Unsupported amount blocks approval.',
        severity: 'critical',
        status: 'open',
        confidence: 1,
        last_detected_at: '2026-04-11T00:00:00Z',
        created_at: '2026-04-11T00:00:00Z',
        due_at: null,
        assigned_to: null,
        details: {
          origin: 'project_validator',
          validator_finding_ids: ['finding-critical'],
          evidence_refs: ['record:invoice-line-critical'],
          source_label: 'Validator output',
        },
      },
      {
        id: 'decision-resolved',
        project_id: baseProject.id,
        document_id: 'doc-invoice-1',
        source: 'project_validator',
        decision_type: 'validator_invoice_resolved',
        title: 'Resolved invoice review',
        summary: 'Review is complete.',
        severity: 'low',
        status: 'resolved',
        confidence: 1,
        last_detected_at: '2026-04-10T00:00:00Z',
        created_at: '2026-04-10T00:00:00Z',
        due_at: null,
        assigned_to: null,
        details: {
          origin: 'project_validator',
          validator_finding_ids: ['finding-resolved'],
          evidence_refs: ['record:invoice-line-resolved'],
          source_label: 'Validator output',
        },
      },
      {
        id: 'legacy-supporting-decision',
        project_id: baseProject.id,
        document_id: null,
        source: 'deterministic',
        decision_type: 'contract_pricing_review',
        title: 'Legacy pricing context',
        summary: 'Supporting context only.',
        severity: 'high',
        status: 'open',
        confidence: 0.8,
        last_detected_at: '2026-04-08T00:00:00Z',
        created_at: '2026-04-08T00:00:00Z',
        due_at: null,
        assigned_to: null,
        details: {
          document_family: 'contract',
          evidence_refs: ['contract:pricing'],
        },
      },
    ];
    const model = buildProjectOverviewModel({
      project: baseProject,
      documents: [],
      documentReviews: [],
      decisions,
      tasks: [],
      activityEvents: [],
      members: [],
    });
    const issueObjects = resolveProjectIssueObjects({
      projectId: baseProject.id,
      findings: [
        buildValidationFinding({
          id: 'finding-warning',
          linked_decision_id: 'decision-warning',
          severity: 'warning',
        }),
        buildValidationFinding({
          id: 'finding-critical',
          linked_decision_id: 'decision-critical',
        }),
        buildValidationFinding({
          id: 'finding-resolved',
          linked_decision_id: 'decision-resolved',
          status: 'resolved',
          resolved_at: '2026-04-13T00:00:00Z',
        }),
      ],
      decisions,
    });

    const legacyCards = model.decisions.filter(
      (decision) => decision.status_key === 'open' || decision.status_key === 'in_review',
    );
    const unifiedCards = resolveProjectIssueObjectDecisionSummary(
      issueObjects,
      [],
      [],
      baseProject.id,
    );

    assert.deepEqual(
      unifiedCards.map((decision) => ({
        id: decision.id,
        title: decision.title,
        status: decision.status_key,
        evidenceRefs: decision.evidence_refs,
        sourceEvidenceLabel: decision.source_evidence_label,
      })),
      legacyCards.map((decision) => ({
        id: decision.id,
        title: decision.title,
        status: decision.status_key,
        evidenceRefs: decision.evidence_refs,
        sourceEvidenceLabel: decision.source_evidence_label,
      })),
    );
    assert.deepEqual(unifiedCards, legacyCards);
    assert.ok(unifiedCards.every((decision) => decision.id !== 'legacy-supporting-decision'));
  });

  it('builds audit events as a project history trail from canonical activity sources', () => {
    const document = buildDocument({
      id: 'doc-audit',
      title: 'March Invoice',
      name: 'march-invoice.pdf',
      created_at: '2026-03-20T00:00:00Z',
      processed_at: '2026-03-20T01:00:00Z',
    });
    const activityEvents: ProjectActivityEventRow[] = [
      {
        id: 'validation-1',
        project_id: 'project-1',
        entity_type: 'project_validation_run',
        entity_id: 'validation-run-1',
        event_type: 'validation_run_completed',
        old_value: null,
        new_value: {
          status: 'BLOCKED',
          critical_count: 2,
          warning_count: 1,
          new_findings: 2,
          resolved_findings: 1,
          rules_applied: ['rule-1', 'rule-2'],
          rule_version: 'validator:v3',
        },
        changed_by: null,
        created_at: '2026-03-20T03:00:00Z',
      },
      {
        id: 'decision-review',
        project_id: 'project-1',
        entity_type: 'decision',
        entity_id: 'decision-1',
        event_type: 'status_changed',
        old_value: { status: 'open' },
        new_value: { status: 'in_review' },
        changed_by: 'member-1',
        created_at: '2026-03-20T02:00:00Z',
      },
      {
        id: 'task-complete',
        project_id: 'project-1',
        entity_type: 'workflow_task',
        entity_id: 'task-1',
        event_type: 'status_changed',
        old_value: { status: 'in_progress' },
        new_value: { status: 'completed' },
        changed_by: 'member-1',
        created_at: '2026-03-20T02:30:00Z',
      },
    ];

    const audit = resolveProjectAuditEvents(
      baseProject,
      [document],
      [
        {
          id: 'decision-1',
          document_id: null,
          decision_type: 'support_gap',
          title: 'Missing invoice support',
          summary: null,
          severity: 'critical',
          status: 'open',
          confidence: null,
          last_detected_at: null,
          created_at: '2026-03-20T00:00:00Z',
          due_at: null,
          assigned_to: null,
        },
      ],
      [
        {
          id: 'task-1',
          decision_id: null,
          document_id: null,
          task_type: 'review_support',
          title: 'Review missing invoice support',
          description: null,
          priority: 'high',
          status: 'completed',
          created_at: '2026-03-20T00:00:00Z',
          updated_at: '2026-03-20T00:00:00Z',
          due_at: null,
          assigned_to: null,
        },
      ],
      activityEvents,
      [],
    );

    assert.equal(audit[0]?.label, 'Validation run');
    assert.equal(audit[0]?.source_label, 'Validator snapshot');
    assert.equal(audit[1]?.label, 'Action completed');
    assert.equal(audit[1]?.object_label, 'Review missing invoice support');
    assert.equal(audit[2]?.label, 'Decision moved to review');
    assert.equal(audit[2]?.object_label, 'Missing invoice support');
    assert.equal(audit[3]?.label, 'Document processed');
    assert.equal(audit[3]?.source_label, 'Processing record');
  });

  it('surfaces canonical truth mutation events in the audit trail', () => {
    const document = buildDocument({
      id: 'doc-truth',
      title: 'Master Contract',
      name: 'master-contract.pdf',
      created_at: '2026-03-20T00:00:00Z',
      processed_at: null,
    });
    const activityEvents: ProjectActivityEventRow[] = [
      {
        id: 'relationship-1',
        project_id: 'project-1',
        entity_type: 'document',
        entity_id: 'doc-truth',
        event_type: 'document_relationship_changed',
        old_value: null,
        new_value: {
          source_document_title: 'Amendment 2',
          target_document_title: 'Master Contract',
          relationship_type: 'amends',
        },
        changed_by: 'member-1',
        created_at: '2026-03-20T04:00:00Z',
      },
      {
        id: 'precedence-1',
        project_id: 'project-1',
        entity_type: 'project',
        entity_id: 'project-1',
        event_type: 'document_precedence_changed',
        old_value: {
          family_label: 'Invoice',
          precedence_mode: 'manual',
        },
        new_value: {
          family_label: 'Invoice',
          precedence_mode: 'automatic',
        },
        changed_by: 'member-1',
        created_at: '2026-03-20T03:00:00Z',
      },
      {
        id: 'governing-1',
        project_id: 'project-1',
        entity_type: 'document',
        entity_id: 'doc-truth',
        event_type: 'governing_document_changed',
        old_value: {
          family_label: 'Contract',
          governing_document_title: 'Legacy Contract',
        },
        new_value: {
          family_label: 'Contract',
          governing_document_title: 'Master Contract',
        },
        changed_by: 'member-1',
        created_at: '2026-03-20T02:00:00Z',
      },
      {
        id: 'review-1',
        project_id: 'project-1',
        entity_type: 'document',
        entity_id: 'doc-truth',
        event_type: 'review_correction_applied',
        old_value: null,
        new_value: {
          field_key: 'invoice_total',
          notes: 'Updated from reviewed cover sheet.',
          document_title: 'Master Contract',
        },
        changed_by: 'member-1',
        created_at: '2026-03-20T01:30:00Z',
      },
      {
        id: 'override-1',
        project_id: 'project-1',
        entity_type: 'document',
        entity_id: 'doc-truth',
        event_type: 'override_applied',
        old_value: null,
        new_value: {
          field_key: 'nte_amount',
          reason: 'Signed amendment corrected the ceiling.',
          document_title: 'Master Contract',
        },
        changed_by: 'member-1',
        created_at: '2026-03-20T01:00:00Z',
      },
    ];

    const audit = resolveProjectAuditEvents(
      baseProject,
      [document],
      [],
      [],
      activityEvents,
      [],
    );

    assert.equal(audit[0]?.label, 'Document relationship recorded');
    assert.equal(audit[0]?.source_label, 'Document relationship');
    assert.equal(audit[0]?.detail, 'Amendment 2 now has the "Modifies Contract" link to Master Contract.');
    assert.equal(audit[1]?.label, 'Document precedence changed');
    assert.equal(audit[1]?.detail, 'Invoice reverted to automatic precedence ordering.');
    assert.equal(audit[2]?.label, 'Governing document changed');
    assert.equal(audit[3]?.label, 'Review correction applied');
    assert.equal(audit[3]?.source_label, 'Fact review / Invoice Total');
    assert.equal(audit[4]?.label, 'Override applied');
    assert.equal(audit[4]?.source_label, 'Fact override / Nte Amount');
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
  const unsupportedAmount = invoices.reduce(
    (sum, invoice) => sum + Math.max(0, (invoice.billed_amount ?? 0) - (invoice.supported_amount ?? 0)),
    0,
  );
  return {
    status: 'BLOCKED',
    critical_count: 0,
    warning_count: 0,
    requires_review_count: 0,
    info_count: 0,
    open_count: 0,
    required_review_total: blocked.length,
    blocked_reasons: [],
    trigger_source: null,
    nte_amount: null,
    total_billed: invoices.reduce((s, i) => s + (i.billed_amount ?? 0), 0),
    total_at_risk: invoices.reduce((s, i) => s + (i.at_risk_amount ?? 0), 0),
    requires_verification_amount:
      requiresVerificationAmount > 0 ? requiresVerificationAmount : null,
    unsupported_amount: unsupportedAmount > 0 ? unsupportedAmount : null,
    validator_readiness: 'BLOCKED',
    reconciliation_overall: 'MISMATCH',
    invoice_summaries: invoices,
    approval_blocker_count: blocked.length,
    blocked_amount: blockedTotal > 0 ? blockedTotal : null,
  };
}

function buildValidationFinding(
  overrides: Partial<ValidationFinding> = {},
): ValidationFinding {
  return {
    id: overrides.id ?? 'finding-1',
    run_id: overrides.run_id ?? 'run-1',
    project_id: overrides.project_id ?? 'project-1',
    rule_id: overrides.rule_id ?? 'PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
    check_key: overrides.check_key ?? 'project.exposure.supported_amount',
    category: overrides.category ?? 'financial_integrity',
    severity: overrides.severity ?? 'critical',
    status: overrides.status ?? 'open',
    subject_type: overrides.subject_type ?? 'project',
    subject_id: overrides.subject_id ?? 'project-1',
    field: overrides.field ?? null,
    expected: overrides.expected ?? null,
    actual: overrides.actual ?? null,
    variance: overrides.variance ?? null,
    variance_unit: overrides.variance_unit ?? null,
    blocked_reason: overrides.blocked_reason ?? 'Missing support blocks approval.',
    finding_disposition: overrides.finding_disposition ?? 'blocker',
    business_severity: overrides.business_severity ?? 'critical',
    problem: overrides.problem ?? 'Unsupported billed amount remains open.',
    impact: overrides.impact ?? 'Approval cannot proceed until support is resolved.',
    required_action: overrides.required_action ?? 'Attach the missing support or reduce the billed amount.',
    evidence_refs: overrides.evidence_refs ?? ['invoice:2026-002'],
    source_family: overrides.source_family ?? 'support',
    affected_amount: overrides.affected_amount ?? 120000,
    approval_gate_effect: overrides.approval_gate_effect ?? 'blocks_approval',
    decision_eligible: overrides.decision_eligible ?? true,
    action_eligible: overrides.action_eligible ?? true,
    linked_decision_id: overrides.linked_decision_id ?? null,
    linked_action_id: overrides.linked_action_id ?? null,
    resolved_by_user_id: overrides.resolved_by_user_id ?? null,
    resolved_at: overrides.resolved_at ?? null,
    created_at: overrides.created_at ?? '2026-04-20T12:00:00Z',
    updated_at: overrides.updated_at ?? '2026-04-20T12:00:00Z',
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
