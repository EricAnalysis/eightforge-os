import { describe, expect, it } from 'vitest';

import {
  buildDocumentsDocumentHref,
  buildProjectDocumentHref,
  resolveDocumentDetailContext,
} from './documentNavigation';

describe('document navigation', () => {
  it('builds project-context document links with stable query params', () => {
    expect(buildProjectDocumentHref('doc-1', 'project-1')).toBe(
      '/platform/documents/doc-1?source=project&projectId=project-1',
    );
  });

  it('builds global-documents links with explicit documents context', () => {
    expect(buildDocumentsDocumentHref('doc-1')).toBe(
      '/platform/documents/doc-1?source=documents',
    );
  });

  it('resolves project context only when the requested project matches the linked project', () => {
    const params = new URLSearchParams('source=project&projectId=project-1');

    expect(resolveDocumentDetailContext(params, 'project-1')).toEqual({
      mode: 'project',
      linkedProjectId: 'project-1',
    });

    expect(resolveDocumentDetailContext(params, 'project-2')).toEqual({
      mode: 'direct',
      linkedProjectId: 'project-2',
    });
  });

  it('falls back to documents or direct modes when project context is not usable', () => {
    expect(
      resolveDocumentDetailContext(new URLSearchParams('source=documents'), 'project-1'),
    ).toEqual({
      mode: 'documents',
      linkedProjectId: 'project-1',
    });

    expect(resolveDocumentDetailContext(new URLSearchParams(), 'project-1')).toEqual({
      mode: 'direct',
      linkedProjectId: 'project-1',
    });
  });
});
