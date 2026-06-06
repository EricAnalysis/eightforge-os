import { describe, expect, it } from 'vitest';

import {
  processedDocsEmptyState,
  processedDocsSubtitle,
} from '@/lib/projectOverviewCopy';
import { approvalPanelReconciliationDisplay } from '@/components/projects/ProjectOverview';
import type { ProjectOverviewModel } from '@/lib/projectOverview';

const baseModel: ProjectOverviewModel = {
  project: {
    id: 'project-1',
    name: 'Project',
    code: 'P-1',
    status: 'active',
    created_at: '2026-03-20T00:00:00Z',
  },
  context_label: 'Project overview',
  title: 'Project',
  project_id_label: 'P-1',
  tags: [],
  status: {
    key: 'needs_review',
    label: 'Needs Review',
    tone: 'warning',
    detail: 'Needs review',
    is_clear: false,
  },
  validator_status: 'NOT_READY',
  validator_summary: {
    status: 'NOT_READY',
    critical_count: 0,
    warning_count: 0,
    requires_review_count: 0,
    info_count: 0,
    open_count: 0,
    required_review_total: 0,
    blocked_reasons: [],
    trigger_source: null,
    nte_amount: null,
    total_billed: null,
    total_at_risk: null,
    requires_verification_amount: null,
    unsupported_amount: null,
    validator_readiness: null,
    reconciliation_overall: null,
    invoice_summaries: [],
    approval_blocker_count: 0,
    blocked_amount: null,
  },
  exposure: {
    percent: null,
    bar_percent: 0,
    percent_label: 'Awaiting data',
    limit_label: 'No contract ceiling yet',
    actual_label: 'No matched billing yet',
    detail: 'Awaiting data',
    help_href: null,
    help_label: null,
    tone: 'muted',
    derived: false,
  },
  metrics: [],
  facts: [],
  decisions: [],
  decision_total: 0,
  decision_empty_state: 'none',
  actions: [],
  action_total: 0,
  action_empty_state: 'none',
  documents: [],
  document_total: 0,
  document_empty_state: 'Documents are linked, but none have completed processing yet.',
  audit: [],
  audit_empty_state: 'none',
};

describe('project overview processed-doc copy', () => {
  it('describes processed document totals consistently when documents are present', () => {
    const model: ProjectOverviewModel = {
      ...baseModel,
      documents: [
        {
          id: 'doc-1',
          href: '/platform/documents/doc-1',
          title: 'Doc 1',
          detail: 'Contract',
          processed_label: '1h ago',
          status_label: 'Processed',
          status_tone: 'success',
        },
        {
          id: 'doc-2',
          href: '/platform/documents/doc-2',
          title: 'Doc 2',
          detail: 'Invoice',
          processed_label: '2h ago',
          status_label: 'Processed',
          status_tone: 'success',
        },
      ],
      document_total: 5,
    };

    expect(processedDocsSubtitle(model)).toBe(
      '5 processed documents in the project record, showing 2 most recent',
    );
  });

  it('shows a trust-preserving empty-state message when totals and rendered docs drift apart', () => {
    const model: ProjectOverviewModel = {
      ...baseModel,
      document_total: 3,
    };

    expect(processedDocsEmptyState(model)).toContain('Refresh to resync');
  });
});

describe('project overview reconciliation display', () => {
  it('maps Golden Project canonical MATCH to Reconciled', () => {
    const model: ProjectOverviewModel = {
      ...baseModel,
      project: {
        ...baseModel.project,
        name: 'Williamson / Aftermath',
      },
      validator_summary: {
        ...baseModel.validator_summary,
        status: 'VALIDATED',
        validator_readiness: 'READY',
        total_billed: 815_559.35,
        total_at_risk: 0,
        requires_verification_amount: 0,
        reconciliation_overall: 'MATCH',
        invoice_summaries: [
          {
            invoice_number: '2026-002',
            approval_status: 'approved',
            billed_amount: 400_000,
            supported_amount: 400_000,
            at_risk_amount: 0,
            requires_verification_amount: 0,
            reconciliation_status: 'MATCH',
          },
          {
            invoice_number: '2026-003',
            approval_status: 'approved',
            billed_amount: 415_559.35,
            supported_amount: 415_559.35,
            at_risk_amount: 0,
            requires_verification_amount: 0,
            reconciliation_status: 'MATCH',
          },
        ],
      },
    };

    expect(approvalPanelReconciliationDisplay(model)).toBe('Reconciled');
  });

  it('maps canonical PARTIAL to Partial even when the old fully-supported recompute would pass', () => {
    const model: ProjectOverviewModel = {
      ...baseModel,
      validator_summary: {
        ...baseModel.validator_summary,
        status: 'VALIDATED',
        validator_readiness: 'READY',
        total_billed: 815_559.35,
        total_at_risk: 0,
        requires_verification_amount: 0,
        reconciliation_overall: 'PARTIAL',
        approval_blocker_count: 0,
        invoice_summaries: [
          {
            invoice_number: '2026-002',
            approval_status: 'approved',
            billed_amount: 400_000,
            supported_amount: 400_000,
            at_risk_amount: 0,
            requires_verification_amount: 0,
            reconciliation_status: 'MATCH',
          },
          {
            invoice_number: '2026-003',
            approval_status: 'approved',
            billed_amount: 415_559.35,
            supported_amount: 415_559.35,
            at_risk_amount: 0,
            requires_verification_amount: 0,
            reconciliation_status: 'MATCH',
          },
        ],
      },
    };

    expect(approvalPanelReconciliationDisplay(model)).toBe('Partial');
  });

  it('hides canonical MISSING reconciliation state', () => {
    const model: ProjectOverviewModel = {
      ...baseModel,
      validator_summary: {
        ...baseModel.validator_summary,
        reconciliation_overall: 'MISSING',
      },
    };

    expect(approvalPanelReconciliationDisplay(model)).toBeNull();
  });
});
