import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { ValidationFinding } from '@/types/validator';
import {
  approvalStatusLabelForProjectFacts,
  deriveCanonicalProjectInvoiceApprovalStatus,
  resolveCanonicalProjectOverviewBriefing,
  resolveCanonicalProjectFacts,
  resolveCanonicalProjectTruthSections,
  resolveCanonicalProjectValidatorWorkspace,
  resolveCanonicalProjectValidationSnapshot,
  resolveValidationSummaryFromProjectFacts,
  spreadsheetReviewReadinessStatusForProjectFacts,
} from '@/lib/projectFacts';

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
    required_action: overrides.required_action ?? 'Attach support or reduce the billed amount.',
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

describe('resolveCanonicalProjectFacts', () => {
  it('normalizes the validator-backed project truth snapshot into one shared facts object', () => {
    const facts = resolveCanonicalProjectFacts({
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        last_run_at: '2026-04-20T15:30:00Z',
        critical_count: 2,
        warning_count: 3,
        info_count: 1,
        open_count: 6,
        blocked_reasons: ['Missing governing contract'],
        trigger_source: 'relationship_change',
        validator_status: 'BLOCKED',
        validator_open_items: [{
          rule_id: 'SOURCES_NO_CONTRACT',
          severity: 'critical',
          subject_type: 'project',
          subject_id: 'project-1',
          field: null,
          fact_keys: ['contract_ceiling'],
          message: 'No governing contract is linked.',
        }],
        contract_validation_context: {
          document_id: 'contract-doc-1',
        },
        contract_invoice_reconciliation: {
          matched_invoice_lines: 12,
          unmatched_invoice_lines: 1,
          rate_mismatches: 1,
          vendor_identity_status: 'MATCH',
          client_identity_status: 'MATCH',
          service_period_status: 'PARTIAL',
          invoice_total_status: 'MISMATCH',
        },
        nte_amount: 250000,
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
          invoices: [{
            invoice_number: 'INV-001',
            billed_amount: 25000,
            billed_amount_source: 'invoice_total',
            contract_supported_amount: 24000,
            transaction_supported_amount: 24000,
            fully_reconciled_amount: 23000,
            supported_amount: 24000,
            unreconciled_amount: 1000,
            at_risk_amount: 1000,
            requires_verification_amount: 1000,
            reconciliation_status: 'PARTIAL',
          }],
        },
        reconciliation: {
          overall_reconciliation_status: 'PARTIAL',
        },
      },
    });

    assert.equal(facts.status, 'FINDINGS_OPEN');
    assert.equal(facts.validator_status, 'BLOCKED');
    assert.equal(facts.contract_document_id, 'contract-doc-1');
    assert.equal(facts.nte_amount, 250000);
    assert.equal(facts.total_billed, 100000);
    assert.equal(facts.total_at_risk, 10000);
    assert.equal(facts.requires_verification_amount, 7000);
    assert.equal(facts.reconciliation_overall, 'PARTIAL');
    assert.equal(facts.contract_invoice_reconciliation?.invoice_total_status, 'MISMATCH');
    assert.equal(facts.validator_open_items.length, 1);
    assert.equal(facts.exposure?.invoices[0]?.invoice_number, 'INV-001');
  });

  it('falls back to normalized status labels even when only high-level status is present', () => {
    const facts = resolveCanonicalProjectFacts({
      validationStatus: 'VALIDATED',
      validationSummary: null,
    });

    assert.equal(approvalStatusLabelForProjectFacts(facts), 'Approved');
    assert.equal(facts.total_billed, null);
    assert.equal(facts.validator_status, null);
  });

  it('overlays live unresolved validator findings onto persisted validator amounts', () => {
    const facts = resolveCanonicalProjectFacts({
      validationStatus: 'VALIDATED',
      validationSummary: {
        validator_status: 'READY',
        critical_count: 0,
        warning_count: 0,
        open_count: 0,
        at_risk_amount: 24000,
        requires_verification_amount: 12000,
      },
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

    assert.equal(facts.status, 'BLOCKED');
    assert.equal(facts.validator_status, 'BLOCKED');
    assert.equal(facts.critical_count, 1);
    assert.equal(facts.warning_count, 0);
    assert.equal(facts.requires_review_count, 1);
    assert.equal(facts.total_at_risk, 24000);
    assert.equal(facts.requires_verification_amount, 12000);
  });

  it('keeps fallback behavior when validator summary and live findings are absent', () => {
    const facts = resolveCanonicalProjectFacts({
      validationStatus: 'NOT_READY',
      validationSummary: null,
      validationFindings: [],
    });

    assert.equal(facts.status, 'NOT_READY');
    assert.equal(facts.validator_status, null);
    assert.equal(facts.critical_count, 0);
    assert.equal(facts.open_count, 0);
    assert.equal(approvalStatusLabelForProjectFacts(facts), 'Not Evaluated');
  });

  it('derives one shared invoice approval view from canonical exposure facts', () => {
    const snapshot = resolveCanonicalProjectValidationSnapshot({
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        exposure: {
          total_billed_amount: 50000,
          total_contract_supported_amount: 45000,
          total_transaction_supported_amount: 45000,
          total_fully_reconciled_amount: 43000,
          total_unreconciled_amount: 7000,
          total_at_risk_amount: 7000,
          total_requires_verification_amount: 7000,
          support_gap_tolerance_amount: 500,
          at_risk_tolerance_amount: 500,
          moderate_severity: 'warning',
          invoices: [
            {
              invoice_number: 'INV-BLOCKED',
              billed_amount: 25000,
              billed_amount_source: 'invoice_total',
              contract_supported_amount: 20000,
              transaction_supported_amount: 20000,
              fully_reconciled_amount: 18000,
              supported_amount: 20000,
              unreconciled_amount: 5000,
              at_risk_amount: 5000,
              requires_verification_amount: 5000,
              reconciliation_status: 'MISMATCH',
            },
            {
              invoice_number: 'INV-PARTIAL',
              billed_amount: 25000,
              billed_amount_source: 'invoice_total',
              contract_supported_amount: 25000,
              transaction_supported_amount: 25000,
              fully_reconciled_amount: 25000,
              supported_amount: 25000,
              unreconciled_amount: 2000,
              at_risk_amount: 2000,
              requires_verification_amount: 0,
              reconciliation_status: 'PARTIAL',
            },
          ],
        },
      },
    });

    assert.equal(snapshot.invoice_summaries[0]?.approval_status, 'blocked');
    assert.equal(snapshot.invoice_summaries[1]?.approval_status, 'approved_with_exceptions');
    assert.equal(snapshot.blocked_amount, 25000);
  });

  it('builds validator-ready summaries from the shared canonical facts resolver', () => {
    const summary = resolveValidationSummaryFromProjectFacts({
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        validation_phase: 'billing_review',
        validator_status: 'BLOCKED',
        critical_count: 2,
        warning_count: 1,
        open_count: 3,
        blocked_reasons: ['Invoice mismatch'],
      },
      fallback: {
        info_count: 4,
        validator_status: 'NEEDS_REVIEW',
      },
    });

    assert.equal(summary.status, 'FINDINGS_OPEN');
    assert.equal(summary.validator_status, 'BLOCKED');
    assert.equal(summary.critical_count, 2);
    assert.equal(summary.warning_count, 1);
    assert.equal(summary.info_count, 0);
    assert.equal(summary.validation_phase, 'billing_review');
    assert.deepEqual(summary.blocked_reasons, ['Invoice mismatch']);
  });

  it('projects cross-document rate verification through shared canonical facts', () => {
    const facts = resolveCanonicalProjectFacts({
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        cross_document_rate_verification: {
          comparable_units: 2,
          matched_units: 1,
          rate_mismatch_units: 1,
          category_mismatch_units: 0,
          missing_contract_rate_units: 0,
          missing_support_units: 0,
          unsupported_work_units: 0,
          needs_review_units: 0,
          validation_units: [{
            validation_unit_id: 'cross_rate:line-1',
            invoice_line_id: 'line-1',
            invoice_number: 'INV-1',
            billing_rate_key: 'TREE25',
            canonical_category: 'tree_operations',
            category_confidence: 0.88,
            category_basis: 'descriptor',
            invoice_source_descriptor: 'Hazardous Tree 25 36 in',
            invoice_rate: 350,
            contract_rate_found: true,
            contract_rate: 315,
            contract_source_category: 'Tree Operations',
            contract_source_descriptor: 'Hazardous Tree 25 36 in',
            supported_quantity: 1,
            support_row_count: 1,
            support_basis: 'invoice_linked',
            support_families: ['mobile_unit_ticket'],
            support_observed_categories: ['tree_operations'],
            comparison_status: 'rate_mismatch',
            reason: 'Invoice unit rate does not match the governing contract rate.',
            source_documents: {
              invoice_document_id: 'invoice-doc',
              contract_document_ids: ['contract-doc'],
              support_document_ids: ['support-doc'],
            },
            source_rows: {
              invoice_record_id: 'line-1',
              contract_record_ids: ['rate-1'],
              support_record_ids: ['unit-1'],
            },
          }],
        },
      },
    });

    assert.equal(facts.cross_document_rate_verification?.comparable_units, 2);
    assert.equal(
      facts.cross_document_rate_verification?.validation_units[0]?.comparison_status,
      'rate_mismatch',
    );

    const workspace = resolveCanonicalProjectValidatorWorkspace({
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        cross_document_rate_verification: facts.cross_document_rate_verification,
      },
    });

    assert.equal(
      workspace.relationship_blocks.some((block) => block.key === 'cross_document_rate'),
      true,
    );
  });

  it('shares one invoice approval mapping across consumers', () => {
    assert.equal(
      deriveCanonicalProjectInvoiceApprovalStatus('MISMATCH', 10),
      'blocked',
    );
    assert.equal(
      deriveCanonicalProjectInvoiceApprovalStatus('PARTIAL', 5),
      'needs_review',
    );
    assert.equal(
      deriveCanonicalProjectInvoiceApprovalStatus('PARTIAL', 0),
      'approved_with_exceptions',
    );
  });

  it('derives spreadsheet review readiness from the shared project facts resolver', () => {
    const facts = resolveCanonicalProjectFacts({
      validationStatus: 'BLOCKED',
      validationSummary: {
        validator_status: 'BLOCKED',
      },
    });

    assert.equal(
      spreadsheetReviewReadinessStatusForProjectFacts({
        facts,
        fallback: 'ready',
      }),
      'needs_review',
    );
  });

  it('builds a canonical project truth sheet for the Forge Facts tab', () => {
    const sections = resolveCanonicalProjectTruthSections({
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        validator_status: 'BLOCKED',
        critical_count: 2,
        warning_count: 1,
        open_count: 3,
        nte_amount: 250000,
        contract_validation_context: {
          document_id: 'contract-doc-1',
          analysis: {
            contract_identity: {
              effective_date: {
                value: '2026-02-09',
                state: 'explicit',
                source_fact_ids: ['effective_date'],
              },
            },
            term_model: {
              expiration_date: {
                value: '2026-12-31',
                state: 'derived',
                source_fact_ids: ['expiration_date'],
              },
            },
            pricing_model: {
              rate_schedule_present: {
                value: true,
                state: 'explicit',
                source_fact_ids: ['rate_schedule_present'],
              },
              rate_schedule_pages: {
                value: 7,
                state: 'explicit',
                source_fact_ids: ['rate_schedule_pages'],
              },
            },
          },
        },
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
          invoices: [{
            invoice_number: 'INV-001',
            billed_amount: 25000,
            billed_amount_source: 'invoice_total',
            contract_supported_amount: 24000,
            transaction_supported_amount: 24000,
            fully_reconciled_amount: 23000,
            supported_amount: 24000,
            unreconciled_amount: 1000,
            at_risk_amount: 1000,
            requires_verification_amount: 1000,
            reconciliation_status: 'PARTIAL',
          }],
        },
      },
      documents: [{
        id: 'contract-doc-1',
        title: 'Golden Project Governing Contract',
        name: 'golden-contract.pdf',
      }],
      transactionDatasets: [{
        document_id: 'tx-doc-1',
        row_count: 18,
        date_range_start: '2026-03-01',
        date_range_end: '2026-03-15',
        created_at: '2026-04-20T10:00:00Z',
        summary_json: {
          project_operations_overview: {
            total_tickets: 14,
            total_cyd: 260,
            eligible_count: 12,
            ineligible_count: 2,
            total_invoiced_amount: 98500,
          },
        },
      }],
    });

    assert.deepEqual(
      sections.map((section) => section.title),
      ['Contract Truth', 'Invoice Truth', 'Transaction Truth', 'Validation Truth'],
    );

    const contractRows = sections.find((section) => section.key === 'contract')?.rows ?? [];
    assert.equal(contractRows.find((row) => row.key === 'governing_contract')?.value, 'Golden Project Governing Contract');
    assert.equal(contractRows.find((row) => row.key === 'rate_schedule')?.value, 'Present (7 pages)');

    const invoiceRows = sections.find((section) => section.key === 'invoice')?.rows ?? [];
    const transactionRows = sections.find((section) => section.key === 'transaction')?.rows ?? [];
    assert.equal(invoiceRows.find((row) => row.key === 'billed_amount')?.label, 'Invoice Billed Amount');
    assert.equal(transactionRows.find((row) => row.key === 'ticket_records')?.value, '18');
    assert.equal(transactionRows.find((row) => row.key === 'ticket_records')?.label, 'Total Transaction Rows');
    assert.equal(transactionRows.find((row) => row.key === 'unique_tickets')?.value, '14');
    assert.equal(transactionRows.find((row) => row.key === 'unique_tickets')?.label, 'Unique Ticket Numbers');
    assert.equal(transactionRows.find((row) => row.key === 'volume')?.value, '260 CYD');
    assert.equal(transactionRows.find((row) => row.key === 'total_invoiced_amount')?.label, 'Workbook Invoiced Amount');

    const validationRows = sections.find((section) => section.key === 'validation')?.rows ?? [];
    assert.equal(validationRows.find((row) => row.key === 'blockers')?.value, '2');
    assert.equal(validationRows.find((row) => row.key === 'at_risk_amount')?.label, 'At Risk Amount');
  });

  it('uses live unresolved validator findings for Facts validation truth when persisted counts are stale', () => {
    const sections = resolveCanonicalProjectTruthSections({
      validationStatus: 'VALIDATED',
      validationSummary: {
        validator_status: 'READY',
        critical_count: 0,
        warning_count: 0,
        open_count: 0,
        at_risk_amount: 18000,
      },
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

    const validationRows = sections.find((section) => section.key === 'validation')?.rows ?? [];
    assert.equal(validationRows.find((row) => row.key === 'validation_status')?.value, 'Blocked');
    assert.equal(validationRows.find((row) => row.key === 'approval_readiness')?.value, 'Blocked');
    assert.equal(validationRows.find((row) => row.key === 'blockers')?.value, '1');
    assert.equal(validationRows.find((row) => row.key === 'warnings')?.value, '1');
    assert.equal(validationRows.find((row) => row.key === 'at_risk_amount')?.value, '$18,000');
    assert.equal(
      validationRows.find((row) => row.key === 'requires_verification_amount')?.value,
      '2 findings',
    );
  });

  it('prefers the primary approval decision for approval status and exposure amounts', () => {
    const sections = resolveCanonicalProjectTruthSections({
      validationStatus: 'VALIDATED',
      validationSummary: {
        validator_status: 'READY',
        critical_count: 0,
        warning_count: 0,
        open_count: 0,
        total_billed: 815559.35,
        at_risk_amount: 0,
        unsupported_amount: 0,
        requires_verification_amount: 0,
      },
      decisions: [{
        id: 'decision-primary-project',
        title: 'Project approval status',
        summary: 'Approval is blocked.',
        decision_type: 'validator_project_approval',
        status: 'open',
        severity: 'critical',
        source: 'project_validator',
        details: {
          primary_approval_decision: true,
          approval_context: 'project',
          approval_status: 'blocked',
          gate_approval_status: 'blocked',
          blocked_amount: 35559.35,
          unsupported_amount: 35559.35,
          at_risk_amount: 35559.35,
          requires_verification_amount: 35559.35,
          required_reviews: 2,
          blocking_reasons: ['Unsupported invoice amount requires review'],
          source_validator_run_id: 'run-1',
        },
      }],
    });

    const validationRows = sections.find((section) => section.key === 'validation')?.rows ?? [];
    assert.equal(validationRows.find((row) => row.key === 'approval_readiness')?.value, 'Blocked');
    assert.equal(validationRows.find((row) => row.key === 'blocked_amount')?.value, '$35,559.35');
    assert.equal(validationRows.find((row) => row.key === 'unsupported_amount')?.value, '$35,559.35');
    assert.equal(validationRows.find((row) => row.key === 'at_risk_amount')?.value, '$35,559.35');
  });

  it('builds a validator workspace from canonical project facts without local reparsing', () => {
    const workspace = resolveCanonicalProjectValidatorWorkspace({
      validationStatus: 'BLOCKED',
      validationSummary: {
        validator_status: 'BLOCKED',
        critical_count: 2,
        warning_count: 3,
        open_count: 5,
        total_billed: 100000,
        contract_invoice_reconciliation: {
          matched_invoice_lines: 9,
          unmatched_invoice_lines: 2,
          rate_mismatches: 1,
          vendor_identity_status: 'MATCH',
          client_identity_status: 'MATCH',
          service_period_status: 'PARTIAL',
          invoice_total_status: 'MISMATCH',
        },
        invoice_transaction_reconciliation: {
          matched_groups: 8,
          unmatched_groups: 2,
          cost_mismatches: 1,
          quantity_mismatches: 0,
          orphan_transactions: 1,
          outlier_rows: 0,
        },
        exposure: {
          total_billed_amount: 100000,
          total_contract_supported_amount: 92000,
          total_transaction_supported_amount: 90000,
          total_fully_reconciled_amount: 87000,
          total_unreconciled_amount: 13000,
          total_at_risk_amount: 13000,
          total_requires_verification_amount: 7000,
          support_gap_tolerance_amount: 500,
          at_risk_tolerance_amount: 500,
          moderate_severity: 'warning',
          invoices: [
            {
              invoice_number: 'INV-001',
              billed_amount: 60000,
              billed_amount_source: 'invoice_total',
              contract_supported_amount: 56000,
              transaction_supported_amount: 55000,
              fully_reconciled_amount: 52000,
              supported_amount: 55000,
              unreconciled_amount: 5000,
              at_risk_amount: 5000,
              requires_verification_amount: 3000,
              reconciliation_status: 'PARTIAL',
            },
            {
              invoice_number: 'INV-002',
              billed_amount: 40000,
              billed_amount_source: 'invoice_total',
              contract_supported_amount: 36000,
              transaction_supported_amount: 35000,
              fully_reconciled_amount: 35000,
              supported_amount: 35000,
              unreconciled_amount: 5000,
              at_risk_amount: 8000,
              requires_verification_amount: 4000,
              reconciliation_status: 'MISMATCH',
            },
          ],
        },
        contract_validation_context: {
          document_id: 'contract-doc-1',
          analysis: {
            pricing_model: {
              rate_schedule_present: {
                value: true,
                state: 'explicit',
                source_fact_ids: ['rate_schedule_present'],
              },
            },
          },
        },
      },
      documents: [
        {
          id: 'contract-doc-1',
          title: 'Master Services Agreement',
          name: 'msa.pdf',
          document_type: 'contract',
          intelligence_trace: {
            facts: {
              contract_ceiling: 250000,
            },
            contract_analysis: {
              term_model: {
                expiration_date: {
                  value: '2026-12-31',
                  state: 'explicit',
                  source_fact_ids: ['expiration_date'],
                },
              },
            },
          },
        },
      ],
    });

    assert.equal(workspace.status_items[0]?.key, 'approval_status');
    assert.equal(workspace.status_items[0]?.value, 'Blocked');
    assert.equal(workspace.status_items[5]?.key, 'unsupported_amount');
    assert.equal(workspace.status_items[5]?.value, '$13,000');
    assert.deepEqual(
      workspace.relationship_blocks.map((block) => block.key),
      ['contract_invoice', 'invoice_transaction', 'invoice_support'],
    );
    assert.ok(
      workspace.relationship_blocks[0]?.mismatches.some((mismatch) => mismatch.key === 'invoice_totals'),
    );
    assert.ok(
      workspace.coverage_items.some((item) => item.key === 'incomplete_evidence' && item.value === '$7,000'),
    );
  });

  it('fills contract and invoice truth from canonical document traces when summary data is partial', () => {
    const sections = resolveCanonicalProjectTruthSections({
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        critical_count: 1,
        warning_count: 0,
        open_count: 1,
        exposure: {
          total_billed_amount: 25000,
          total_contract_supported_amount: 24000,
          total_transaction_supported_amount: 24000,
          total_fully_reconciled_amount: 23000,
          total_unreconciled_amount: 1000,
          total_at_risk_amount: 1000,
          total_requires_verification_amount: 1000,
          support_gap_tolerance_amount: 500,
          at_risk_tolerance_amount: 500,
          moderate_severity: 'warning',
          invoices: [{
            invoice_number: 'INV-001',
            billed_amount: null,
            billed_amount_source: 'missing',
            contract_supported_amount: 24000,
            transaction_supported_amount: 24000,
            fully_reconciled_amount: 23000,
            supported_amount: 24000,
            unreconciled_amount: 1000,
            at_risk_amount: 1000,
            requires_verification_amount: 1000,
            reconciliation_status: 'PARTIAL',
          }],
        },
      },
      documents: [
        {
          id: 'contract-doc-1',
          title: 'Golden Project Governing Contract',
          name: 'golden-contract.pdf',
          created_at: '2026-02-09T10:00:00Z',
          document_type: 'contract',
          intelligence_trace: {
            classification: { family: 'contract' },
            facts: {
              contract_ceiling: 250000,
            },
            contract_analysis: {
              contract_identity: {
                effective_date: {
                  value: '2026-02-09',
                  state: 'explicit',
                  source_fact_ids: ['effective_date'],
                },
              },
              term_model: {
                expiration_date: {
                  value: '2026-12-31',
                  state: 'explicit',
                  source_fact_ids: ['expiration_date'],
                },
              },
              pricing_model: {
                rate_schedule_present: {
                  value: true,
                  state: 'explicit',
                  source_fact_ids: ['rate_schedule_present'],
                },
                rate_schedule_pages: {
                  value: 7,
                  state: 'explicit',
                  source_fact_ids: ['rate_schedule_pages'],
                },
                pricing_applicability: {
                  value: 'Unit-rate schedule applies to debris hauling services',
                  state: 'derived',
                  source_fact_ids: ['pricing_applicability'],
                },
              },
            },
          },
        },
        {
          id: 'invoice-doc-1',
          title: 'Invoice 001',
          name: 'invoice-001.pdf',
          created_at: '2026-03-16T09:00:00Z',
          document_type: 'invoice',
          intelligence_trace: {
            classification: { family: 'invoice' },
            facts: {
              invoice_number: 'INV-001',
              billed_amount: 25000,
              invoice_date: '2026-03-15',
            },
            extracted: {
              invoiceNumber: 'INV-001',
              totalAmount: 25000,
              periodFrom: '2026-03-01',
              periodTo: '2026-03-15',
            },
          },
        },
      ],
    });

    const contractRows = sections.find((section) => section.key === 'contract')?.rows ?? [];
    assert.equal(contractRows.find((row) => row.key === 'governing_contract')?.value, 'Golden Project Governing Contract');
    assert.equal(contractRows.find((row) => row.key === 'governing_contract')?.state, 'derived');
    assert.equal(contractRows.find((row) => row.key === 'contract_ceiling')?.value, '$250,000');
    assert.equal(
      contractRows.find((row) => row.key === 'rate_schedule')?.value,
      'Present (7 pages); Unit-rate schedule applies to debris hauling services',
    );

    const invoiceRows = sections.find((section) => section.key === 'invoice')?.rows ?? [];
    assert.equal(invoiceRows.find((row) => row.key === 'active_invoice')?.value, 'INV-001');
    assert.equal(invoiceRows.find((row) => row.key === 'billed_amount')?.value, '$25,000');
    assert.equal(
      invoiceRows.find((row) => row.key === 'billing_period')?.value,
      'Mar 1, 2026 -> Mar 15, 2026',
    );
  });

  it('uses canonical invoice traces to tighten revision context, billed amount, and support coverage', () => {
    const sections = resolveCanonicalProjectTruthSections({
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        critical_count: 1,
        warning_count: 1,
        open_count: 2,
        exposure: {
          total_billed_amount: 26000,
          total_contract_supported_amount: 24000,
          total_transaction_supported_amount: 24000,
          total_fully_reconciled_amount: 24000,
          total_unreconciled_amount: 2000,
          total_at_risk_amount: 2000,
          total_requires_verification_amount: 2000,
          support_gap_tolerance_amount: 500,
          at_risk_tolerance_amount: 500,
          moderate_severity: 'warning',
          invoices: [{
            invoice_number: 'INV-002',
            billed_amount: null,
            billed_amount_source: 'missing',
            contract_supported_amount: 24000,
            transaction_supported_amount: 24000,
            fully_reconciled_amount: 24000,
            supported_amount: 24000,
            unreconciled_amount: 2000,
            at_risk_amount: 2000,
            requires_verification_amount: 2000,
            reconciliation_status: 'PARTIAL',
          }],
        },
      },
      documents: [
        {
          id: 'invoice-doc-2a',
          title: 'Invoice 002',
          name: 'invoice-002.pdf',
          created_at: '2026-03-20T08:00:00Z',
          document_type: 'invoice',
          intelligence_trace: {
            classification: { family: 'invoice' },
            facts: {
              invoice_number: 'INV-002',
              billed_amount: 25000,
            },
            extracted: {
              invoiceNumber: 'INV-002',
              periodFrom: '2026-03-16',
              periodTo: '2026-03-31',
            },
          },
        },
        {
          id: 'invoice-doc-2b',
          title: 'Invoice 002 Revised',
          name: 'invoice-002-revised.pdf',
          created_at: '2026-03-23T08:00:00Z',
          document_type: 'invoice',
          intelligence_trace: {
            classification: { family: 'invoice' },
            facts: {
              invoice_number: 'INV-002',
              billed_amount: 26000,
              invoice_date: '2026-03-31',
            },
            extracted: {
              invoiceNumber: 'INV-002',
              periodFrom: '2026-03-16',
              periodTo: '2026-03-31',
            },
          },
        },
      ],
    });

    const invoiceRows = sections.find((section) => section.key === 'invoice')?.rows ?? [];
    assert.equal(invoiceRows.find((row) => row.key === 'active_invoice')?.value, 'INV-002 (Revision)');
    assert.equal(invoiceRows.find((row) => row.key === 'invoice_context')?.value, '2 invoices in approval context; active invoice needs review; revision sequence detected for INV-002');
    assert.equal(invoiceRows.find((row) => row.key === 'billed_amount')?.value, '$26,000');
    assert.equal(invoiceRows.find((row) => row.key === 'billed_amount')?.state, 'resolved');
    assert.equal(invoiceRows.find((row) => row.key === 'support_coverage')?.value, 'Partial ($24,000 of $26,000 supported)');
    assert.equal(invoiceRows.find((row) => row.key === 'billing_period')?.value, 'Mar 16, 2026 -> Mar 31, 2026');
  });

  it('marks the active invoice as subsequent when canonical invoice sequence is clear', () => {
    const sections = resolveCanonicalProjectTruthSections({
      validationStatus: 'VALIDATED',
      validationSummary: {
        exposure: {
          total_billed_amount: 51000,
          total_contract_supported_amount: 51000,
          total_transaction_supported_amount: 51000,
          total_fully_reconciled_amount: 51000,
          total_unreconciled_amount: 0,
          total_at_risk_amount: 0,
          total_requires_verification_amount: 0,
          support_gap_tolerance_amount: 500,
          at_risk_tolerance_amount: 500,
          moderate_severity: 'warning',
          invoices: [
            {
              invoice_number: 'INV-001',
              billed_amount: 25000,
              billed_amount_source: 'invoice_total',
              contract_supported_amount: 25000,
              transaction_supported_amount: 25000,
              fully_reconciled_amount: 25000,
              supported_amount: 25000,
              unreconciled_amount: 0,
              at_risk_amount: 0,
              requires_verification_amount: 0,
              reconciliation_status: 'MATCH',
            },
            {
              invoice_number: 'INV-002',
              billed_amount: 26000,
              billed_amount_source: 'invoice_total',
              contract_supported_amount: 26000,
              transaction_supported_amount: 26000,
              fully_reconciled_amount: 26000,
              supported_amount: 26000,
              unreconciled_amount: 0,
              at_risk_amount: 0,
              requires_verification_amount: 0,
              reconciliation_status: 'MATCH',
            },
          ],
        },
      },
      documents: [
        {
          id: 'invoice-doc-1',
          title: 'Invoice 001',
          name: 'invoice-001.pdf',
          created_at: '2026-03-15T08:00:00Z',
          document_type: 'invoice',
          intelligence_trace: {
            classification: { family: 'invoice' },
            facts: {
              invoice_number: 'INV-001',
              billed_amount: 25000,
              invoice_date: '2026-03-15',
            },
          },
        },
        {
          id: 'invoice-doc-2',
          title: 'Invoice 002',
          name: 'invoice-002.pdf',
          created_at: '2026-03-31T08:00:00Z',
          document_type: 'invoice',
          intelligence_trace: {
            classification: { family: 'invoice' },
            facts: {
              invoice_number: 'INV-002',
              billed_amount: 26000,
              invoice_date: '2026-03-31',
            },
          },
        },
      ],
    });

    const invoiceRows = sections.find((section) => section.key === 'invoice')?.rows ?? [];
    assert.equal(invoiceRows.find((row) => row.key === 'active_invoice')?.value, 'INV-002 (Subsequent)');
    assert.equal(invoiceRows.find((row) => row.key === 'invoice_context')?.value, '2 invoices in approval context; active invoice approved; subsequent billing record in the known invoice sequence');
  });

  it('returns invoice truth from canonical invoice documents when invoices exist without validator exposure', () => {
    const sections = resolveCanonicalProjectTruthSections({
      validationStatus: 'NOT_READY',
      validationSummary: null,
      documents: [
        {
          id: 'invoice-doc-2026-002',
          title: 'Invoice 2026-002',
          name: 'invoice-2026-002.pdf',
          created_at: '2026-04-03T12:00:00Z',
          document_type: 'invoice',
          intelligence_trace: {
            facts: {},
            extracted: {
              invoice_number: '2026-002',
              total_amount: 534757.1,
              invoice_date: '2026-04-03',
              period_start: '2026-02-23',
              period_end: '2026-03-18',
              vendor_name: 'Aftermath Disaster Recovery, Inc.',
              client_name: 'Williamson County Highway Dept',
            },
          },
        },
        {
          id: 'invoice-doc-2026-003',
          title: 'Invoice 2026-003',
          name: 'invoice-2026-003.pdf',
          created_at: '2026-04-04T12:00:00Z',
          document_type: 'invoice',
          intelligence_trace: {
            facts: {},
            extracted: {
              invoice_number: '2026-003',
              total_amount: 280802.25,
              invoice_date: '2026-04-03',
              period_start: '2026-02-23',
              period_end: '2026-03-22',
              vendor_name: 'Aftermath Disaster Recovery, Inc.',
              client_name: 'Williamson County Solid Waste Dept',
            },
          },
        },
      ],
    });

    const invoiceRows = sections.find((section) => section.key === 'invoice')?.rows ?? [];
    assert.equal(invoiceRows.find((row) => row.key === 'active_invoice')?.value, '2026-003 (Subsequent)');
    assert.equal(
      invoiceRows.find((row) => row.key === 'invoice_context')?.value,
      '2 invoices detected from project truth; latest invoice 2026-003; subsequent billing record in the known invoice sequence',
    );
    assert.equal(invoiceRows.find((row) => row.key === 'billed_amount')?.value, '$815,559.35');
    assert.equal(
      invoiceRows.find((row) => row.key === 'billing_period')?.value,
      'Feb 23, 2026 -> Mar 22, 2026',
    );
  });

  it('marks canonical non-ready validation states as unresolved instead of missing', () => {
    const sections = resolveCanonicalProjectTruthSections({
      validationStatus: 'NOT_READY',
      validationSummary: null,
    });

    const validationRows = sections.find((section) => section.key === 'validation')?.rows ?? [];
    assert.equal(validationRows.find((row) => row.key === 'validation_status')?.state, 'unresolved');
    assert.equal(validationRows.find((row) => row.key === 'approval_readiness')?.state, 'unresolved');
  });

  it('builds an overview briefing from the same canonical truth used by Facts', () => {
    const briefing = resolveCanonicalProjectOverviewBriefing({
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        validator_status: 'BLOCKED',
        critical_count: 2,
        warning_count: 1,
        open_count: 3,
        blocked_reasons: ['Invoice support is missing'],
        nte_amount: 250000,
        contract_validation_context: {
          document_id: 'contract-doc-1',
          analysis: {
            contract_identity: {
              effective_date: {
                value: '2026-02-09',
                state: 'explicit',
                source_fact_ids: ['effective_date'],
              },
            },
            term_model: {
              expiration_date: {
                value: '2026-12-31',
                state: 'derived',
                source_fact_ids: ['expiration_date'],
              },
            },
            pricing_model: {
              rate_schedule_present: {
                value: true,
                state: 'explicit',
                source_fact_ids: ['rate_schedule_present'],
              },
            },
          },
        },
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
          invoices: [{
            invoice_number: 'INV-001',
            billed_amount: 25000,
            billed_amount_source: 'invoice_total',
            contract_supported_amount: 0,
            transaction_supported_amount: 0,
            fully_reconciled_amount: 0,
            supported_amount: 0,
            unreconciled_amount: 25000,
            at_risk_amount: 25000,
            requires_verification_amount: 25000,
            reconciliation_status: 'MISSING',
          }],
        },
      },
      documents: [
        {
          id: 'contract-doc-1',
          title: 'Golden Project Governing Contract',
          name: 'golden-contract.pdf',
        },
      ],
      transactionDatasets: [{
        document_id: 'tx-doc-1',
        row_count: 18,
        date_range_start: '2026-03-01',
        date_range_end: '2026-03-15',
        created_at: '2026-04-20T10:00:00Z',
        summary_json: {
          project_operations_overview: {
            total_tickets: 14,
            total_cyd: 260,
            total_invoiced_amount: 98500,
          },
        },
      }],
      requiredReviewCount: 4,
    });

    assert.deepEqual(
      briefing.summary_items.map((item) => [item.key, item.value]),
      [
        ['validation_status', 'Findings Open'],
        ['readiness', 'Blocked'],
        ['blockers', '2'],
        ['warnings', '1'],
        ['at_risk_amount', '$10,000'],
        ['required_reviews', '4'],
      ],
    );
    assert.equal(briefing.summary_items.some((item) => item.label === 'Open Actions'), false);
    assert.equal(briefing.critical_signals[0]?.key, 'approval_blockers');
    assert.ok(briefing.critical_signals.some((signal) => signal.key === 'missing_support'));
    assert.deepEqual(
      briefing.snapshot_sections.map((section) => [section.key, section.rows.map((row) => row.key)]),
      [
        ['contract', ['governing_contract', 'contract_ceiling', 'expiration_status']],
        ['invoice', ['active_invoice', 'billed_amount', 'support_coverage']],
        ['transaction', ['unique_tickets', 'volume', 'total_invoiced_amount']],
      ],
    );
  });

  it('uses the primary approval decision action as the overview next step when available', () => {
    const briefing = resolveCanonicalProjectOverviewBriefing({
      validationStatus: 'VALIDATED',
      validationSummary: {
        validator_status: 'READY',
        critical_count: 0,
        warning_count: 0,
        open_count: 0,
      },
      decisions: [{
        id: 'decision-primary-project',
        title: 'Project approval status',
        summary: 'Approval is blocked.',
        decision_type: 'validator_project_approval',
        status: 'open',
        severity: 'critical',
        source: 'project_validator',
        details: {
          primary_approval_decision: true,
          approval_context: 'project',
          approval_status: 'blocked',
          required_reviews: 1,
          required_action: 'Review the unsupported invoice amount before approving payment.',
          blocking_reasons: ['Unsupported invoice amount requires review'],
        },
      }],
    });

    assert.equal(
      briefing.critical_signals.find((signal) => signal.key === 'approval_blockers')?.next_action,
      'Review the unsupported invoice amount before approving payment.',
    );
  });

  it('populates the overview invoice snapshot from canonical invoice truth', () => {
    const briefing = resolveCanonicalProjectOverviewBriefing({
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        validator_status: 'BLOCKED',
        critical_count: 1,
        warning_count: 1,
        open_count: 2,
        exposure: {
          total_billed_amount: 815559.35,
          total_contract_supported_amount: 780000,
          total_transaction_supported_amount: 780000,
          total_fully_reconciled_amount: 760000,
          total_unreconciled_amount: 35559.35,
          total_at_risk_amount: 35559.35,
          total_requires_verification_amount: 35559.35,
          support_gap_tolerance_amount: 500,
          at_risk_tolerance_amount: 500,
          moderate_severity: 'warning',
          invoices: [{
            invoice_number: '2026-003',
            billed_amount: 280802.25,
            billed_amount_source: 'invoice_total',
            contract_supported_amount: 260000,
            transaction_supported_amount: 260000,
            fully_reconciled_amount: 250000,
            supported_amount: 260000,
            unreconciled_amount: 20802.25,
            at_risk_amount: 20802.25,
            requires_verification_amount: 20802.25,
            reconciliation_status: 'MISMATCH',
          }],
        },
      },
      documents: [
        {
          id: 'invoice-002',
          project_id: 'project-1',
          title: 'Invoice 2026-002',
          name: 'invoice-2026-002.pdf',
          document_type: 'invoice',
          document_role: 'invoice',
          authority_status: 'governing',
          effective_date: '2026-04-01',
          precedence_rank: 1,
          operator_override_precedence: true,
          created_at: '2026-04-01T00:00:00Z',
          intelligence_trace: {
            extracted: {
              invoice_number: '2026-002',
              total_amount: 534757.1,
              period_start: '2026-02-23',
              period_end: '2026-03-18',
            },
          },
        },
        {
          id: 'invoice-003',
          project_id: 'project-1',
          title: 'Invoice 2026-003',
          name: 'invoice-2026-003.pdf',
          document_type: 'invoice',
          document_role: 'invoice',
          authority_status: 'subsequent',
          effective_date: '2026-04-04',
          precedence_rank: 2,
          operator_override_precedence: true,
          created_at: '2026-04-04T00:00:00Z',
          intelligence_trace: {
            extracted: {
              invoice_number: '2026-003',
              total_amount: 280802.25,
              period_start: '2026-02-23',
              period_end: '2026-03-22',
            },
          },
        },
      ],
      requiredReviewCount: 2,
    });

    const invoiceRows = briefing.snapshot_sections.find((section) => section.key === 'invoice')?.rows ?? [];
    assert.equal(invoiceRows.find((row) => row.key === 'active_invoice')?.value, '2026-003 (Subsequent)');
    assert.equal(invoiceRows.find((row) => row.key === 'billed_amount')?.value, '$815,559.35');
    assert.equal(invoiceRows.find((row) => row.key === 'support_coverage')?.state, 'requires_review');
  });

  it('prefers the governing contract selected by document precedence when validator contract linkage is absent', () => {
    const sections = resolveCanonicalProjectTruthSections({
      validationStatus: 'NOT_READY',
      validationSummary: null,
      documents: [
        {
          id: 'contract-base',
          project_id: 'project-1',
          title: 'Base Contract',
          name: 'base-contract.pdf',
          created_at: '2026-03-20T00:00:00Z',
          document_type: 'contract',
          document_role: 'base_contract',
          authority_status: 'active',
        },
        {
          id: 'contract-amendment-1',
          project_id: 'project-1',
          title: 'Contract Amendment 1',
          name: 'contract-amendment-1.pdf',
          created_at: '2026-03-10T00:00:00Z',
          document_type: 'contract',
          document_role: 'contract_amendment',
          authority_status: 'active',
        },
      ],
    });

    const contractRows = sections.find((section) => section.key === 'contract')?.rows ?? [];
    assert.equal(contractRows.find((row) => row.key === 'governing_contract')?.value, 'Base Contract');
    assert.equal(contractRows.find((row) => row.key === 'governing_contract')?.state, 'derived');
  });

  it('uses active invoice precedence, ignores superseded invoice records, and surfaces linked support documents', () => {
    const sections = resolveCanonicalProjectTruthSections({
      validationStatus: 'NOT_READY',
      validationSummary: null,
      documents: [
        {
          id: 'contract-doc-1',
          project_id: 'project-1',
          title: 'Master Services Agreement',
          name: 'msa.pdf',
          created_at: '2026-02-09T00:00:00Z',
          document_type: 'contract',
          document_role: 'base_contract',
          authority_status: 'active',
        },
        {
          id: 'invoice-doc-2a',
          project_id: 'project-1',
          title: 'Invoice 002 Original',
          name: 'invoice-002-original.pdf',
          created_at: '2026-03-20T08:00:00Z',
          document_type: 'invoice',
          document_role: 'invoice',
          authority_status: 'superseded',
          intelligence_trace: {
            facts: {
              invoice_number: 'INV-002',
              billed_amount: 25000,
            },
            extracted: {
              periodFrom: '2026-03-16',
              periodTo: '2026-03-31',
            },
          },
        },
        {
          id: 'invoice-doc-2b',
          project_id: 'project-1',
          title: 'Invoice 002 Revised',
          name: 'invoice-002-revised.pdf',
          created_at: '2026-03-23T08:00:00Z',
          document_type: 'invoice',
          document_role: 'invoice_revision',
          authority_status: 'active',
          intelligence_trace: {
            facts: {
              invoice_number: 'INV-002',
              billed_amount: 26000,
            },
            extracted: {
              periodFrom: '2026-03-16',
              periodTo: '2026-03-31',
            },
          },
        },
        {
          id: 'support-doc-1',
          project_id: 'project-1',
          title: 'Ticket Export March 31',
          name: 'ticket-export-march-31.xlsx',
          created_at: '2026-03-31T18:00:00Z',
          document_type: 'ticket',
          document_role: 'ticket_export',
          authority_status: 'active',
        },
      ],
      documentRelationships: [
        {
          id: 'rel-1',
          project_id: 'project-1',
          source_document_id: 'support-doc-1',
          target_document_id: 'invoice-doc-2b',
          relationship_type: 'attached_to',
        },
      ],
    });

    const invoiceRows = sections.find((section) => section.key === 'invoice')?.rows ?? [];
    assert.equal(invoiceRows.find((row) => row.key === 'active_invoice')?.value, 'INV-002 (Revision)');
    assert.equal(invoiceRows.find((row) => row.key === 'billed_amount')?.value, '$26,000');
    assert.equal(invoiceRows.find((row) => row.key === 'support_coverage')?.value, 'Linked support document');
    assert.equal(invoiceRows.find((row) => row.key === 'support_coverage')?.source_label, 'Document relationships');
  });

  it('marks supporting data as not expected during contract setup', () => {
    const workspace = resolveCanonicalProjectValidatorWorkspace({
      validationStatus: 'NOT_READY',
      validationSummary: {
        validation_phase: 'contract_setup',
      },
    });

    const coverage = workspace.coverage_items.find((item) => item.key === 'missing_supporting_data');
    assert.equal(coverage?.label, 'Not Expected For Current Phase');
    assert.equal(coverage?.value, 'Not expected yet');
    assert.match(coverage?.detail ?? '', /not expected yet during contract setup/i);
  });

  it('keeps supporting data as a blocker-oriented coverage item during billing review', () => {
    const workspace = resolveCanonicalProjectValidatorWorkspace({
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        validation_phase: 'billing_review',
        unsupported_amount: 4200,
      },
    });

    const coverage = workspace.coverage_items.find((item) => item.key === 'missing_supporting_data');
    assert.equal(coverage?.label, 'Supporting Data');
    assert.equal(coverage?.value, '$4,200');
    assert.match(coverage?.impact ?? '', /can block approval/i);
  });
});
