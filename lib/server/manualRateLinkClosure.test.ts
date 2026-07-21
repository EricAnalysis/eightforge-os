import assert from 'node:assert/strict';
import { describe, it, vi, beforeEach } from 'vitest';

// ─── module mocks (hoisted to file top by vitest) ────────────────────────────

vi.mock('@/lib/server/activity/logActivityEvent', () => ({
  logActivityEvent: vi.fn().mockResolvedValue({ ok: true, id: 'activity-1' }),
}));

vi.mock('@/lib/server/decisionClosure', () => ({
  finalizeDecision: vi.fn(),
}));

// Import AFTER vi.mock declarations so we get the mocked versions.
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { finalizeDecision } from '@/lib/server/decisionClosure';
import { insertManualRateLink, closeManualRateLinkFindings } from '@/lib/server/manualRateLinkClosure';

// ─── helpers ─────────────────────────────────────────────────────────────────

const TS = '2026-06-30T12:00:00.000Z';

type LinkRow = {
  id: string;
  organization_id: string;
  project_id: string;
  invoice_document_id: string;
  invoice_line_subject_id: string;
  invoice_line_number: string | null;
  invoice_line_description: string | null;
  invoice_line_billing_code: string | null;
  contract_document_id: string;
  contract_rate_row_id: string;
  rate_row_description: string | null;
  rate_row_unit_type: string | null;
  rate_row_rate_amount: number | null;
  actor_id: string;
  reason: string | null;
  is_active: boolean;
  superseded_by: string | null;
  created_at: string;
};

type FindingRow = {
  id: string;
  project_id: string;
  rule_id: string;
  subject_id: string;
  status: string;
  linked_decision_id: string | null;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  updated_at: string;
};

type DecisionRow = {
  id: string;
  organization_id: string;
  project_id: string | null;
  document_id: string | null;
  status: string | null;
  severity: string | null;
};

type MockState = {
  links: LinkRow[];
  findings: FindingRow[];
  decisions: DecisionRow[];
  insertedLinks: Record<string, unknown>[];
};

let idCounter = 0;

function matches(
  row: Record<string, unknown>,
  filters: Array<{ op: 'eq' | 'in'; field: string; value: unknown }>,
): boolean {
  return filters.every((f) => {
    const v = row[f.field];
    return f.op === 'eq' ? v === f.value : Array.isArray(f.value) && f.value.includes(v);
  });
}

function createAdminMock(state: MockState) {
  return {
    from(table: string) {
      const filters: Array<{ op: 'eq' | 'in'; field: string; value: unknown }> = [];
      let patch: Record<string, unknown> | null = null;
      let insertPayload: Record<string, unknown> | null = null;
      let isSingle = false;
      let isMaybeSingle = false;

      const rowsForTable = (): Array<Record<string, unknown>> => {
        if (table === 'invoice_line_rate_links') return state.links as never;
        if (table === 'project_validation_findings') return state.findings as never;
        if (table === 'decisions') return state.decisions as never;
        throw new Error(`Unexpected table in test: ${table}`);
      };

      const query = {
        select(_cols: string) { return query; },
        insert(payload: Record<string, unknown>) { insertPayload = payload; return query; },
        update(nextPatch: Record<string, unknown>) { patch = nextPatch; return query; },
        eq(field: string, value: unknown) { filters.push({ op: 'eq', field, value }); return query; },
        in(field: string, value: unknown) { filters.push({ op: 'in', field, value }); return query; },
        single() { isSingle = true; return query; },
        maybeSingle() { isMaybeSingle = true; return query; },
        then(
          resolve: (value: { data?: unknown; error: null | { message: string; code: string } }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) {
          if (insertPayload !== null) {
            const newRow = { ...insertPayload, id: `generated-id-${++idCounter}`, created_at: TS };
            if (table === 'invoice_line_rate_links') {
              (state.links as Array<Record<string, unknown>>).push(newRow);
              state.insertedLinks.push(newRow);
            }
            const result = isSingle
              ? { data: { id: newRow.id }, error: null }
              : { data: [{ id: newRow.id }], error: null };
            return Promise.resolve(result).then(resolve, reject);
          }

          const rows = rowsForTable();
          const matched = rows.filter((r) => matches(r, filters));

          if (patch !== null) {
            for (const row of matched) Object.assign(row, patch);
            return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
          }

          if (isSingle) {
            if (matched.length === 0) {
              return Promise.resolve({ data: null, error: { message: 'No rows found', code: 'PGRST116' } }).then(resolve, reject);
            }
            return Promise.resolve({ data: { ...matched[0] }, error: null }).then(resolve, reject);
          }

          if (isMaybeSingle) {
            return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null }).then(resolve, reject);
          }

          return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null }).then(resolve, reject);
        },
      };

      return query;
    },
  };
}

function createState(): MockState {
  return { links: [], findings: [], decisions: [], insertedLinks: [] };
}

const BASE_LINK_INPUT = {
  organizationId: 'org-1',
  projectId: 'project-1',
  invoiceDocumentId: 'invoice-doc-1',
  invoiceLineSubjectId: 'fact:invoice-doc-1:line:6',
  invoiceLineNumber: '6A',
  invoiceLineDescription: 'Hazardous debris removal',
  invoiceLineBillingCode: 'HDR',
  contractDocumentId: 'contract-doc-1',
  contractRateRowId: 'exhibit_a_table:/structural_table:row:5',
  rateRowDescription: 'Hazardous debris haul',
  rateRowUnitType: 'per cubic yard',
  rateRowRateAmount: 79.52,
  actorId: 'user-1',
  reason: 'Automated matcher missed this row due to description truncation.',
} as const;

const OPEN_FINDING: FindingRow = {
  id: 'finding-1',
  project_id: 'project-1',
  rule_id: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
  subject_id: 'fact:invoice-doc-1:line:6',
  status: 'open',
  linked_decision_id: null,
  resolved_by_user_id: null,
  resolved_at: null,
  updated_at: TS,
};

const CLOSE_INPUT = {
  organizationId: 'org-1',
  projectId: 'project-1',
  invoiceLineSubjectId: 'fact:invoice-doc-1:line:6',
  actorId: 'user-1',
  contractRateRowId: 'exhibit_a_table:/structural_table:row:5',
  rateRowDescription: 'Hazardous debris haul',
  reason: 'Manual link applied.',
} as const;

// ─── insertManualRateLink ────────────────────────────────────────────────────

describe('insertManualRateLink', () => {
  beforeEach(() => { idCounter = 0; });

  it('inserts a new link with all stability anchor fields populated', async () => {
    const state = createState();
    const result = await insertManualRateLink({ admin: createAdminMock(state) as never, ...BASE_LINK_INPUT });

    assert.ok(result.ok);
    assert.equal(result.supersededLinkId, null);

    const inserted = state.insertedLinks[0];
    assert.ok(inserted, 'link row was inserted');
    assert.equal(inserted.organization_id, 'org-1');
    assert.equal(inserted.project_id, 'project-1');
    assert.equal(inserted.invoice_document_id, 'invoice-doc-1');
    assert.equal(inserted.invoice_line_subject_id, 'fact:invoice-doc-1:line:6');
    assert.equal(inserted.invoice_line_number, '6A');
    assert.equal(inserted.invoice_line_description, 'Hazardous debris removal');
    assert.equal(inserted.invoice_line_billing_code, 'HDR');
    assert.equal(inserted.contract_document_id, 'contract-doc-1');
    assert.equal(inserted.contract_rate_row_id, 'exhibit_a_table:/structural_table:row:5');
    assert.equal(inserted.rate_row_description, 'Hazardous debris haul');
    assert.equal(inserted.rate_row_unit_type, 'per cubic yard');
    assert.equal(inserted.rate_row_rate_amount, 79.52);
    assert.equal(inserted.actor_id, 'user-1');
    assert.equal(inserted.reason, 'Automated matcher missed this row due to description truncation.');
    assert.equal(inserted.is_active, true);
  });

  it('supersedes a prior active link when re-linking the same invoice line', async () => {
    const state = createState();
    state.links.push({
      id: 'old-link-1',
      organization_id: 'org-1',
      project_id: 'project-1',
      invoice_document_id: 'invoice-doc-1',
      invoice_line_subject_id: 'fact:invoice-doc-1:line:6',
      invoice_line_number: '6A',
      invoice_line_description: 'Hazardous debris removal',
      invoice_line_billing_code: 'HDR',
      contract_document_id: 'contract-doc-1',
      contract_rate_row_id: 'rate_row:3',
      rate_row_description: 'Old rate row',
      rate_row_unit_type: 'per ton',
      rate_row_rate_amount: 50.0,
      actor_id: 'user-1',
      reason: 'First attempt',
      is_active: true,
      superseded_by: null,
      created_at: TS,
    });

    const result = await insertManualRateLink({ admin: createAdminMock(state) as never, ...BASE_LINK_INPUT });

    assert.ok(result.ok);
    assert.equal(result.supersededLinkId, 'old-link-1');
    assert.equal(state.links.length, 2, 'exactly two link rows exist');

    const oldLink = state.links.find((l) => l.id === 'old-link-1')!;
    assert.equal(oldLink.is_active, false, 'old link deactivated');
    assert.equal(oldLink.superseded_by, result.linkId, 'old link superseded_by new link id');

    const newLink = state.links.find((l) => l.id === result.linkId)!;
    assert.equal(newLink.is_active, true, 'new link is active');
    assert.equal(newLink.superseded_by, null, 'new link has no superseded_by');
  });
});

// ─── closeManualRateLinkFindings ─────────────────────────────────────────────

describe('closeManualRateLinkFindings', () => {
  beforeEach(() => {
    idCounter = 0;
    vi.clearAllMocks();
    vi.mocked(logActivityEvent).mockResolvedValue({ ok: true, id: 'activity-1' });
  });

  it('resolves the finding directly when no linked_decision_id exists (confirmed current real-world path)', async () => {
    const state = createState();
    state.findings.push({ ...OPEN_FINDING });

    const result = await closeManualRateLinkFindings({ admin: createAdminMock(state) as never, ...CLOSE_INPUT });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.closedFindings, [{
      findingId: 'finding-1',
      ruleId: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
      closurePath: 'direct_update',
    }]);

    const finding = state.findings[0]!;
    assert.equal(finding.status, 'resolved');
    assert.equal(finding.resolved_by_user_id, 'user-1');
    assert.ok(finding.resolved_at, 'resolved_at is set');

    // Explicit audit event is mandatory: finalizeDecision was bypassed so nothing
    // else creates a durable audit record of this resolution.
    assert.ok(vi.mocked(logActivityEvent).mock.calls.length > 0, 'activity event logged');
    const [activityInput] = vi.mocked(logActivityEvent).mock.calls[0]!;
    assert.equal(activityInput.entity_type, 'project_validation_finding');
    assert.equal(activityInput.event_type, 'override_applied');
    assert.equal(activityInput.entity_id, 'finding-1');
    assert.equal(activityInput.changed_by, 'user-1');
    assert.equal(
      (activityInput.new_value as Record<string, unknown>).closure_method,
      'manual_rate_link',
    );
    assert.equal(
      (activityInput.new_value as Record<string, unknown>).contract_rate_row_id,
      'exhibit_a_table:/structural_table:row:5',
    );
  });

  it('closes FINANCIAL_RATE_CODE_MISSING with rule and direct closure attribution', async () => {
    const state = createState();
    state.findings.push({
      ...OPEN_FINDING,
      id: 'financial-finding-1',
      rule_id: 'FINANCIAL_RATE_CODE_MISSING',
    });

    const result = await closeManualRateLinkFindings({
      admin: createAdminMock(state) as never,
      ...CLOSE_INPUT,
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.closedFindings, [{
      findingId: 'financial-finding-1',
      ruleId: 'FINANCIAL_RATE_CODE_MISSING',
      closurePath: 'direct_update',
    }]);
    assert.equal(state.findings[0]?.status, 'resolved');
  });

  it('closes both eligible open rate-link findings for the same invoice line', async () => {
    const state = createState();
    state.findings.push(
      { ...OPEN_FINDING },
      { ...OPEN_FINDING, id: 'financial-finding-1', rule_id: 'FINANCIAL_RATE_CODE_MISSING' },
    );

    const result = await closeManualRateLinkFindings({
      admin: createAdminMock(state) as never,
      ...CLOSE_INPUT,
    });

    assert.deepEqual(result.closedFindings, [
      {
        findingId: 'finding-1',
        ruleId: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
        closurePath: 'direct_update',
      },
      {
        findingId: 'financial-finding-1',
        ruleId: 'FINANCIAL_RATE_CODE_MISSING',
        closurePath: 'direct_update',
      },
    ]);
    assert.equal(state.findings.every((finding) => finding.status === 'resolved'), true);
  });

  it('cascades through finalizeDecision when linked_decision_id is present', async () => {
    vi.mocked(finalizeDecision).mockResolvedValue({
      decision: { id: 'decision-1' },
      linkedFindingIds: ['finding-1'],
      linkedClosure: null as never,
    });

    const state = createState();
    state.findings.push({ ...OPEN_FINDING, linked_decision_id: 'decision-1' });
    state.decisions.push({
      id: 'decision-1',
      organization_id: 'org-1',
      project_id: 'project-1',
      document_id: null,
      status: 'open',
      severity: 'critical',
    });

    const result = await closeManualRateLinkFindings({ admin: createAdminMock(state) as never, ...CLOSE_INPUT });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.closedFindings, [{
      findingId: 'finding-1',
      ruleId: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
      closurePath: 'finalize_decision',
    }]);

    assert.ok(vi.mocked(finalizeDecision).mock.calls.length > 0, 'finalizeDecision was called');
    const [closureInput] = vi.mocked(finalizeDecision).mock.calls[0]!;
    assert.equal(closureInput.status, 'dismissed');
    assert.equal(closureInput.operatorAction, 'manual_rate_link');
    assert.equal(closureInput.decision.id, 'decision-1');
    assert.equal(closureInput.actorId, 'user-1');
  });

  it('returns no_open_finding when no matching open finding exists', async () => {
    const state = createState();
    state.findings.push({ ...OPEN_FINDING, status: 'resolved' });

    const result = await closeManualRateLinkFindings({ admin: createAdminMock(state) as never, ...CLOSE_INPUT });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.closedFindings, []);
  });
});
