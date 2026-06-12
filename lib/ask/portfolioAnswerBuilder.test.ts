import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { buildPortfolioAskAnswer } from '@/lib/ask/portfolioAnswerBuilder';

describe('portfolio ask answer builder', () => {
  it('presents upstream portfolio exposure and pattern aggregates without recomputing them from affected projects', () => {
    const response = buildPortfolioAskAnswer({
      question: 'What needs portfolio attention?',
      promptVersion: 'test',
      stalenessByProjectId: new Map(),
      portfolio: {
        totalProjects: 2,
        totalRequiresVerification: 0,
        totalAtRisk: 1000,
        totalBlocked: 0,
        projectsByStatus: {
          healthy: 0,
          at_risk: 1,
          blocked: 1,
          requires_review: 0,
        },
        topRiskProjects: [
          {
            projectId: 'project-1',
            projectName: 'Project One',
            projectCode: 'P1',
            status: 'blocked',
            requiresVerificationAmount: 0,
            atRiskAmount: 100,
            blockedAmount: 0,
            blockedInvoices: 0,
            totalInvoices: 0,
            issuesCount: 0,
            rateMismatchCount: 0,
            missingSupportCount: 0,
            quantityMismatchCount: 0,
            lastActivityAt: '2026-04-02T12:00:00.000Z',
            overdueActionsCount: 0,
            riskScore: 90,
            priority: 'critical',
          },
        ],
        vendorRiskSummary: [],
        issueTypeRanking: [
          {
            type: 'rate_mismatch',
            count: 3,
            percentage: 100,
          },
        ],
        recentActivity: [],
      },
      operations: {
        generated_at: '2026-04-02T12:00:00.000Z',
        recent_documents_count: null,
        superseded_counts: {
          decisions: 0,
          actions: 0,
        },
        warnings: [],
        decisions: [],
        actions: [],
        intelligence: {
          open_decisions_count: 0,
          open_actions_count: 0,
          needs_review_count: 0,
          blocked_count: 0,
          high_risk_count: 0,
          recent_feedback_exception_count: 0,
          low_trust_document_count: 0,
          recent_feedback_exceptions: [],
          low_trust_documents: [],
          needs_review_documents: [],
          blocked_documents: [],
        },
        project_rollups: [
          {
            href: '/platform/projects/project-1',
            project: {
              id: 'project-1',
              name: 'Project One',
              code: 'P1',
              status: 'active',
              created_at: '2026-04-01T12:00:00.000Z',
              validation_status: 'BLOCKED',
              validation_summary_json: null,
            },
            rollup: {
              status: {
                key: 'blocked',
                label: 'Blocked',
                tone: 'danger',
                detail: 'Blocked by upstream rollup.',
                is_clear: false,
              },
              processed_document_count: 0,
              needs_review_document_count: 0,
              open_document_action_count: 2,
              unresolved_finding_count: 1,
              blocked_count: 1,
              anomaly_count: 0,
              project_clear: false,
              pending_actions: [
                {
                  id: 'action-1',
                  href: '/platform/projects/project-1#project-execution',
                  title: 'Action 1',
                  due_label: 'Resolvable Now',
                  due_tone: 'warning',
                  assignee_label: 'Unassigned',
                  priority_label: 'High',
                  priority_tone: 'warning',
                  status_label: 'Open',
                },
                {
                  id: 'action-2',
                  href: '/platform/projects/project-1#project-execution',
                  title: 'Action 2',
                  due_label: 'Resolvable Now',
                  due_tone: 'warning',
                  assignee_label: 'Unassigned',
                  priority_label: 'High',
                  priority_tone: 'warning',
                  status_label: 'Open',
                },
              ],
              document_status_by_id: {},
            },
          },
        ],
      },
    });

    assert.equal(response.portfolioSections?.financialExposure.totalAtRiskAmount, 1000);
    assert.match(response.answer ?? '', /Total at risk amount: \$1,000\./);
    assert.equal(response.portfolioSections?.projectsAffected[0]?.openExecutionItemCount, 2);
    assert.equal(response.portfolioSections?.patternDetected.label, 'Repeated rate mismatch aggregate across 3 canonical finding signals.');
    assert.deepEqual(response.portfolioSections?.patternDetected.affectedProjects, []);
  });
});
