import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDocumentWorkspaceItems,
  filterDocumentWorkspaceItems,
  groupDocumentWorkspaceItems,
  summarizeDocumentWorkspaceItems,
  type DocumentWorkspaceDecisionRow,
  type DocumentWorkspaceDocRow,
  type DocumentWorkspaceReviewRow,
  type DocumentWorkspaceTaskRow,
} from './documentWorkspace';
import {
  buildProjectOperationalRollup,
  type ProjectDecisionRow,
  type ProjectDocumentRow,
  type ProjectTaskRow,
} from './projectOverview';

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs persisted document drift without changing the workspace projection', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const items = buildDocumentWorkspaceItems({
      documents: [{ ...documents[0], operational_status: 'Operationally clear' }],
      reviews,
    });

    expect(items[0]?.workspaceStatusLabel).toBe('Needs review');
    expect(warn).toHaveBeenCalledWith(
      '[state-projection-shadow-mismatch]',
      expect.objectContaining({
        record_type: 'document',
        record_id: 'doc-1',
        project_id: 'project-1',
        legacy_value: 'Needs review',
        persisted_value: 'Operationally clear',
        surface: 'documentWorkspace.buildDocumentWorkspaceItems',
      }),
    );
  });

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
      workspaceStatusLabel: 'Needs review',
    });

    expect(items[1]).toMatchObject({
      id: 'doc-2',
      isUnlinked: true,
      unresolvedFindingCount: 0,
      needsReview: false,
      workspaceStatusLabel: 'Operationally clear',
    });
  });

  it('uses persisted Forge queue work before raw trace status fallback', () => {
    const decisions: DocumentWorkspaceDecisionRow[] = [
      {
        id: 'persisted-decision-1',
        document_id: 'doc-2',
        status: 'open',
        severity: 'critical',
      },
    ];
    const tasks: DocumentWorkspaceTaskRow[] = [
      {
        id: 'persisted-task-1',
        document_id: 'doc-2',
        status: 'blocked',
        priority: 'high',
      },
    ];

    const items = buildDocumentWorkspaceItems({
      documents,
      reviews,
      decisions,
      tasks,
    });
    const invoice = items.find((item) => item.id === 'doc-2');

    expect(invoice).toMatchObject({
      unresolvedFindingCount: 1,
      pendingActionCount: 1,
      blockedCount: 2,
      needsReview: true,
      workspaceStatusLabel: 'Blocked',
      workspaceTone: 'danger',
    });
  });

  it('agrees with the Forge document rollup for the same document state', () => {
    const decision: ProjectDecisionRow = {
      id: 'persisted-decision-1',
      document_id: 'doc-2',
      project_id: 'project-1',
      decision_type: 'validation',
      title: 'Vendor mismatch',
      summary: 'Vendor requires review.',
      severity: 'critical',
      status: 'open',
      confidence: 0.9,
      last_detected_at: '2026-03-21T12:00:00Z',
      created_at: '2026-03-21T12:00:00Z',
      due_at: null,
      assigned_to: null,
    };
    const task: ProjectTaskRow = {
      id: 'persisted-task-1',
      decision_id: decision.id,
      document_id: 'doc-2',
      task_type: 'validation',
      title: 'Resolve vendor mismatch',
      description: null,
      priority: 'high',
      status: 'blocked',
      created_at: '2026-03-21T12:05:00Z',
      updated_at: '2026-03-21T12:05:00Z',
      due_at: null,
      assigned_to: null,
    };
    const workspaceItems = buildDocumentWorkspaceItems({
      documents: [documents[1]],
      reviews: [],
      decisions: [
        {
          id: decision.id,
          document_id: decision.document_id,
          status: decision.status,
          severity: decision.severity,
          created_at: decision.created_at,
        },
      ],
      tasks: [
        {
          id: task.id,
          document_id: task.document_id,
          decision_id: task.decision_id,
          status: task.status,
          priority: task.priority,
          created_at: task.created_at,
        },
      ],
    });
    const rollup = buildProjectOperationalRollup({
      project: {
        id: 'project-1',
        name: 'Debris Ops',
        code: 'DO-1',
        status: 'active',
        created_at: '2026-03-20T00:00:00Z',
      },
      documents: [
        {
          ...documents[1],
          project_id: 'project-1',
          projects: undefined,
        } as ProjectDocumentRow,
      ],
      decisions: [decision],
      tasks: [task],
      documentReviews: [],
    });

    expect(workspaceItems[0]?.workspaceStatusLabel).toBe(
      rollup.document_status_by_id['doc-2']?.label,
    );
    expect(workspaceItems[0]?.workspaceTone).toBe(
      rollup.document_status_by_id['doc-2']?.tone,
    );
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
