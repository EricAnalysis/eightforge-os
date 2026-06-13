import { describe, expect, it } from 'vitest';

import {
  buildDocumentWorkspaceItems,
  filterDocumentWorkspaceItems,
  groupDocumentWorkspaceItems,
  summarizeDocumentWorkspaceItems,
  type DocumentWorkspaceDocRow,
  type DocumentWorkspaceReviewRow,
} from './documentWorkspace';

const documents: DocumentWorkspaceDocRow[] = [
  {
    id: 'doc-1',
    title: 'Storm Contract',
    name: 'storm-contract.pdf',
    document_type: 'contract',
    processing_status: 'decisioned',
    processing_error: null,
    created_at: '2026-03-20T10:00:00Z',
    processed_at: '2026-03-20T11:00:00Z',
    domain: 'operations',
    project_id: 'project-1',
    intelligence_trace: {
      facts: {},
      decisions: [
        {
          id: 'decision-1',
          family: 'missing',
          severity: 'warning',
          title: 'Missing support',
          detail: 'Attach supporting document.',
        },
      ],
      flow_tasks: [
        {
          id: 'task-1',
          title: 'Attach support',
          verb: 'attach',
          entity_type: 'review',
          expected_outcome: 'Support attached',
          priority: 'high',
          auto_safe: false,
          source_decision_ids: ['decision-1'],
          flow_type: 'documentation',
        },
      ],
      generated_at: '2026-03-20T11:00:00Z',
      engine_version: 'document_intelligence:v2',
    },
    projects: {
      id: 'project-1',
      name: 'Debris Ops',
      code: 'DO-1',
    },
  },
  {
    id: 'doc-2',
    title: 'Field Invoice',
    name: 'field-invoice.pdf',
    document_type: 'invoice',
    processing_status: 'decisioned',
    processing_error: null,
    created_at: '2026-03-21T10:00:00Z',
    processed_at: '2026-03-21T11:00:00Z',
    domain: 'finance',
    project_id: null,
    intelligence_trace: {
      facts: {},
      decisions: [],
      flow_tasks: [],
      generated_at: '2026-03-21T11:00:00Z',
      engine_version: 'document_intelligence:v2',
    },
    projects: null,
  },
];

const reviews: DocumentWorkspaceReviewRow[] = [
  {
    document_id: 'doc-1',
    status: 'in_review',
    reviewed_at: '2026-03-21T08:00:00Z',
  },
];

describe('document workspace', () => {
  it('builds document rows with project linkage and review signals', () => {
    const items = buildDocumentWorkspaceItems({ documents, reviews });

    expect(items[0]).toMatchObject({
      id: 'doc-1',
      documentHref: '/platform/documents/doc-1?source=documents',
      projectId: 'project-1',
      projectName: 'Debris Ops',
      isUnlinked: false,
      unresolvedFindingCount: 1,
      pendingActionCount: 1,
      needsReview: true,
      workspaceStatusLabel: 'Needs Review',
    });

    expect(items[1]).toMatchObject({
      id: 'doc-2',
      isUnlinked: true,
      unresolvedFindingCount: 0,
      needsReview: false,
      workspaceStatusLabel: 'Operationally Clear',
    });
  });

  it('filters by workspace mode, project, and attention state', () => {
    const items = buildDocumentWorkspaceItems({ documents, reviews });

    expect(
      filterDocumentWorkspaceItems(items, {
        search: '',
        mode: 'needs_review',
        projectId: '',
        documentType: '',
        processingStatus: '',
        attention: '',
        recent: '',
      }).map((item) => item.id),
    ).toEqual(['doc-1']);

    expect(
      filterDocumentWorkspaceItems(items, {
        search: '',
        mode: 'all',
        projectId: '__unlinked',
        documentType: '',
        processingStatus: '',
        attention: '',
        recent: '',
      }).map((item) => item.id),
    ).toEqual(['doc-2']);

    expect(
      filterDocumentWorkspaceItems(items, {
        search: '',
        mode: 'all',
        projectId: '',
        documentType: '',
        processingStatus: '',
        attention: 'clear',
        recent: '',
      }).map((item) => item.id),
    ).toEqual(['doc-2']);
  });

  it('groups rows by project and preserves an explicit unlinked section', () => {
    const items = buildDocumentWorkspaceItems({ documents, reviews });
    const groups = groupDocumentWorkspaceItems(items, 'updated_desc');
    const summary = summarizeDocumentWorkspaceItems(items);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      projectId: 'project-1',
      projectName: 'Debris Ops',
      totalDocuments: 1,
      needsReviewCount: 1,
      unresolvedFindingCount: 1,
    });
    expect(groups[1]).toMatchObject({
      projectId: null,
      projectName: 'Unlinked Documents',
      isUnlinked: true,
      totalDocuments: 1,
    });

    expect(summary).toEqual({
      totalDocuments: 2,
      totalProjects: 1,
      needsReviewCount: 1,
      unlinkedCount: 1,
      blockedCount: 0,
    });
  });
});
