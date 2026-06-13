import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildAskOperationsQueryChips,
  computeAskOperationsPortfolioSignals,
} from '@/lib/operationsQuery/askOperationsChips';
import type { OperationalQueueModel } from '@/lib/server/operationalQueue';

function emptyIntel(overrides: Partial<OperationalQueueModel['intelligence']> = {}) {
  return {
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
    ...overrides,
  };
}

function minimalModel(
  rollups: OperationalQueueModel['project_rollups'],
  intelligence?: Partial<OperationalQueueModel['intelligence']>,
  decisions: OperationalQueueModel['decisions'] = [],
): OperationalQueueModel {
  return {
    generated_at: '2024-06-01T12:00:00.000Z',
    recent_documents_count: 0,
    superseded_counts: { decisions: 0, actions: 0 },
    warnings: [],
    decisions,
    actions: [],
    intelligence: emptyIntel(intelligence),
    project_rollups: rollups,
  };
}

describe('askOperationsChips', () => {
  it('falls back to default chips when portfolio has no risk signals', () => {
    const model = minimalModel([]);
    const chips = buildAskOperationsQueryChips(model, 5);
    assert.equal(chips.length, 4);
    assert.ok(chips.some((c) => c.query.includes('NTE')));
  });

  it('surfaces blocked chip when intelligence reports blocked work', () => {
    const model = minimalModel([], { blocked_count: 2 });
    const chips = buildAskOperationsQueryChips(model, 5);
    assert.ok(chips[0]?.severity === 'critical');
    assert.ok(chips.some((c) => c.query.includes('blocked')));
  });

  it('computes NTE risk when utilization exceeds threshold', () => {
    const rollups: OperationalQueueModel['project_rollups'] = [
      {
        project: {
          id: 'p1',
          name: 'P',
          code: 'P',
          status: 'active',
          created_at: '2024-01-01T00:00:00.000Z',
          validation_summary_json: {
            nte_amount: 100,
            total_billed: 90,
          },
        },
        href: '/platform/projects/p1',
        rollup: {
          status: {
            key: 'operationally_clear',
            label: 'Clear',
            tone: 'success',
            detail: '',
            is_clear: true,
          },
          processed_document_count: 1,
          needs_review_document_count: 0,
          open_document_action_count: 0,
          unresolved_finding_count: 0,
          blocked_count: 0,
          anomaly_count: 0,
          project_clear: true,
          pending_actions: [],
          document_status_by_id: {},
        },
      },
    ];
    const s = computeAskOperationsPortfolioSignals(minimalModel(rollups));
    assert.equal(s.hasNteRisk, true);
  });
});
