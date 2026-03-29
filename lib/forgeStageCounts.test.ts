import { describe, expect, it } from 'vitest';
import { buildForgeStageCounts } from '@/lib/forgeStageCounts';
import type { ProjectDocumentRow } from '@/lib/projectOverview';

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

describe('buildForgeStageCounts', () => {
  it('maps document statuses into intake / extract / structure buckets', () => {
    const counts = buildForgeStageCounts({
      documents: [doc('uploaded'), doc('processing'), doc('extracted'), doc('failed')],
      decisions: [],
      tasks: [],
      auditSurfaceCount: 2,
    });
    expect(counts.intake).toBe(1);
    expect(counts.extract).toBe(2);
    expect(counts.structure).toBe(1);
    expect(counts.audit).toBe(2);
  });
});
