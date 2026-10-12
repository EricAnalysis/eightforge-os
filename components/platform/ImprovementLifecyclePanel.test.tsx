import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { attestableRequests, DECISIONS_BY_OUTCOME, deployedFixState, type LifecycleView } from './ImprovementLifecyclePanel';

const request = (reviewId: string, current = true) => ({ reviewId, reviewVersion: 1, planV2RunId: 'run', planV2DigestSha256: 'd',
  recommendationId: `rec_${reviewId}`, disposition: 'accepted', current, linearStatus: null, linearIssueIdentifier: null });
const view = (overrides: Partial<LifecycleView> = {}): LifecycleView => ({
  submissionId: 's1', measurable: true, engineeringRequests: [], events: [], snapshots: [], decisions: [], successors: [],
  predecessor: null, ...overrides });

describe('improvement lifecycle panel (B8.4d)', () => {
  it('offers attestation only for current approved requests not yet attested', () => {
    const state = view({ engineeringRequests: [request('r1'), request('r2'), request('r3', false)],
      events: [{ id: 'e1', event_kind: 'implemented', engineering_review_id: 'r1' }] });
    expect(attestableRequests(state).map((entry) => entry.reviewId)).toEqual(['r2']);
  });

  it('measures until completion, then offers only the decisions the outcome allows', () => {
    const deployed = { id: 'd1', event_kind: 'deployed' };
    const open = deployedFixState(view({ events: [deployed] }), 'd1');
    expect(open).toMatchObject({ canMeasure: true, completedSnapshot: null, allowedDecisions: [] });
    const completed = view({ events: [deployed, { id: 'c1', event_kind: 'measurement_completed', deployed_event_id: 'd1',
      measurement_snapshot_id: 'snap' }], snapshots: [{ id: 'snap', deployed_event_id: 'd1', outcome: 'recurred' }],
      decisions: [{ id: 'dec1', deployed_event_id: 'd1', decision_version: 1, decision: 'recurred_confirmed' }] });
    const state = deployedFixState(completed, 'd1');
    expect(state).toMatchObject({ canMeasure: false, allowedDecisions: ['recurred_confirmed', 'deferred'],
      latestDecisionVersion: 1, successorMissing: true });
    expect(deployedFixState({ ...completed, successors: [{ id: 'l1', decision_id: 'dec1' }] }, 'd1').successorMissing).toBe(false);
    // Never "resolved" without a resolution candidate, and never on an inconclusive outcome.
    expect(DECISIONS_BY_OUTCOME.recurred).not.toContain('resolved');
    expect(DECISIONS_BY_OUTCOME.confounded).toEqual(['deferred']);
    expect(DECISIONS_BY_OUTCOME).not.toHaveProperty('insufficient_exposure');
    expect(DECISIONS_BY_OUTCOME).not.toHaveProperty('unmeasurable');
  });

  it('never claims deployment, auto-closes, or treats Linear as authority', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'components/platform/ImprovementLifecyclePanel.tsx'), 'utf8');
    for (const text of ['Attest fix commit', 'Measure now', 'Record decision', '(git ancestry)', '(outbound only)']) {
      expect(source).toContain(text);
    }
    for (const forbidden of ['Mark deployed', 'Auto-resolve', 'Close issue', 'Sync from Linear', 'Mark resolved automatically']) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/linear-projections/u);
  });
});
