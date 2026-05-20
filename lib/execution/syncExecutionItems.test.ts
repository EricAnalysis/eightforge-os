import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionItemRow } from '@/lib/executionItems';
import {
  buildExecutionItemSuppressionSignature,
  executionItemSuppressionSignatureForRow,
} from '@/lib/executionItems';
import { syncExecutionItems } from '@/lib/execution/syncExecutionItems';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

const { logActivityEventMock } = vi.hoisted(() => ({
  logActivityEventMock: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/lib/server/activity/logActivityEvent', () => ({
  logActivityEvent: logActivityEventMock,
}));

const TS = '2026-05-06T00:00:00.000Z';

type TestFinding = ValidationFinding & {
  evidence?: ValidationEvidence[];
};

type MockExecutionItemRow = ProjectExecutionItemRow;

type MockFindingRow = {
  id: string;
  check_key: string;
  status: string;
  linked_action_id: string | null;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  updated_at: string;
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
    record_id: overrides.record_id ?? 'record-1',
    field_name: overrides.field_name ?? 'rate',
    field_value: overrides.field_value ?? '100',
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
    rule_id: overrides.rule_id ?? 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
    check_key: overrides.check_key ?? 'invoice:INV-001:contract-rate',
    category: overrides.category ?? 'financial_integrity',
    severity: overrides.severity ?? 'critical',
    status: overrides.status ?? 'open',
    subject_type: overrides.subject_type ?? 'invoice',
    subject_id: overrides.subject_id ?? 'INV-001',
    field: overrides.field ?? 'rate',
    expected: overrides.expected ?? '100',
    actual: overrides.actual ?? 'missing',
    variance: overrides.variance ?? null,
    variance_unit: overrides.variance_unit ?? null,
    blocked_reason: overrides.blocked_reason ?? 'Contract rate is missing.',
    finding_disposition: overrides.finding_disposition ?? null,
    business_severity: overrides.business_severity ?? 'critical',
    problem: overrides.problem ?? 'No governing contract rate found for billed work.',
    impact: overrides.impact ?? 'Approval is blocked until the governing rate is confirmed.',
    required_action: overrides.required_action ?? 'Locate the governing contract rate row.',
    evidence_refs: overrides.evidence_refs ?? null,
    source_family: overrides.source_family ?? 'contract',
    affected_amount: overrides.affected_amount ?? 1250,
    approval_gate_effect: overrides.approval_gate_effect ?? 'blocks_approval',
    exposure_type: overrides.exposure_type ?? 'missing_governing_contract',
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

function applyFilters<T extends Record<string, unknown>>(
  rows: readonly T[],
  filters: Array<{ field: string; value: unknown }>,
): T[] {
  return rows.filter((row) => filters.every((filter) => row[filter.field] === filter.value));
}

function createAdminMock(params: {
  executionItems?: MockExecutionItemRow[];
  validationFindings?: MockFindingRow[];
}) {
  const state = {
    executionItems: [...(params.executionItems ?? [])],
    validationFindings: [...(params.validationFindings ?? [])],
  };
  let nextExecutionItemId = state.executionItems.length + 1;

  return {
    state,
    admin: {
      from(table: string) {
        if (table === 'execution_items') {
          return {
            select() {
              const filters: Array<{ field: string; value: unknown }> = [];
              const query = {
                eq(field: string, value: unknown) {
                  filters.push({ field, value });
                  return query;
                },
                then(resolve: (value: { data: MockExecutionItemRow[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
                  return Promise.resolve({
                    data: applyFilters(state.executionItems, filters).map((row) => ({ ...row })),
                    error: null,
                  }).then(resolve, reject);
                },
              };
              return query;
            },
            update(patch: Partial<MockExecutionItemRow>) {
              const filters: Array<{ field: string; value: unknown }> = [];
              const query = {
                eq(field: string, value: unknown) {
                  filters.push({ field, value });
                  return query;
                },
                then(resolve: (value: { error: null }) => unknown, reject?: (reason: unknown) => unknown) {
                  const rows = applyFilters(state.executionItems, filters);
                  for (const row of rows) {
                    Object.assign(row, patch);
                  }
                  return Promise.resolve({ error: null }).then(resolve, reject);
                },
              };
              return query;
            },
            insert(row: Partial<MockExecutionItemRow>) {
              const insertedRow: MockExecutionItemRow = {
                id: `execution-${nextExecutionItemId++}`,
                organization_id: String(row.organization_id),
                project_id: String(row.project_id),
                source_type: row.source_type ?? 'validator_finding',
                source_id: String(row.source_id),
                source_key: String(row.source_key),
                severity: row.severity ?? 'critical',
                title: String(row.title),
                problem: String(row.problem),
                expected_value: row.expected_value ?? null,
                actual_value: row.actual_value ?? null,
                impact: String(row.impact),
                required_action: String(row.required_action),
                status: row.status ?? 'open',
                outcome: row.outcome ?? null,
                evidence_refs: (row.evidence_refs as string[] | null | undefined) ?? null,
                fact_refs: (row.fact_refs as string[] | null | undefined) ?? null,
                validator_rule_key: row.validator_rule_key ?? null,
                override_reason: row.override_reason ?? null,
                suppression_signature: row.suppression_signature ?? null,
                created_at: String(row.created_at ?? TS),
                updated_at: String(row.updated_at ?? TS),
                last_seen_at: (row.last_seen_at as string | null | undefined) ?? null,
                overridden_at: (row.overridden_at as string | null | undefined) ?? null,
                resolved_at: (row.resolved_at as string | null | undefined) ?? null,
              };
              state.executionItems.push(insertedRow);

              return {
                select() {
                  return {
                    single: async () => ({
                      data: { id: insertedRow.id },
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        }

        if (table === 'project_validation_findings') {
          return {
            update(patch: Partial<MockFindingRow>) {
              return {
                eq(field: string, value: unknown) {
                  const rows = state.validationFindings.filter((row) => row[field as keyof MockFindingRow] === value);
                  for (const row of rows) {
                    Object.assign(row, patch);
                  }
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    },
  };
}

function findValidationFinding(
  state: { validationFindings: MockFindingRow[] },
  findingId: string,
): MockFindingRow {
  const finding = state.validationFindings.find((row) => row.id === findingId);
  assert.ok(finding, `Expected validation finding ${findingId} to exist`);
  return finding;
}

afterEach(() => {
  logActivityEventMock.mockClear();
});

describe('syncExecutionItems', () => {
  it('creates one execution item for a blocking validator finding', async () => {
    const finding = makeFinding();
    const adminMock = createAdminMock({
      validationFindings: [{
        id: finding.id,
        check_key: finding.check_key,
        status: 'open',
        linked_action_id: null,
        resolved_by_user_id: null,
        resolved_at: null,
        updated_at: TS,
      }],
    });

    const result = await syncExecutionItems({
      admin: adminMock.admin as never,
      projectId: 'project-1',
      organizationId: 'org-1',
      actorId: 'user-1',
      findings: [finding],
    });

    assert.equal(result.created, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.suppressed, 0);
    assert.equal(adminMock.state.executionItems.length, 1);
    assert.equal(adminMock.state.executionItems[0]?.status, 'open');
    assert.ok(adminMock.state.executionItems[0]?.suppression_signature);
    assert.equal(findValidationFinding(adminMock.state, finding.id).linked_action_id, adminMock.state.executionItems[0]?.id ?? null);
    expect(logActivityEventMock).toHaveBeenCalledTimes(1);
  });

  it('updates the same open execution item idempotently across reruns', async () => {
    const firstFinding = makeFinding({
      id: 'finding-open-1',
      run_id: 'run-1',
    });
    const adminMock = createAdminMock({
      validationFindings: [{
        id: firstFinding.id,
        check_key: firstFinding.check_key,
        status: 'open',
        linked_action_id: null,
        resolved_by_user_id: null,
        resolved_at: null,
        updated_at: TS,
      }],
    });

    await syncExecutionItems({
      admin: adminMock.admin as never,
      projectId: 'project-1',
      organizationId: 'org-1',
      findings: [firstFinding],
    });

    const rerunFinding = makeFinding({
      ...firstFinding,
      id: 'finding-open-2',
      run_id: 'run-2',
      updated_at: '2026-05-06T01:00:00.000Z',
    });
    adminMock.state.validationFindings.push({
      id: rerunFinding.id,
      check_key: rerunFinding.check_key,
      status: 'open',
      linked_action_id: null,
      resolved_by_user_id: null,
      resolved_at: null,
      updated_at: TS,
    });

    const result = await syncExecutionItems({
      admin: adminMock.admin as never,
      projectId: 'project-1',
      organizationId: 'org-1',
      findings: [rerunFinding],
    });

    assert.equal(result.created, 0);
    assert.equal(adminMock.state.executionItems.length, 1);
    assert.equal(adminMock.state.executionItems[0]?.source_id, rerunFinding.id);
    assert.equal(adminMock.state.executionItems[0]?.status, 'open');
    assert.equal(findValidationFinding(adminMock.state, rerunFinding.id).linked_action_id, adminMock.state.executionItems[0]?.id ?? null);
  });

  it('keeps an overridden execution item suppressed when the rerun finding signature matches', async () => {
    const firstFinding = makeFinding({
      id: 'finding-override-1',
      run_id: 'run-1',
    });
    const adminMock = createAdminMock({
      validationFindings: [{
        id: firstFinding.id,
        check_key: firstFinding.check_key,
        status: 'open',
        linked_action_id: null,
        resolved_by_user_id: null,
        resolved_at: null,
        updated_at: TS,
      }],
    });

    await syncExecutionItems({
      admin: adminMock.admin as never,
      projectId: 'project-1',
      organizationId: 'org-1',
      findings: [firstFinding],
    });

    const existingItem = adminMock.state.executionItems[0];
    assert.ok(existingItem);
    existingItem.status = 'resolved';
    existingItem.outcome = 'overridden';
    existingItem.override_reason = 'Operator approved an exception.';
    existingItem.overridden_at = '2026-05-06T02:00:00.000Z';
    existingItem.resolved_at = '2026-05-06T02:00:00.000Z';
    existingItem.suppression_signature =
      existingItem.suppression_signature
      ?? executionItemSuppressionSignatureForRow(existingItem);

    const rerunFinding = makeFinding({
      ...firstFinding,
      id: 'finding-override-2',
      run_id: 'run-2',
    });
    adminMock.state.validationFindings.push({
      id: rerunFinding.id,
      check_key: rerunFinding.check_key,
      status: 'open',
      linked_action_id: null,
      resolved_by_user_id: null,
      resolved_at: null,
      updated_at: TS,
    });

    const result = await syncExecutionItems({
      admin: adminMock.admin as never,
      projectId: 'project-1',
      organizationId: 'org-1',
      actorId: 'user-2',
      findings: [rerunFinding],
    });

    assert.equal(result.created, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(adminMock.state.executionItems.length, 1);
    assert.equal(adminMock.state.executionItems[0]?.status, 'resolved');
    assert.equal(adminMock.state.executionItems[0]?.outcome, 'overridden');
    assert.equal(adminMock.state.executionItems[0]?.override_reason, 'Operator approved an exception.');
    assert.equal(findValidationFinding(adminMock.state, rerunFinding.id).status, 'dismissed');
    assert.equal(findValidationFinding(adminMock.state, rerunFinding.id).linked_action_id, existingItem.id);
  });

  it('reopens an overridden execution item when the finding meaningfully changes', async () => {
    const firstFinding = makeFinding({
      id: 'finding-changed-1',
      run_id: 'run-1',
    });
    const adminMock = createAdminMock({
      validationFindings: [{
        id: firstFinding.id,
        check_key: firstFinding.check_key,
        status: 'open',
        linked_action_id: null,
        resolved_by_user_id: null,
        resolved_at: null,
        updated_at: TS,
      }],
    });

    await syncExecutionItems({
      admin: adminMock.admin as never,
      projectId: 'project-1',
      organizationId: 'org-1',
      findings: [firstFinding],
    });

    const existingItem = adminMock.state.executionItems[0];
    assert.ok(existingItem);
    existingItem.status = 'resolved';
    existingItem.outcome = 'overridden';
    existingItem.override_reason = 'Approved on prior evidence.';
    existingItem.overridden_at = '2026-05-06T02:00:00.000Z';
    existingItem.resolved_at = '2026-05-06T02:00:00.000Z';
    existingItem.suppression_signature =
      existingItem.suppression_signature
      ?? executionItemSuppressionSignatureForRow(existingItem);

    const rerunFinding = makeFinding({
      ...firstFinding,
      id: 'finding-changed-2',
      run_id: 'run-2',
      actual: 'rate 110 found',
      evidence: [makeEvidence({
        finding_id: 'finding-changed-2',
        source_document_id: 'doc-2',
        source_page: 2,
        record_id: 'record-2',
        field_value: '110',
      })],
    });
    adminMock.state.validationFindings.push({
      id: rerunFinding.id,
      check_key: rerunFinding.check_key,
      status: 'open',
      linked_action_id: null,
      resolved_by_user_id: null,
      resolved_at: null,
      updated_at: TS,
    });

    const result = await syncExecutionItems({
      admin: adminMock.admin as never,
      projectId: 'project-1',
      organizationId: 'org-1',
      findings: [rerunFinding],
    });

    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.suppressed, 0);
    assert.equal(adminMock.state.executionItems.length, 1);
    assert.equal(adminMock.state.executionItems[0]?.status, 'open');
    assert.equal(adminMock.state.executionItems[0]?.outcome, null);
    assert.equal(adminMock.state.executionItems[0]?.override_reason, null);

    const nextSignature = buildExecutionItemSuppressionSignature({
      project_id: 'project-1',
      validator_rule_key: rerunFinding.rule_id,
      source_key: rerunFinding.check_key,
      expected_value: rerunFinding.expected,
      actual_value: rerunFinding.actual,
      evidence_refs: [
        'document:doc-2:page:2',
        'record:record-2',
        'field:rate',
      ],
      fact_refs: [],
    });
    assert.equal(adminMock.state.executionItems[0]?.suppression_signature, nextSignature);
    assert.equal(findValidationFinding(adminMock.state, rerunFinding.id).status, 'open');
  });
});
