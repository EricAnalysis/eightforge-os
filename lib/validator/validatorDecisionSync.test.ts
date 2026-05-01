import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { logActivityEventMock } = vi.hoisted(() => ({
  logActivityEventMock: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/lib/server/activity/logActivityEvent', () => ({
  logActivityEvent: logActivityEventMock,
}));

import {
  buildValidatorDecisionRecords,
  syncValidatorDecisions,
} from '@/lib/validator/validatorDecisionSync';
import type {
  InvoiceExposureSummary,
  ProjectExposureSummary,
  ProjectReconciliationSummary,
  ValidationEvidence,
  ValidationFinding,
  ValidatorResult,
} from '@/types/validator';

const TS = '2026-04-28T00:00:00.000Z';

type TestFinding = ValidationFinding & {
  evidence?: ValidationEvidence[];
};

function makeEvidence(
  overrides: Partial<ValidationEvidence> = {},
): ValidationEvidence {
  return {
    id: overrides.id ?? 'evidence-1',
    finding_id: overrides.finding_id ?? 'finding-1',
    evidence_type: overrides.evidence_type ?? 'document',
    source_document_id: overrides.source_document_id ?? 'doc-1',
    source_page: overrides.source_page ?? 1,
    fact_id: overrides.fact_id ?? null,
    record_id: overrides.record_id ?? null,
    field_name: overrides.field_name ?? null,
    field_value: overrides.field_value ?? null,
    note: overrides.note ?? null,
    created_at: overrides.created_at ?? TS,
  };
}

function makeFinding(
  overrides: Partial<TestFinding> = {},
): TestFinding {
  return {
    id: overrides.id ?? 'finding-1',
    run_id: overrides.run_id ?? 'run-1',
    project_id: overrides.project_id ?? 'project-1',
    rule_id: overrides.rule_id ?? 'INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
    check_key: overrides.check_key ?? 'invoice:2026-003:unsupported',
    category: overrides.category ?? 'financial_integrity',
    severity: overrides.severity ?? 'critical',
    status: overrides.status ?? 'open',
    subject_type: overrides.subject_type ?? 'invoice',
    subject_id: overrides.subject_id ?? '2026-003',
    field: overrides.field ?? null,
    expected: overrides.expected ?? null,
    actual: overrides.actual ?? null,
    variance: overrides.variance ?? 40,
    variance_unit: overrides.variance_unit ?? 'USD',
    blocked_reason: overrides.blocked_reason ?? null,
    finding_disposition: overrides.finding_disposition ?? null,
    business_severity: overrides.business_severity ?? null,
    problem: overrides.problem ?? null,
    impact: overrides.impact ?? null,
    required_action: overrides.required_action ?? null,
    evidence_refs: overrides.evidence_refs ?? null,
    source_family: overrides.source_family ?? null,
    affected_amount: overrides.affected_amount ?? null,
    approval_gate_effect: overrides.approval_gate_effect ?? null,
    decision_eligible: overrides.decision_eligible ?? true,
    action_eligible: overrides.action_eligible ?? true,
    linked_decision_id: overrides.linked_decision_id ?? null,
    linked_action_id: overrides.linked_action_id ?? null,
    resolved_by_user_id: overrides.resolved_by_user_id ?? null,
    resolved_at: overrides.resolved_at ?? null,
    created_at: overrides.created_at ?? TS,
    updated_at: overrides.updated_at ?? TS,
    evidence: overrides.evidence ?? [makeEvidence({ finding_id: overrides.id ?? 'finding-1' })],
  };
}

function makeInvoiceExposure(
  overrides: Partial<InvoiceExposureSummary> = {},
): InvoiceExposureSummary {
  return {
    invoice_number: overrides.invoice_number ?? '2026-003',
    billed_amount: overrides.billed_amount ?? 100,
    billed_amount_source: overrides.billed_amount_source ?? 'invoice_total',
    contract_supported_amount: overrides.contract_supported_amount ?? 60,
    transaction_supported_amount: overrides.transaction_supported_amount ?? 60,
    fully_reconciled_amount: overrides.fully_reconciled_amount ?? 60,
    supported_amount: overrides.supported_amount ?? 60,
    unreconciled_amount: overrides.unreconciled_amount ?? 40,
    at_risk_amount: overrides.at_risk_amount ?? 40,
    requires_verification_amount: overrides.requires_verification_amount ?? 40,
    reconciliation_status: overrides.reconciliation_status ?? 'MISMATCH',
  };
}

function makeExposure(
  invoices: InvoiceExposureSummary[],
  overrides: Partial<ProjectExposureSummary> = {},
): ProjectExposureSummary {
  return {
    total_billed_amount: overrides.total_billed_amount ?? invoices.reduce((sum, invoice) => sum + (invoice.billed_amount ?? 0), 0),
    total_contract_supported_amount: overrides.total_contract_supported_amount ?? invoices.reduce((sum, invoice) => sum + invoice.contract_supported_amount, 0),
    total_transaction_supported_amount: overrides.total_transaction_supported_amount ?? invoices.reduce((sum, invoice) => sum + invoice.transaction_supported_amount, 0),
    total_fully_reconciled_amount: overrides.total_fully_reconciled_amount ?? invoices.reduce((sum, invoice) => sum + invoice.fully_reconciled_amount, 0),
    total_unreconciled_amount: overrides.total_unreconciled_amount ?? invoices.reduce((sum, invoice) => sum + (invoice.unreconciled_amount ?? 0), 0),
    total_at_risk_amount: overrides.total_at_risk_amount ?? invoices.reduce((sum, invoice) => sum + invoice.at_risk_amount, 0),
    total_requires_verification_amount:
      overrides.total_requires_verification_amount
      ?? invoices.reduce((sum, invoice) => sum + (invoice.requires_verification_amount ?? 0), 0),
    support_gap_tolerance_amount: overrides.support_gap_tolerance_amount ?? 0,
    at_risk_tolerance_amount: overrides.at_risk_tolerance_amount ?? 0,
    moderate_severity: 'warning',
    invoices,
  };
}

function makeReconciliation(
  overrides: Partial<ProjectReconciliationSummary> = {},
): ProjectReconciliationSummary {
  return {
    contract_invoice_status: overrides.contract_invoice_status ?? 'MATCH',
    invoice_transaction_status: overrides.invoice_transaction_status ?? 'MISMATCH',
    overall_reconciliation_status: overrides.overall_reconciliation_status ?? 'MISMATCH',
    matched_billing_groups: overrides.matched_billing_groups ?? 0,
    unmatched_billing_groups: overrides.unmatched_billing_groups ?? 1,
    rate_mismatches: overrides.rate_mismatches ?? 1,
    quantity_mismatches: overrides.quantity_mismatches ?? 0,
    orphan_invoice_lines: overrides.orphan_invoice_lines ?? 0,
    orphan_transactions: overrides.orphan_transactions ?? 0,
  };
}

function makeResult(params: {
  findings: TestFinding[];
  exposure: ProjectExposureSummary;
  reconciliation?: ProjectReconciliationSummary;
}): ValidatorResult {
  const { findings, exposure, reconciliation = makeReconciliation() } = params;
  return {
    status: 'BLOCKED',
    blocked_reasons: [],
    findings,
    summary: {
      status: 'BLOCKED',
      last_run_at: TS,
      critical_count: findings.length,
      warning_count: 0,
      info_count: 0,
      blocker_count: findings.length,
      requires_review_count: 0,
      open_count: findings.length,
      blocked_reasons: [],
      trigger_source: 'manual',
      validator_status: 'BLOCKED',
      validator_open_items: [],
      validator_blockers: [],
      reconciliation,
      exposure,
      total_billed: exposure.total_billed_amount,
      at_risk_amount: exposure.total_at_risk_amount,
      unsupported_amount: exposure.total_unreconciled_amount,
      requires_verification_amount: exposure.total_requires_verification_amount ?? null,
    },
    rulesApplied: ['validator-rule-pack'],
    validator_status: 'BLOCKED',
    validator_open_items: [],
    validator_blockers: [],
    reconciliation,
    exposure,
  };
}

type MockDecisionRow = {
  id: string;
  project_id: string;
  organization_id?: string;
  document_id: string | null;
  decision_type: string;
  title: string;
  summary: string | null;
  severity: string;
  status: string;
  assigned_to: string | null;
  assigned_at: string | null;
  due_at: string | null;
  details: Record<string, unknown> | null;
  source: string;
  confidence?: number;
  first_detected_at?: string | null;
  last_detected_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type MockFindingRow = {
  id: string;
  run_id: string;
  linked_decision_id: string | null;
};

function applyFilters<T extends Record<string, unknown>>(
  rows: readonly T[],
  filters: Array<{ field: string; value?: unknown; values?: unknown[]; op: 'eq' | 'in' }>,
): T[] {
  return rows.filter((row) => filters.every((filter) => {
    const rowValue = row[filter.field];
    if (filter.op === 'eq') return rowValue === filter.value;
    return (filter.values ?? []).includes(rowValue);
  }));
}

function createAdminMock(params: {
  decisions?: MockDecisionRow[];
  findingIds?: string[];
  runId?: string;
  missingDecisionProjectIdColumn?: boolean;
}) {
  const state = {
    decisions: [...(params.decisions ?? [])],
    projectValidationFindings: (params.findingIds ?? []).map((id) => ({
      id,
      run_id: params.runId ?? 'run-1',
      linked_decision_id: null,
    })) as MockFindingRow[],
  };
  let nextDecisionId = state.decisions.length + 1;

  return {
    state,
    admin: {
      from(table: string) {
        if (table === 'decisions') {
          return {
            select(_columns: string) {
              const filters: Array<{ field: string; value?: unknown; values?: unknown[]; op: 'eq' | 'in' }> = [];
              const query = {
                eq(field: string, value: unknown) {
                  filters.push({ field, value, op: 'eq' });
                  return query;
                },
                then(resolve: (value: { data: MockDecisionRow[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
                  if (params.missingDecisionProjectIdColumn && filters.some((filter) => filter.field === 'project_id')) {
                    return Promise.resolve({
                      data: null,
                      error: { code: '42703', message: 'column decisions.project_id does not exist' },
                    }).then(resolve as never, reject);
                  }

                  return Promise.resolve({
                    data: applyFilters(state.decisions, filters).map((row) => JSON.parse(JSON.stringify(row)) as MockDecisionRow),
                    error: null,
                  }).then(resolve, reject);
                },
              };
              return query;
            },
            update(patch: Record<string, unknown>) {
              const filters: Array<{ field: string; value?: unknown; values?: unknown[]; op: 'eq' | 'in' }> = [];
              const query = {
                eq(field: string, value: unknown) {
                  filters.push({ field, value, op: 'eq' });
                  return query;
                },
                then(resolve: (value: { error: null }) => unknown, reject?: (reason: unknown) => unknown) {
                  const rows = applyFilters(state.decisions, filters);
                  for (const row of rows) {
                    Object.assign(row, patch);
                  }
                  return Promise.resolve({ error: null }).then(resolve, reject);
                },
              };
              return query;
            },
            insert(row: Record<string, unknown>) {
              if (params.missingDecisionProjectIdColumn && 'project_id' in row) {
                return {
                  select(_columns: string) {
                    return {
                      single() {
                        return Promise.resolve({
                          data: null,
                          error: { code: '42703', message: 'column decisions.project_id does not exist' },
                        });
                      },
                    };
                  },
                };
              }

              const insertedRow: MockDecisionRow = {
                id: `decision-${nextDecisionId++}`,
                project_id: typeof row.project_id === 'string' ? row.project_id : 'project-1',
                organization_id: typeof row.organization_id === 'string' ? row.organization_id : undefined,
                document_id: typeof row.document_id === 'string' ? row.document_id : null,
                decision_type: String(row.decision_type),
                title: String(row.title),
                summary: typeof row.summary === 'string' ? row.summary : null,
                severity: String(row.severity),
                status: String(row.status),
                assigned_to: null,
                assigned_at: null,
                due_at: null,
                details: (row.details as Record<string, unknown> | null) ?? null,
                source: String(row.source ?? 'project_validator'),
                confidence: typeof row.confidence === 'number' ? row.confidence : 1,
                first_detected_at: typeof row.first_detected_at === 'string' ? row.first_detected_at : null,
                last_detected_at: typeof row.last_detected_at === 'string' ? row.last_detected_at : null,
                created_at: typeof row.created_at === 'string' ? row.created_at : null,
                updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
              };
              state.decisions.push(insertedRow);

              return {
                select(_columns: string) {
                  return {
                    single() {
                      return Promise.resolve({
                        data: { id: insertedRow.id },
                        error: null,
                      });
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'project_validation_findings') {
          return {
            update(patch: Record<string, unknown>) {
              return {
                eq(field: string, value: unknown) {
                  const rows = applyFilters(state.projectValidationFindings, [{ field, value, op: 'eq' }]);
                  for (const row of rows) {
                    Object.assign(row, patch);
                  }
                  return Promise.resolve({ error: null });
                },
                in(field: string, values: unknown[]) {
                  const rows = applyFilters(state.projectValidationFindings, [{ field, values, op: 'in' }]);
                  for (const row of rows) {
                    Object.assign(row, patch);
                  }
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table in test admin mock: ${table}`);
      },
    },
  };
}

afterEach(() => {
  logActivityEventMock.mockClear();
});

describe('buildValidatorDecisionRecords', () => {
  it('creates an invoice approval decision from validator findings', () => {
    const finding = makeFinding({
      id: 'finding-invoice-1',
      subject_id: '2026-003',
      check_key: 'invoice:2026-003:unsupported',
      evidence: [
        makeEvidence({
          finding_id: 'finding-invoice-1',
          source_document_id: 'doc-invoice-003',
          record_id: 'invoice-line-1',
        }),
      ],
    });
    const result = makeResult({
      findings: [finding],
      exposure: makeExposure([
        makeInvoiceExposure({
          invoice_number: '2026-003',
          billed_amount: 280802.25,
          supported_amount: 240000,
          contract_supported_amount: 240000,
          transaction_supported_amount: 240000,
          fully_reconciled_amount: 240000,
          unreconciled_amount: 40802.25,
          at_risk_amount: 40802.25,
          requires_verification_amount: 40802.25,
        }),
      ]),
    });

    const records = buildValidatorDecisionRecords({
      projectId: 'project-1',
      runId: 'run-1',
      result,
      findings: [finding],
    });

    assert.equal(records.length, 2);

    const projectRecord = records.find((record) => record.decision_type === 'validator_project_approval');
    const invoiceRecord = records.find((record) => record.decision_type === 'validator_invoice_approval');

    assert.ok(projectRecord, 'project approval decision should exist');
    assert.ok(invoiceRecord, 'invoice approval decision should exist');
    assert.equal(projectRecord?.title, 'Project approval status');
    assert.equal(projectRecord?.status, 'open');
    assert.equal(projectRecord?.details.primary_approval_decision, true);
    assert.equal(projectRecord?.details.approval_status, 'blocked');
    assert.equal(projectRecord?.details.blocked_amount, 280802.25);
    assert.equal(projectRecord?.details.source_validator_run_id, 'run-1');

    assert.equal(invoiceRecord?.decision_type, 'validator_invoice_approval');
    assert.equal(invoiceRecord?.title, 'Invoice 2026-003 approval status');
    assert.equal(invoiceRecord?.document_id, 'doc-invoice-003');
    assert.deepEqual(invoiceRecord?.finding_ids, ['finding-invoice-1']);
    assert.deepEqual(invoiceRecord?.link_finding_ids, ['finding-invoice-1']);
    assert.equal(
      (invoiceRecord?.details.validator_finding_ids as string[] | undefined)?.[0],
      'finding-invoice-1',
    );
    assert.equal(invoiceRecord?.details.source_label, 'Validator output');
    assert.equal(invoiceRecord?.details.required_action, 'Resolve the unsupported billed amount on this invoice before payment approval proceeds.');
    assert.equal(invoiceRecord?.details.approval_status, 'blocked');
    assert.equal(invoiceRecord?.details.blocked_amount, 280802.25);
    assert.equal(invoiceRecord?.details.unsupported_amount, 40802.25);
    assert.ok(
      (invoiceRecord?.details.evidence_refs as string[]).includes('record:invoice-line-1'),
      'invoice decision should retain evidence refs',
    );
  });

  it('groups project and invoice findings into primary validator decision nodes', () => {
    const contractFinding = makeFinding({
      id: 'finding-project-contract',
      rule_id: 'SOURCES_NO_RATE_SCHEDULE',
      check_key: 'project:contract:rate_schedule',
      subject_type: 'project',
      subject_id: 'project-1',
      severity: 'warning',
      source_family: 'contract',
      evidence: [
        makeEvidence({
          finding_id: 'finding-project-contract',
          source_document_id: 'doc-contract-1',
        }),
      ],
    });
    const invoiceFinding = makeFinding({
      id: 'finding-invoice-ticket',
      rule_id: 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE',
      check_key: 'invoice:2026-003:transaction_total',
      subject_type: 'invoice',
      subject_id: '2026-003',
      evidence: [
        makeEvidence({
          finding_id: 'finding-invoice-ticket',
          source_document_id: 'doc-invoice-003',
        }),
      ],
    });
    const result = makeResult({
      findings: [contractFinding, invoiceFinding],
      exposure: makeExposure([
        makeInvoiceExposure({
          invoice_number: '2026-003',
          billed_amount: 280802.25,
          supported_amount: 250000,
          contract_supported_amount: 250000,
          transaction_supported_amount: 250000,
          fully_reconciled_amount: 250000,
          unreconciled_amount: 30802.25,
          at_risk_amount: 30802.25,
          requires_verification_amount: 30802.25,
        }),
      ]),
    });

    const records = buildValidatorDecisionRecords({
      projectId: 'project-1',
      runId: 'run-1',
      result,
      findings: [contractFinding, invoiceFinding],
    });

    assert.equal(records.length, 2);

    const projectRecord = records.find((record) => record.decision_type === 'validator_project_approval');
    const invoiceRecord = records.find((record) => record.decision_type === 'validator_invoice_approval');

    assert.ok(projectRecord, 'project validator decision should exist');
    assert.ok(invoiceRecord, 'invoice validator decision should exist');
    assert.equal(projectRecord?.title, 'Project approval status');
    assert.deepEqual(projectRecord?.finding_ids, ['finding-project-contract', 'finding-invoice-ticket']);
    assert.deepEqual(projectRecord?.link_finding_ids, ['finding-project-contract']);
    assert.equal(projectRecord?.details.required_reviews, 2);
    assert.equal(invoiceRecord?.title, 'Invoice 2026-003 approval status');
    assert.deepEqual(invoiceRecord?.finding_ids, ['finding-invoice-ticket']);
    assert.deepEqual(invoiceRecord?.link_finding_ids, ['finding-invoice-ticket']);
  });

  it('keeps one stable primary approval identity across reruns', () => {
    const finding = makeFinding({
      id: 'finding-invoice-identity',
      subject_id: '2026-003',
      check_key: 'invoice:2026-003:identity',
    });
    const result = makeResult({
      findings: [finding],
      exposure: makeExposure([
        makeInvoiceExposure({
          invoice_number: '2026-003',
          billed_amount: 280802.25,
          supported_amount: 240000,
          contract_supported_amount: 240000,
          transaction_supported_amount: 240000,
          fully_reconciled_amount: 240000,
          unreconciled_amount: 40802.25,
          at_risk_amount: 40802.25,
          requires_verification_amount: 40802.25,
        }),
      ]),
    });

    const first = buildValidatorDecisionRecords({
      projectId: 'project-1',
      runId: 'run-1',
      result,
      findings: [finding],
    });
    const second = buildValidatorDecisionRecords({
      projectId: 'project-1',
      runId: 'run-2',
      result,
      findings: [finding],
    });

    assert.equal(first[0]?.identity_key, second[0]?.identity_key);
    assert.equal(first[1]?.identity_key, second[1]?.identity_key);
  });

  it('rolls requires-review findings into a non-blocking primary approval decision', () => {
    const reviewFinding = makeFinding({
      id: 'finding-review-1',
      rule_id: 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR',
      check_key: 'contract:pricing-review',
      severity: 'warning',
      subject_type: 'project',
      subject_id: 'project-1',
      finding_disposition: 'requires_review',
      business_severity: 'high',
      approval_gate_effect: 'requires_operator_review',
      blocked_reason: null,
      affected_amount: null,
    });
    const result = makeResult({
      findings: [reviewFinding],
      exposure: makeExposure([
        makeInvoiceExposure({
          invoice_number: '2026-003',
          billed_amount: 280802.25,
          supported_amount: 280802.25,
          contract_supported_amount: 280802.25,
          transaction_supported_amount: 280802.25,
          fully_reconciled_amount: 280802.25,
          unreconciled_amount: 0,
          at_risk_amount: 0,
          requires_verification_amount: 0,
          reconciliation_status: 'MATCH',
        }),
      ], {
        total_unreconciled_amount: 0,
        total_at_risk_amount: 0,
        total_requires_verification_amount: 0,
      }),
      reconciliation: makeReconciliation({
        overall_reconciliation_status: 'MATCH',
        invoice_transaction_status: 'MATCH',
        rate_mismatches: 0,
        unmatched_billing_groups: 0,
      }),
    });

    const records = buildValidatorDecisionRecords({
      projectId: 'project-1',
      runId: 'run-review',
      result,
      findings: [reviewFinding],
    });

    const projectRecord = records.find((record) => record.decision_type === 'validator_project_approval');
    assert.ok(projectRecord, 'project approval decision should exist');
    assert.equal(projectRecord?.status, 'in_review');
    assert.equal(projectRecord?.severity, 'high');
    assert.equal(projectRecord?.details.approval_status, 'requires_review');
  });

  it('does not create a false approval decision when validator has not produced approval context', () => {
    const records = buildValidatorDecisionRecords({
      projectId: 'project-1',
      runId: 'run-empty',
      result: {
        status: 'NOT_READY',
        blocked_reasons: [],
        findings: [],
        summary: {
          status: 'NOT_READY',
          last_run_at: null,
          critical_count: 0,
          warning_count: 0,
          info_count: 0,
          open_count: 0,
          blocked_reasons: [],
          trigger_source: null,
          validator_status: 'NEEDS_REVIEW',
          validator_open_items: [],
          validator_blockers: [],
        },
        rulesApplied: [],
        validator_status: 'NEEDS_REVIEW',
        validator_open_items: [],
        validator_blockers: [],
      },
      findings: [],
    });

    assert.equal(records.length, 0);
  });

  it('syncs one stable primary approval decision per context and updates it on rerun', async () => {
    const finding = makeFinding({
      id: 'finding-sync-1',
      run_id: 'run-1',
      subject_id: '2026-003',
      check_key: 'invoice:2026-003:unsupported',
      affected_amount: 35559.35,
      approval_gate_effect: 'blocks_approval',
      evidence: [
        makeEvidence({
          finding_id: 'finding-sync-1',
          source_document_id: 'doc-invoice-003',
          record_id: 'invoice-line-sync-1',
        }),
      ],
    });
    const result = makeResult({
      findings: [finding],
      exposure: makeExposure([
        makeInvoiceExposure({
          invoice_number: '2026-003',
          billed_amount: 280802.25,
          supported_amount: 245242.9,
          contract_supported_amount: 245242.9,
          transaction_supported_amount: 245242.9,
          fully_reconciled_amount: 245242.9,
          unreconciled_amount: 35559.35,
          at_risk_amount: 35559.35,
          requires_verification_amount: 35559.35,
        }),
      ]),
    });
    const adminMock = createAdminMock({
      findingIds: ['finding-sync-1'],
      runId: 'run-1',
    });

    const firstSync = await syncValidatorDecisions({
      admin: adminMock.admin as never,
      projectId: 'project-1',
      organizationId: 'org-1',
      runId: 'run-1',
      result,
      findings: [finding],
    });

    assert.equal(firstSync.created, 2);
    assert.equal(firstSync.updated, 0);
    assert.equal(
      adminMock.state.decisions.filter((row) => row.decision_type === 'validator_project_approval').length,
      1,
    );
    assert.equal(
      adminMock.state.decisions.filter((row) => row.decision_type === 'validator_invoice_approval').length,
      1,
    );
    expect(logActivityEventMock).toHaveBeenCalledTimes(2);

    const rerunFinding = makeFinding({
      ...finding,
      run_id: 'run-2',
      affected_amount: 40802.25,
      updated_at: '2026-04-29T00:00:00.000Z',
    });
    const rerunResult = makeResult({
      findings: [rerunFinding],
      exposure: makeExposure([
        makeInvoiceExposure({
          invoice_number: '2026-003',
          billed_amount: 280802.25,
          supported_amount: 240000,
          contract_supported_amount: 240000,
          transaction_supported_amount: 240000,
          fully_reconciled_amount: 240000,
          unreconciled_amount: 40802.25,
          at_risk_amount: 40802.25,
          requires_verification_amount: 40802.25,
        }),
      ]),
    });

    const secondSync = await syncValidatorDecisions({
      admin: adminMock.admin as never,
      projectId: 'project-1',
      organizationId: 'org-1',
      runId: 'run-2',
      result: rerunResult,
      findings: [rerunFinding],
    });

    assert.equal(secondSync.created, 0);
    assert.equal(secondSync.updated, 2);
    assert.equal(
      adminMock.state.decisions.filter((row) => row.decision_type === 'validator_project_approval').length,
      1,
    );
    assert.equal(
      adminMock.state.decisions.filter((row) => row.decision_type === 'validator_invoice_approval').length,
      1,
    );
    const projectDecision = adminMock.state.decisions.find((row) => row.decision_type === 'validator_project_approval');
    assert.equal(projectDecision?.details?.source_validator_run_id, 'run-2');
    assert.equal(projectDecision?.details?.unsupported_amount, 40802.25);
    expect(logActivityEventMock).toHaveBeenCalledTimes(4);
  });

  it('syncs validator approval decisions even when decisions.project_id is not available yet', async () => {
    const finding = makeFinding({
      id: 'finding-missing-project-id',
      run_id: 'run-legacy-1',
      subject_id: '2026-009',
      check_key: 'invoice:2026-009:unsupported',
      affected_amount: 1200,
      approval_gate_effect: 'blocks_approval',
    });
    const result = makeResult({
      findings: [finding],
      exposure: makeExposure([
        makeInvoiceExposure({
          invoice_number: '2026-009',
          billed_amount: 1200,
          supported_amount: 0,
          contract_supported_amount: 0,
          transaction_supported_amount: 0,
          fully_reconciled_amount: 0,
          unreconciled_amount: 1200,
          at_risk_amount: 1200,
          requires_verification_amount: 1200,
        }),
      ]),
    });
    const adminMock = createAdminMock({
      findingIds: ['finding-missing-project-id'],
      runId: 'run-legacy-1',
      missingDecisionProjectIdColumn: true,
    });

    const syncResult = await syncValidatorDecisions({
      admin: adminMock.admin as never,
      projectId: 'project-legacy-1',
      organizationId: 'org-1',
      projectContext: {
        label: 'Legacy Project',
        project_id: 'project-legacy-1',
        project_code: 'LP-1',
      },
      runId: 'run-legacy-1',
      result,
      findings: [finding],
    });

    assert.equal(syncResult.created, 2);
    assert.equal(
      adminMock.state.decisions.filter((row) => row.decision_type === 'validator_project_approval').length,
      1,
    );
    const projectDecision = adminMock.state.decisions.find((row) => row.decision_type === 'validator_project_approval');
    assert.ok(projectDecision?.details?.project_context, 'project_context should be embedded for legacy linkage');
  });
});
