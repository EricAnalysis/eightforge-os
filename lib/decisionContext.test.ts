import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildDecisionCausalChain,
  buildDecisionContextRows,
  buildDecisionInvoiceStrip,
  resolveDecisionExecutionStatus,
} from '@/lib/decisionContext';
import type { DecisionAction } from '@/lib/types/documentIntelligence';

const primaryAction: DecisionAction = {
  id: 'action:review-support',
  type: 'confirm',
  target_object_type: 'invoice',
  target_object_id: 'invoice-1',
  target_label: 'Invoice INV-001',
  description: 'Review blocked support before approving payment.',
  expected_outcome: 'Blocked support is resolved or documented for approval.',
  resolvable: false,
};

describe('buildDecisionContextRows', () => {
  it('builds the requested invoice judgment rows in operator-first order', () => {
    const rows = buildDecisionContextRows({
      decisionDetails: {
        invoice_total: 25000,
        approval_status: 'blocked',
      },
      documentHref: '/platform/documents/doc-1',
      projectId: 'project-1',
      primaryAction,
      projectValidation: {
        validationStatus: 'FINDINGS_OPEN',
        validationSummary: {
          nte_amount: 100000,
          total_billed: 65000,
          requires_verification_amount: 1200,
          validator_status: 'NEEDS_REVIEW',
          exposure: {
            total_unreconciled_amount: 5000,
          },
        },
      },
    });

    assert.deepEqual(
      rows.map((row) => row.label),
      [
        'Contract ceiling',
        'Billed to date',
        'Invoice total',
        'Remaining capacity',
        'Requires verification amount',
        'At risk amount',
        'Validator state',
        'Approval gate state',
        'Next operator move',
      ],
    );

    assert.equal(rows[0]?.value, '$100,000');
    assert.equal(rows[0]?.sourceLabel, 'Contract document');
    assert.equal(rows[1]?.value, '$65,000');
    assert.equal(rows[1]?.sourceLabel, 'Validator/project rollup');
    assert.equal(rows[1]?.sourceHref, '/platform/projects/project-1#project-validator');
    assert.equal(rows[2]?.value, '$25,000');
    assert.equal(rows[2]?.sourceLabel, 'Invoice extraction');
    assert.equal(rows[2]?.sourceHref, '/platform/documents/doc-1');
    assert.equal(rows[3]?.value, '$75,000');
    assert.equal(rows[3]?.sourceLabel, 'Derived');
    assert.equal(rows[4]?.value, '$1,200');
    assert.equal(rows[4]?.sourceLabel, 'Queue finding');
    assert.equal(rows[4]?.sourceHref, '/platform/workspace/projects/project-1');
    assert.equal(rows[5]?.value, '$5,000');
    assert.equal(rows[5]?.sourceLabel, 'Validator finding');
    assert.equal(rows[6]?.value, 'Needs Review');
    assert.equal(rows[7]?.value, 'Requires Verification');
    assert.equal(rows[8]?.value, primaryAction.description);
    assert.equal(rows[8]?.nextAction, primaryAction.description);
    assert.equal(rows[8]?.actionImpact, 'Will unblock approval');
  });

  it('keeps billed to date separate from invoice total when only project rollup data exists', () => {
    const rows = buildDecisionContextRows({
      decisionDetails: {},
      documentHref: null,
      projectId: 'project-1',
      primaryAction: null,
      projectValidation: {
        validationStatus: 'READY',
        validationSummary: {
          total_billed: 120000,
        },
      },
    });

    const billedToDate = rows.find((row) => row.label === 'Billed to date');
    const invoiceTotal = rows.find((row) => row.label === 'Invoice total');
    const remainingCapacity = rows.find((row) => row.label === 'Remaining capacity');

    assert.equal(billedToDate?.value, '$120,000');
    assert.equal(invoiceTotal?.value, 'Awaiting invoice total');
    assert.equal(remainingCapacity?.value, 'Awaiting ceiling and invoice total');
  });

  it('uses the calm cumulative billing fallback when no prior billing truth is available', () => {
    const rows = buildDecisionContextRows({
      decisionDetails: {
        invoice_total: 18000,
      },
      documentHref: null,
      projectId: null,
      primaryAction: null,
      projectValidation: null,
    });

    const billedToDate = rows.find((row) => row.label === 'Billed to date');
    assert.equal(billedToDate?.value, 'Awaiting cumulative billing truth');
  });

  it('falls back to observed and expected decision values for contract ceiling decisions', () => {
    const rows = buildDecisionContextRows({
      decisionDetails: {
        field_key: 'billed_amount',
        rule_id: 'invoice_contract_ceiling_exceeded',
        observed_value: 18000,
        expected_value: 15000,
      },
      documentHref: null,
      projectId: null,
      primaryAction: null,
      projectValidation: null,
    });

    const contractCeiling = rows.find((row) => row.label === 'Contract ceiling');
    const invoiceTotal = rows.find((row) => row.label === 'Invoice total');
    const remainingCapacity = rows.find((row) => row.label === 'Remaining capacity');

    assert.equal(contractCeiling?.value, '$15,000');
    assert.equal(invoiceTotal?.value, '$18,000');
    assert.equal(remainingCapacity?.value, 'Over by $3,000');
    assert.equal(remainingCapacity?.validation, 'Requires Verification');
  });

  it('reuses the queue finding next step and execution state when validator context is present', () => {
    const rows = buildDecisionContextRows({
      decisionDetails: {
        approval_status: 'blocked',
      },
      documentHref: null,
      executionStatus: 'In progress',
      projectId: 'project-1',
      primaryAction: null,
      projectValidation: {
        validationStatus: 'BLOCKED',
        validationSummary: {},
      },
      queueFindingAction: {
        title: 'Rate 6A exceeds contract rate',
        approvalStatus: 'blocked',
        nextStep: 'Review contract rate schedule',
        impactedAmount: 80,
        atRiskAmount: null,
        requiresVerificationAmount: 80,
      },
      relatedTasks: [
        {
          id: 'task-1',
          status: 'open',
          title: 'Review contract rate schedule',
        },
      ],
    });

    const approvalGate = rows.find((row) => row.label === 'Approval gate state');
    const nextOperatorMove = rows.find((row) => row.label === 'Next operator move');

    assert.equal(approvalGate?.nextAction, 'Review contract rate schedule');
    assert.equal(approvalGate?.actionImpact, 'Will unblock approval');
    assert.equal(nextOperatorMove?.value, 'Review contract rate schedule');
    assert.equal(nextOperatorMove?.executionStatus, 'In progress');
  });

  it('uses the explicit operator fallbacks when no next action source is available', () => {
    const rows = buildDecisionContextRows({
      decisionDetails: {
        approval_status: 'approved',
      },
      documentHref: null,
      projectId: null,
      primaryAction: null,
      projectValidation: null,
    });

    const nextOperatorMove = rows.find((row) => row.label === 'Next operator move');
    assert.equal(nextOperatorMove?.value, 'Continue workflow');
  });
});

describe('buildDecisionInvoiceStrip', () => {
  it('renders the compact invoice strip only for invoice-related decisions', () => {
    const strip = buildDecisionInvoiceStrip({
      decisionDetails: {
        invoice_number: 'INV-001',
        invoice_total: 25000,
        validated_line_count: 8,
        requires_verification_line_count: 2,
        unreconciled_amount: 5000,
        approval_status: 'blocked',
      },
      primaryAction,
      projectValidation: {
        validationStatus: 'FINDINGS_OPEN',
        validationSummary: {},
      },
    });

    assert.deepEqual(
      strip?.map((item) => item.label),
      [
        'Invoice total',
        'Validated lines count',
        'Lines requiring verification',
        'Total variance',
        'Approval state',
      ],
    );
    assert.equal(strip?.[0]?.value, '$25,000');
    assert.equal(strip?.[1]?.value, '8 lines');
    assert.equal(strip?.[2]?.value, '2 lines');
    assert.equal(strip?.[3]?.value, '$5,000');
    assert.equal(strip?.[4]?.value, 'Requires Verification');
  });

  it('stays hidden when the decision has no invoice context', () => {
    const strip = buildDecisionInvoiceStrip({
      decisionDetails: {
        field_key: 'contract_ceiling',
      },
      primaryAction: null,
      projectValidation: null,
    });

    assert.equal(strip, null);
  });
});

describe('buildDecisionCausalChain', () => {
  it('builds the compact operating-system chain with existing project destinations', () => {
    const chain = buildDecisionCausalChain({
      decisionId: 'decision-1',
      decisionStatus: 'open',
      decisionDetails: {
        field_key: 'invoice_total',
        fact_refs: ['invoice:total_amount'],
        source_page: 3,
      },
      documentId: 'doc-1',
      hasStructuredEvidence: true,
      primaryAction,
      projectId: 'project-1',
      projectValidation: {
        validationStatus: 'FINDINGS_OPEN',
        validationSummary: {
          validator_status: 'NEEDS_REVIEW',
        },
      },
      relatedTasks: [
        { id: 'task-1', status: 'open' },
      ],
    });

    assert.deepEqual(
      chain.map((step) => step.label),
      ['Documents', 'Facts', 'Validator', 'Decision', 'Workflow'],
    );
    assert.equal(chain[0]?.stateLabel, 'Linked');
    assert.equal(chain[0]?.href, '/platform/projects/project-1#project-documents');
    assert.equal(
      chain[1]?.href,
      '/platform/documents/doc-1?source=project&projectId=project-1&page=3&factId=invoice%3Atotal_amount&fieldKey=invoice_total',
    );
    assert.equal(chain[1]?.stateLabel, 'Evidence Ready');
    assert.equal(chain[2]?.stateLabel, 'Needs Review');
    assert.equal(chain[2]?.href, '/platform/projects/project-1#project-validator');
    assert.equal(chain[3]?.state, 'current');
    assert.equal(chain[3]?.href, '/platform/decisions/decision-1');
    assert.equal(chain[4]?.stateLabel, 'Ready to Execute');
    assert.equal(chain[4]?.href, '/platform/decisions/decision-1');
  });

  it('shows calm incomplete states when the payload is missing operating context', () => {
    const chain = buildDecisionCausalChain({
      decisionId: 'decision-2',
      decisionStatus: 'suppressed',
      decisionDetails: null,
      documentId: null,
      hasStructuredEvidence: false,
      primaryAction: null,
      projectId: null,
      projectValidation: null,
      relatedTasks: [],
    });

    assert.equal(chain[0]?.stateLabel, 'Awaiting Source');
    assert.equal(chain[0]?.href, '/platform/documents');
    assert.equal(chain[1]?.stateLabel, 'Awaiting Document');
    assert.equal(chain[1]?.href, null);
    assert.equal(chain[2]?.stateLabel, 'Not Evaluated');
    assert.equal(chain[2]?.href, null);
    assert.equal(chain[3]?.stateLabel, 'Not Evaluated');
    assert.equal(chain[4]?.stateLabel, 'Awaiting Workflow');
    assert.equal(chain[4]?.href, '#decision-workflow');
  });
});

describe('resolveDecisionExecutionStatus', () => {
  it('maps open workflow records without execution logs to Not started', () => {
    const status = resolveDecisionExecutionStatus({
      tasks: [
        { id: 'task-1', status: 'open' },
      ],
      logs: [],
    });

    assert.equal(status, 'Not started');
  });

  it('maps approval-action activity to In progress until a task resolves', () => {
    const status = resolveDecisionExecutionStatus({
      tasks: [
        { id: 'task-1', status: 'open' },
      ],
      logs: [
        { taskId: 'task-1', taskOutcome: 'created' },
      ],
    });

    assert.equal(status, 'In progress');
  });

  it('maps resolved workflow records to Completed', () => {
    const status = resolveDecisionExecutionStatus({
      tasks: [
        { id: 'task-1', status: 'resolved' },
      ],
      logs: [
        { taskId: 'task-1', taskOutcome: 'updated' },
      ],
    });

    assert.equal(status, 'Completed');
  });
});
