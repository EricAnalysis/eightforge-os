import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildProjectOperationalRollup,
  buildProjectOverviewModel,
  type ProjectDocumentRow,
  type ProjectRecord,
} from './projectOverview';

const baseProject: ProjectRecord = {
  id: 'project-1',
  name: 'Williamson Debris Ops',
  code: 'WDO-1',
  status: 'active',
  created_at: '2026-03-20T00:00:00Z',
};

function buildDocument(
  overrides: Partial<ProjectDocumentRow> = {},
): ProjectDocumentRow {
  return {
    id: 'doc-1',
    title: 'Debris DMS Checklist',
    name: 'dms-checklist.pdf',
    document_type: 'disposal_checklist',
    domain: 'operations',
    processing_status: 'decisioned',
    processing_error: null,
    created_at: '2026-03-20T00:00:00Z',
    processed_at: '2026-03-20T01:00:00Z',
    project_id: 'project-1',
    intelligence_trace: {
      facts: {},
      decisions: [
        {
          id: 'trace-decision-1',
          family: 'missing',
          severity: 'warning',
          title: 'Missing TDEC permit support',
          detail: 'Permit support is missing for dumpsite validation.',
          primary_action: {
            id: 'action-1',
            type: 'attach',
            target_object_type: 'document',
            target_label: 'TDEC permit',
            description: 'Attach TDEC permit for dumpsite validation',
            expected_outcome: 'Permit support is linked for reviewer validation.',
            resolvable: false,
          },
          suggested_actions: [],
          missing_source_context: ['TDEC permit'],
        },
      ],
      flow_tasks: [
        {
          id: 'trace-task-1',
          title: 'Attach TDEC permit for dumpsite validation',
          verb: 'attach',
          entity_type: 'review',
          expected_outcome: 'Permit support is linked for reviewer validation.',
          priority: 'high',
          auto_safe: false,
          source_decision_ids: ['trace-decision-1'],
          flow_type: 'documentation',
          suggested_owner: 'Field reviewer',
        },
      ],
      generated_at: '2026-03-20T01:00:00Z',
      engine_version: 'document_intelligence:v2',
    },
    ...overrides,
  };
}

describe('project operational rollup', () => {
  it('surfaces document-derived pending actions and blocks clear state', () => {
    const document = buildDocument();
    const rollup = buildProjectOperationalRollup({
      project: baseProject,
      documents: [document],
      decisions: [],
      tasks: [],
      documentReviews: [],
    });

    assert.equal(rollup.status.label, 'Needs Review');
    assert.equal(rollup.project_clear, false);
    assert.equal(rollup.needs_review_document_count, 1);
    assert.equal(rollup.unresolved_finding_count, 1);
    assert.equal(rollup.open_document_action_count, 1);
    assert.equal(rollup.pending_actions[0]?.href, '/platform/documents/doc-1');

    const model = buildProjectOverviewModel({
      project: baseProject,
      documents: [document],
      documentReviews: [],
      decisions: [],
      tasks: [],
      activityEvents: [],
      members: [],
    });

    assert.equal(model.status.label, 'Needs Review');
    assert.equal(model.action_total, 1);
    assert.equal(model.actions[0]?.href, '/platform/documents/doc-1');
    assert.equal(model.documents[0]?.status_label, 'Needs review');
  });

  it('prioritizes blocked findings ahead of review state', () => {
    const blockedDocument = buildDocument({
      intelligence_trace: {
        facts: {},
        decisions: [
          {
            id: 'trace-decision-blocked',
            family: 'mismatch',
            severity: 'critical',
            title: 'Permit conflicts with dumpsite record',
            detail: 'The linked permit does not match the disposal site in the checklist.',
          },
        ],
        flow_tasks: [],
        generated_at: '2026-03-20T01:00:00Z',
        engine_version: 'document_intelligence:v2',
      },
    });

    const rollup = buildProjectOperationalRollup({
      project: baseProject,
      documents: [blockedDocument],
      decisions: [],
      tasks: [],
      documentReviews: [],
    });

    assert.equal(rollup.status.label, 'Blocked');
    assert.equal(rollup.blocked_count, 1);
    assert.equal(rollup.project_clear, false);
  });
});
