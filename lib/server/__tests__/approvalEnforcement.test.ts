import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  canProjectProceed,
  canInvoiceProceed,
  createApprovalBlockResponse,
  getBlockingReasons,
} from '../approvalEnforcement';
import * as approvalSnapshots from '../approvalSnapshots';
import type { ProjectApprovalSnapshot, InvoiceApprovalSnapshot } from '../approvalSnapshots';

// Mock approvalSnapshots module
vi.mock('../approvalSnapshots', () => ({
  getLatestApprovalSnapshot: vi.fn(),
}));

describe('approvalEnforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('canProjectProceed', () => {
    it('returns allowed when no snapshot exists (backward compatibility)', async () => {
      vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockResolvedValue(null);

      const result = await canProjectProceed('project-123');

      expect(result.status).toBe('allowed');
      expect(result.snapshot).toBeNull();
    });

    it('returns blocked when snapshot has blocked status', async () => {
      const snapshot: ProjectApprovalSnapshot = {
        project_id: 'project-123',
        approval_status: 'blocked',
        total_billed: 10000,
        total_supported: 8000,
        at_risk_amount: 2000,
        blocked_amount: 5000,
        invoice_count: 3,
        blocked_invoice_count: 1,
        needs_review_invoice_count: 0,
        approved_invoice_count: 2,
        finding_ids: ['finding-1', 'finding-2'],
        billing_group_ids: null,
        validation_trigger_source: 'manual',
        created_at: new Date().toISOString(),
      };

      vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockResolvedValue(snapshot);

      const result = await canProjectProceed('project-123');

      expect(result.status).toBe('blocked');
      expect(result.snapshot).toBe(snapshot);
      expect(result.reason).toContain('blocked');
      expect(result.reason).toContain('$50.00');
    });

    it('returns blocked when snapshot has needs_review status', async () => {
      const snapshot: ProjectApprovalSnapshot = {
        project_id: 'project-123',
        approval_status: 'needs_review',
        total_billed: 10000,
        total_supported: 8000,
        at_risk_amount: 2000,
        blocked_amount: null,
        invoice_count: 3,
        blocked_invoice_count: 0,
        needs_review_invoice_count: 2,
        approved_invoice_count: 1,
        finding_ids: [],
        billing_group_ids: null,
        validation_trigger_source: 'auto',
        created_at: new Date().toISOString(),
      };

      vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockResolvedValue(snapshot);

      const result = await canProjectProceed('project-123');

      expect(result.status).toBe('blocked');
      expect(result.snapshot).toBe(snapshot);
      expect(result.reason).toContain('needs_review');
      expect(result.reason).toContain('2 invoices');
    });

    it('returns allowed when snapshot has approved status', async () => {
      const snapshot: ProjectApprovalSnapshot = {
        project_id: 'project-123',
        approval_status: 'approved',
        total_billed: 10000,
        total_supported: 10000,
        at_risk_amount: 0,
        blocked_amount: null,
        invoice_count: 3,
        blocked_invoice_count: 0,
        needs_review_invoice_count: 0,
        approved_invoice_count: 3,
        finding_ids: [],
        billing_group_ids: null,
        validation_trigger_source: 'auto',
        created_at: new Date().toISOString(),
      };

      vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockResolvedValue(snapshot);

      const result = await canProjectProceed('project-123');

      expect(result.status).toBe('allowed');
      expect(result.snapshot).toBe(snapshot);
    });

    it('returns unknown with error when snapshot query fails (fail-closed)', async () => {
      vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockRejectedValue(
        new Error('Database error'),
      );

      const result = await canProjectProceed('project-123');

      expect(result.status).toBe('unknown');
      expect(result.error).toContain('Could not determine approval status');
    });
  });

  describe('canInvoiceProceed', () => {
    it('returns blocked when project is blocked (enforcement order)', async () => {
      const projectSnapshot: ProjectApprovalSnapshot = {
        project_id: 'project-123',
        approval_status: 'blocked',
        total_billed: 10000,
        total_supported: 8000,
        at_risk_amount: 2000,
        blocked_amount: 5000,
        invoice_count: 2,
        blocked_invoice_count: 1,
        needs_review_invoice_count: 0,
        approved_invoice_count: 1,
        finding_ids: ['finding-1'],
        billing_group_ids: null,
        validation_trigger_source: 'manual',
        created_at: new Date().toISOString(),
      };

      vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockResolvedValue(projectSnapshot);

      const result = await canInvoiceProceed('project-123', 'INV-001');

      expect(result.status).toBe('blocked');
      expect(result.snapshot).toBe(projectSnapshot);
      expect(result.reason).toContain('Cannot approve invoice');
    });

    it('returns unknown when project snapshot query fails (fail-closed)', async () => {
      vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockRejectedValue(
        new Error('Database error'),
      );

      const result = await canInvoiceProceed('project-123', 'INV-001');

      expect(result.status).toBe('unknown');
      expect(result.error).toContain('Could not determine approval status');
    });

    it('returns allowed when project and invoice are both approved', async () => {
      const projectSnapshot: ProjectApprovalSnapshot = {
        project_id: 'project-123',
        approval_status: 'approved',
        total_billed: 10000,
        total_supported: 10000,
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
      };

      vi.mocked(approvalSnapshots.getLatestApprovalSnapshot).mockResolvedValue(projectSnapshot);

      const result = await canInvoiceProceed('project-123', 'INV-001');

      expect(result.status).toBe('allowed');
      expect(result.snapshot).toBeNull(); // No invoice snapshot yet
    });
  });

  describe('createApprovalBlockResponse', () => {
    it('returns 409 Conflict response with reason', () => {
      const response = createApprovalBlockResponse('Project is blocked');

      expect(response.status).toBe(409);
      const contentType = response.headers.get('Content-Type');
      expect(contentType).toContain('application/json');
    });

    it('includes blocked amount in response body when provided', async () => {
      const response = createApprovalBlockResponse('Project is blocked', 5000);
      const body = await response.json();

      expect(body.blocked_amount).toBe(5000);
      expect(body.reason).toBe('Project is blocked');
      expect(body.error).toBe('Approval gate: action blocked');
    });

    it('includes timestamp in response', async () => {
      const response = createApprovalBlockResponse('Project is blocked');
      const body = await response.json();

      expect(body.timestamp).toBeDefined();
      // Verify it's a valid ISO timestamp
      expect(new Date(body.timestamp)).not.toBeNaN();
    });
  });

  describe('getBlockingReasons', () => {
    it('returns blocking_reasons from invoice snapshot when available', () => {
      const snapshot: InvoiceApprovalSnapshot = {
        project_id: 'project-123',
        invoice_number: 'INV-001',
        approval_status: 'blocked',
        billed_amount: 5000,
        supported_amount: 4000,
        at_risk_amount: 1000,
        reconciliation_status: 'pending',
        blocking_reasons: ['missing_transaction_support', 'rate_mismatch'],
        billing_group_ids: null,
        created_at: new Date().toISOString(),
      };

      const reasons = getBlockingReasons(snapshot);

      expect(reasons).toEqual(['missing_transaction_support', 'rate_mismatch']);
    });

    it('limits to top 3 reasons from invoice snapshot', () => {
      const snapshot: InvoiceApprovalSnapshot = {
        project_id: 'project-123',
        invoice_number: 'INV-001',
        approval_status: 'blocked',
        billed_amount: 5000,
        supported_amount: 4000,
        at_risk_amount: 1000,
        reconciliation_status: 'pending',
        blocking_reasons: [
          'reason_1',
          'reason_2',
          'reason_3',
          'reason_4',
          'reason_5',
        ],
        billing_group_ids: null,
        created_at: new Date().toISOString(),
      };

      const reasons = getBlockingReasons(snapshot);

      expect(reasons).toHaveLength(3);
      expect(reasons).toEqual(['reason_1', 'reason_2', 'reason_3']);
    });

    it('constructs reasons from project snapshot approval_status', () => {
      const snapshot: ProjectApprovalSnapshot = {
        project_id: 'project-123',
        approval_status: 'needs_review',
        total_billed: 10000,
        total_supported: 8000,
        at_risk_amount: 2000,
        blocked_amount: null,
        invoice_count: 3,
        blocked_invoice_count: 0,
        needs_review_invoice_count: 2,
        approved_invoice_count: 1,
        finding_ids: [],
        billing_group_ids: null,
        validation_trigger_source: 'auto',
        created_at: new Date().toISOString(),
      };

      const reasons = getBlockingReasons(snapshot);

      expect(reasons).toContain('2 invoice(s) need review');
    });

    it('returns default reason when snapshot is null or empty', () => {
      const reasons = getBlockingReasons(null as any);

      expect(reasons).toEqual(['Approval required']);
    });
  });
});
