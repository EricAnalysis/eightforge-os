import { describe, expect, it } from 'vitest';
import {
  buildForgeStageCounts,
  getForgeActStageRecords,
  getForgeDecideStageRecords,
} from '@/lib/forgeStageCounts';
import type {
  ProjectDecisionRow,
  ProjectDocumentRow,
  ProjectTaskRow,
} from '@/lib/projectOverview';

let docSeq = 0;
function doc(status: ProjectDocumentRow['processing_status']): ProjectDocumentRow {
  return {
    id: `test-doc-${(docSeq += 1)}`,
    title: null,
    name: 'x',
    document_type: null,
    domain: null,
    processing_status: status,
    processing_error: null,
    created_at: new Date().toISOString(),
    processed_at: null,
    project_id: null,
  };
}

let decisionSeq = 0;
function decision(
  status: ProjectDecisionRow['status'],
  overrides: Partial<ProjectDecisionRow> = {},
): ProjectDecisionRow {
  return {
    id: `decision-${(decisionSeq += 1)}`,
    document_id: null,
    decision_type: 'review',
    title: 'Review persisted decision',
    summary: 'Persisted decision summary',
    severity: 'high',
    status,
    confidence: 0.9,
    last_detected_at: '2026-03-29T12:00:00Z',
    created_at: '2026-03-29T11:00:00Z',
    due_at: null,
    assigned_to: null,
    details: null,
    ...overrides,
  };
}

let taskSeq = 0;
function task(
  status: ProjectTaskRow['status'],
  overrides: Partial<ProjectTaskRow> = {},
): ProjectTaskRow {
  return {
    id: `task-${(taskSeq += 1)}`,
    decision_id: null,
    document_id: null,
    task_type: 'review',
    title: 'Review persisted task',
    description: null,
    priority: 'high',
    status,
    created_at: '2026-03-29T11:00:00Z',
    updated_at: '2026-03-29T12:00:00Z',
    due_at: null,
    assigned_to: null,
    details: null,
    source_metadata: null,
    ...overrides,
  };
}

describe('buildForgeStageCounts', () => {
  it('maps document statuses into intake / extract / structure buckets', () => {
    const counts = buildForgeStageCounts({
      documents: [doc('uploaded'), doc('processing'), doc('extracted'), doc('decisioned'), doc('failed')],
      decisions: [],
      tasks: [],
      auditSurfaceCount: 2,
    });
    expect(counts.intake).toBe(1);
    expect(counts.extract).toBe(2);
    expect(counts.structure).toBe(2);
    expect(counts.audit).toBe(2);
  });

  it('counts only active persisted decisions and tasks in Decide and Act', () => {
    const counts = buildForgeStageCounts({
      documents: [],
      decisions: [
        decision('open'),
        decision('resolved'),
        decision('open', { details: { superseded_at: '2026-03-29T13:00:00Z' } }),
      ],
      tasks: [
        task('blocked'),
        task('completed'),
        task('open', { source_metadata: { superseded_at: '2026-03-29T13:05:00Z' } }),
      ],
      auditSurfaceCount: 0,
    });

    expect(counts.decide).toBe(1);
    expect(counts.act).toBe(1);
  });
});

describe('forge stage record mapping', () => {
  it('reports exact Decide filter reasons', () => {
    const records = getForgeDecideStageRecords([
      decision('open'),
      decision('resolved'),
      decision('open', { details: { superseded_at: '2026-03-29T13:00:00Z' } }),
    ]);

    expect(records.visible).toHaveLength(1);
    expect(records.filtered).toEqual([
      { reason: 'details.superseded_at present', count: 1 },
      { reason: 'status=resolved', count: 1 },
    ]);
  });

  it('reports exact Act filter reasons', () => {
    const records = getForgeActStageRecords([
      task('open'),
      task('completed'),
      task('open', { source_metadata: { superseded_at: '2026-03-29T13:05:00Z' } }),
    ]);

    expect(records.visible).toHaveLength(1);
    expect(records.filtered).toEqual([
      { reason: 'source_metadata.superseded_at present', count: 1 },
      { reason: 'status=completed', count: 1 },
    ]);
  });
});
