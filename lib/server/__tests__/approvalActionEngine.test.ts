import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  planApprovalActions,
  executeApprovalActions,
  type ApprovalAction,
} from '../approvalActionEngine';
import * as approvalSnapshots from '../approvalSnapshots';
import type { ProjectApprovalSnapshot, InvoiceApprovalSnapshot } from '../approvalSnapshots';

// Mock approvalSnapshots module
vi.mock('../approvalSnapshots', () => ({
  getLatestApprovalSnapshot: vi.fn(),
}));

// Mock supabaseAdmin — provide a chainable builder that resolves to { data, error }
vi.mock('../supabaseAdmin', () => {
  const makeChain = (resolution: { data: unknown; error: unknown }) => {
    const chain = {
      from: () => chain,
      select: () => chain,
      insert: () => chain,
      update: () => chain,
      eq: () => chain,
      in: () => chain,
      limit: () => chain,
      order: () => chain,
      maybeSingle: () => Promise.resolve(resolution),
      single: () => Promise.resolve(resolution),
    };
    return chain;
  };

  return {
    getSupabaseAdmin: vi.fn(() => makeChain({ data: null, error: null })),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProjectSnapshot(
  overrides: Partial<ProjectApprovalSnapshot> = {},
): ProjectApprovalSnapshot {
  return {
    id: 'snap-001',
    project_id: 'project-123',
    approval_status: 'approved',
    total_billed: 100000,
    total_supported: 100000,
    at_risk_amount: 0,
    blocked_amount: null,
    invoice_count: 2,
    blocked_invoice_count: 0,
    needs_review_invoice_count: 0,
    approved_invoice_count: 2,
    finding_ids: [],
    billing_group_ids: null,
    validation_trigger_source: 'auto',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeInvoiceSnapshot(
  overrides: Partial<InvoiceApprovalSnapshot> = {},
): InvoiceApprovalSnapshot {
  return {
    project_id: 'project-123',
    invoice_number: 'INV-001',
    approval_status: 'approved',
    billed_amount: 50000,
    supported_amount: 50000,
    at_risk_amount: 0,
    reconciliation_status: 'matched',
    blocking_reasons: [],
    billing_group_ids: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// planApprovalActions — pure function tests
// ---------------------------------------------------------------------------

describe('planApprovalActions', () => {
  describe('blocked status', () => {
    it('creates requires_verification_review per blocked invoice', () => {
      const snapshot = makeProjectSnapshot({
        approval_status: 'blocked',
        blocked_amount: 3187500,
        blocked_invoice_count: 1,
      });
      const invoice = makeInvoiceSnapshot({
        invoice_number: 'INV-003',
        approval_status: 'blocked',
        billed_amount: 3187500,
        at_risk_amount: 1187500,
        blocking_reasons: ['rate_mismatch'],
      });

      const actions = planApprovalActions(snapshot, [invoice]);

      const reviewAction = actions.find(
        (a) => a.action_type === 'requires_verification_review',
      );
      expect(reviewAction).toBeDefined();
      expect(reviewAction?.invoice_number).toBe('INV-003');
      expect(reviewAction?.amount).toBe(3187500);
      expect(reviewAction?.priority).toBe('critical');
      expect(reviewAction?.reason).toContain('INV-003');
      expect(reviewAction?.reason).toContain('rate_mismatch');
    });

    it('creates one requires_verification_review per blocked invoice', () => {
      const snapshot = makeProjectSnapshot({
        approval_status: 'blocked',
        blocked_invoice_count: 2,
      });
      const invoices = [
        makeInvoiceSnapshot({ invoice_number: 'INV-001', approval_status: 'blocked' }),
        makeInvoiceSnapshot({ invoice_number: 'INV-002', approval_status: 'blocked' }),
        makeInvoiceSnapshot({ invoice_number: 'INV-003', approval_status: 'approved' }),
      ];

      const actions = planApprovalActions(snapshot, invoices);

      const reviewActions = actions.filter(
        (a) => a.action_type === 'requires_verification_review',
      );
      expect(reviewActions).toHaveLength(2);
      expect(reviewActions.map((a) => a.invoice_number)).toContain('INV-001');
      expect(reviewActions.map((a) => a.invoice_number)).toContain('INV-002');
    });

    it('creates project-level requires_verification_review when no invoice snapshots', () => {
      const snapshot = makeProjectSnapshot({
        approval_status: 'blocked',
        blocked_amount: 5000000,
        blocked_invoice_count: 2,
      });

      const actions = planApprovalActions(snapshot, []);

      const reviewAction = actions.find(
        (a) => a.action_type === 'requires_verification_review',
      );
      expect(reviewAction?.invoice_number).toBeNull();
      expect(reviewAction?.amount).toBe(5000000);
    });

    it('always creates flag_project action at high priority', () => {
      const snapshot = makeProjectSnapshot({ approval_status: 'blocked' });

      const actions = planApprovalActions(snapshot, []);

      const flagAction = actions.find((a) => a.action_type === 'flag_project');
      expect(flagAction).toBeDefined();
      expect(flagAction?.priority).toBe('high');
      expect(flagAction?.invoice_number).toBeNull();
    });

    it('always creates notify_operator action at high priority', () => {
      const snapshot = makeProjectSnapshot({ approval_status: 'blocked' });

      const actions = planApprovalActions(snapshot, []);

      const notifyAction = actions.find((a) => a.action_type === 'notify_operator');
      expect(notifyAction).toBeDefined();
      expect(notifyAction?.priority).toBe('high');
    });

    it('formats blocked amount as currency in reason', () => {
      const snapshot = makeProjectSnapshot({
        approval_status: 'blocked',
        blocked_amount: 3187500, // $31,875.00
      });

      const actions = planApprovalActions(snapshot, []);

      const notifyAction = actions.find((a) => a.action_type === 'notify_operator');
      expect(notifyAction?.reason).toContain('$31875.00');
    });
  });

  describe('needs_review status', () => {
    it('creates needs_review_queue per needs_review invoice', () => {
      const snapshot = makeProjectSnapshot({
        approval_status: 'needs_review',
        at_risk_amount: 1500000,
        needs_review_invoice_count: 1,
      });
      const invoice = makeInvoiceSnapshot({
        invoice_number: 'INV-002',
        approval_status: 'needs_review',
        at_risk_amount: 1500000,
      });

      const actions = planApprovalActions(snapshot, [invoice]);

      const queueAction = actions.find((a) => a.action_type === 'needs_review_queue');
      expect(queueAction).toBeDefined();
      expect(queueAction?.invoice_number).toBe('INV-002');
      expect(queueAction?.priority).toBe('medium');
      expect(queueAction?.reason).toContain('INV-002');
    });

    it('creates assign_analyst action at medium priority', () => {
      const snapshot = makeProjectSnapshot({
        approval_status: 'needs_review',
        needs_review_invoice_count: 2,
      });

      const actions = planApprovalActions(snapshot, []);

      const analystAction = actions.find((a) => a.action_type === 'assign_analyst');
      expect(analystAction).toBeDefined();
      expect(analystAction?.priority).toBe('medium');
      expect(analystAction?.invoice_number).toBeNull();
    });

    it('treats approved_with_exceptions same as needs_review', () => {
      const snapshot = makeProjectSnapshot({ approval_status: 'approved_with_exceptions' });

      const actions = planApprovalActions(snapshot, []);

      expect(actions.some((a) => a.action_type === 'needs_review_queue')).toBe(true);
      expect(actions.some((a) => a.action_type === 'assign_analyst')).toBe(true);
    });

    it('does not create blocked-status actions for needs_review projects', () => {
      const snapshot = makeProjectSnapshot({ approval_status: 'needs_review' });

      const actions = planApprovalActions(snapshot, []);

      expect(actions.some((a) => a.action_type === 'requires_verification_review')).toBe(false);
      expect(actions.some((a) => a.action_type === 'flag_project')).toBe(false);
      expect(actions.some((a) => a.action_type === 'notify_operator')).toBe(false);
    });
  });

  describe('approved status', () => {
    it('creates mark_project_ready action at low priority', () => {
      const snapshot = makeProjectSnapshot({
        approval_status: 'approved',
        total_billed: 200000,
        approved_invoice_count: 4,
      });

      const actions = planApprovalActions(snapshot);

      const readyAction = actions.find((a) => a.action_type === 'mark_project_ready');
      expect(readyAction).toBeDefined();
      expect(readyAction?.priority).toBe('low');
      expect(readyAction?.amount).toBe(200000);
      expect(readyAction?.reason).toContain('4 invoice(s)');
    });

    it('creates generate_approval_log action at low priority', () => {
      const snapshot = makeProjectSnapshot({ approval_status: 'approved' });

      const actions = planApprovalActions(snapshot);

      const logAction = actions.find((a) => a.action_type === 'generate_approval_log');
      expect(logAction).toBeDefined();
      expect(logAction?.priority).toBe('low');
    });

    it('does not create any blocked/review actions for approved projects', () => {
      const snapshot = makeProjectSnapshot({ approval_status: 'approved' });

      const actions = planApprovalActions(snapshot, []);

      const types = actions.map((a) => a.action_type);
      expect(types).not.toContain('requires_verification_review');
      expect(types).not.toContain('flag_project');
      expect(types).not.toContain('notify_operator');
      expect(types).not.toContain('needs_review_queue');
      expect(types).not.toContain('assign_analyst');
    });
  });

  describe('not_evaluated status', () => {
    it('returns empty actions list', () => {
      const snapshot = makeProjectSnapshot({ approval_status: 'not_evaluated' });

      const actions = planApprovalActions(snapshot);

      expect(actions).toHaveLength(0);
    });
  });

  describe('action shapes', () => {
    it('all actions carry the correct project_id', () => {
      const snapshot = makeProjectSnapshot({
        approval_status: 'blocked',
        project_id: 'project-xyz',
      });

      const actions = planApprovalActions(snapshot, []);

      for (const action of actions) {
        expect(action.project_id).toBe('project-xyz');
      }
    });

    it('blocked invoice action includes blocking_reasons in reason text', () => {
      const snapshot = makeProjectSnapshot({ approval_status: 'blocked' });
      const invoice = makeInvoiceSnapshot({
        approval_status: 'blocked',
        blocking_reasons: ['rate_mismatch', 'missing_transaction_support', 'extra_reason'],
      });

      const actions = planApprovalActions(snapshot, [invoice]);

      const reviewAction = actions.find(
        (a) => a.action_type === 'requires_verification_review',
      );
      // Should include up to 3 reasons
      expect(reviewAction?.reason).toContain('rate_mismatch');
      expect(reviewAction?.reason).toContain('missing_transaction_support');
    });

    it('amounts are in cents (integer, not dollars)', () => {
      const snapshot = makeProjectSnapshot({
        approval_status: 'approved',
        total_billed: 10050, // $100.50
      });

      const actions = planApprovalActions(snapshot);

      const readyAction = actions.find((a) => a.action_type === 'mark_project_ready');
      // Amount stored in cents
      expect(readyAction?.amount).toBe(10050);
    });
  });
});

// ---------------------------------------------------------------------------
// executeApprovalActions — integration-style tests with mocked DB
// ---------------------------------------------------------------------------

describe('executeApprovalActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_evaluated when no snapshot exists', async () => {
    vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockResolvedValue(null);

    const result = await executeApprovalActions({
      projectId: 'project-123',
      organizationId: 'org-abc',
    });

    expect(result.approval_status).toBe('not_evaluated');
    expect(result.actions_planned).toHaveLength(0);
    expect(result.tasks_created).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('returns not_evaluated when snapshot status is not_evaluated', async () => {
    vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockResolvedValue(
      makeProjectSnapshot({ approval_status: 'not_evaluated' }),
    );

    const result = await executeApprovalActions({
      projectId: 'project-123',
      organizationId: 'org-abc',
    });

    expect(result.approval_status).toBe('not_evaluated');
    expect(result.actions_planned).toHaveLength(0);
  });

  it('uses provided snapshot directly without querying DB', async () => {
    const snapshot = makeProjectSnapshot({ approval_status: 'approved' });

    await executeApprovalActions({
      projectId: 'project-123',
      organizationId: 'org-abc',
      snapshot,
    });

    // getLatestApprovalSnapshot should never be called when snapshot is provided
    expect(approvalSnapshots.getLatestApprovalSnapshot).not.toHaveBeenCalled();
  });

  it('returns error gracefully when admin client is unavailable', async () => {
    const { getSupabaseAdmin } = await import('../supabaseAdmin');
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(null as any);

    const result = await executeApprovalActions({
      projectId: 'project-123',
      organizationId: 'org-abc',
      snapshot: makeProjectSnapshot({ approval_status: 'blocked' }),
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Server not configured');
  });

  it('includes executed_at timestamp in result', async () => {
    vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockResolvedValue(
      makeProjectSnapshot({ approval_status: 'approved' }),
    );

    const before = new Date().toISOString();
    const result = await executeApprovalActions({
      projectId: 'project-123',
      organizationId: 'org-abc',
    });
    const after = new Date().toISOString();

    expect(result.executed_at).toBeDefined();
    expect(result.executed_at >= before).toBe(true);
    expect(result.executed_at <= after).toBe(true);
  });

  it('sets approval_status in result from snapshot', async () => {
    vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockResolvedValue(
      makeProjectSnapshot({ approval_status: 'needs_review' }),
    );

    const result = await executeApprovalActions({
      projectId: 'project-123',
      organizationId: 'org-abc',
    });

    expect(result.approval_status).toBe('needs_review');
  });

  it('uses provided invoiceSnapshots directly without querying', async () => {
    const snapshot = makeProjectSnapshot({
      approval_status: 'blocked',
      blocked_invoice_count: 1,
      invoice_count: 1,
    });
    const invoice = makeInvoiceSnapshot({
      approval_status: 'blocked',
      invoice_number: 'INV-003',
    });

    const result = await executeApprovalActions({
      projectId: 'project-123',
      organizationId: 'org-abc',
      snapshot,
      invoiceSnapshots: [invoice],
    });

    const reviewActions = result.actions_planned.filter(
      (a) => a.action_type === 'requires_verification_review',
    );
    expect(reviewActions[0]?.invoice_number).toBe('INV-003');
  });
});

// ---------------------------------------------------------------------------
// Decision → action mapping table (example flow verification)
// ---------------------------------------------------------------------------

describe('decision to action mapping', () => {
  it('blocked → 3 project actions when no invoice snapshots', () => {
    const snapshot = makeProjectSnapshot({ approval_status: 'blocked' });
    const actions = planApprovalActions(snapshot, []);

    const types = actions.map((a) => a.action_type);
    expect(types).toContain('requires_verification_review');
    expect(types).toContain('flag_project');
    expect(types).toContain('notify_operator');
  });

  it('blocked with 2 invoices → 4 actions (2 per-invoice + flag + notify)', () => {
    const snapshot = makeProjectSnapshot({
      approval_status: 'blocked',
      blocked_invoice_count: 2,
    });
    const invoices = [
      makeInvoiceSnapshot({ invoice_number: 'INV-001', approval_status: 'blocked' }),
      makeInvoiceSnapshot({ invoice_number: 'INV-002', approval_status: 'blocked' }),
    ];

    const actions = planApprovalActions(snapshot, invoices);

    expect(actions).toHaveLength(4);
  });

  it('needs_review → 2 actions (queue + assign)', () => {
    const snapshot = makeProjectSnapshot({ approval_status: 'needs_review' });
    const actions = planApprovalActions(snapshot, []);

    const types = actions.map((a) => a.action_type);
    expect(types).toContain('needs_review_queue');
    expect(types).toContain('assign_analyst');
    expect(actions).toHaveLength(2);
  });

  it('approved → 2 actions (ready + log)', () => {
    const snapshot = makeProjectSnapshot({ approval_status: 'approved' });
    const actions = planApprovalActions(snapshot, []);

    const types = actions.map((a) => a.action_type);
    expect(types).toContain('mark_project_ready');
    expect(types).toContain('generate_approval_log');
    expect(actions).toHaveLength(2);
  });

  it('example flow: INV-003 $31,875 requires verification', () => {
    // Mirrors the example from the Phase 10 spec:
    // "Review invoice INV-003 — $31,875 requires verification"
    const snapshot = makeProjectSnapshot({
      approval_status: 'blocked',
      blocked_amount: 3187500, // $31,875.00
      blocked_invoice_count: 1,
    });
    const invoice = makeInvoiceSnapshot({
      invoice_number: 'INV-003',
      approval_status: 'blocked',
      billed_amount: 3187500,
    });

    const actions = planApprovalActions(snapshot, [invoice]);

    const reviewAction = actions.find(
      (a) =>
        a.action_type === 'requires_verification_review' &&
        a.invoice_number === 'INV-003',
    );

    expect(reviewAction).toBeDefined();
    expect(reviewAction?.amount).toBe(3187500);
    expect(reviewAction?.priority).toBe('critical');
    // Title will be: "Review invoice INV-003 — $31875.00: verification required"
    // (exact title built in buildTaskTitle inside engine, not exposed here)
    expect(reviewAction?.reason).toContain('INV-003');
  });
});
