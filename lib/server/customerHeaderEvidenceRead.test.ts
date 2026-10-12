import { describe, expect, it, vi } from 'vitest';
import { readCustomerHeaderEvidence } from './customerHeaderEvidenceRead';
import { headerEvidenceFixture } from '@/lib/customerAdaptation/headerEvidenceFixtures';

function storedRows() {
  const { context } = headerEvidenceFixture();
  return { context, rows: { documents: context.document, projects: context.project,
    document_extractions: [context.extraction], extraction_source_artifacts: context.artifact } };
}
function client(rows: Record<string, unknown>, failed?: string) {
  const calls: Array<[string, string, unknown]> = [];
  const from = vi.fn((table: string) => {
    const result = { data: rows[table], error: table === failed ? { message: 'read failed' } : null };
    const chain = { select: vi.fn(() => chain),
      eq: vi.fn((key: string, value: unknown) => { calls.push([table, key, value]); return chain; }),
      is: vi.fn(() => chain), order: vi.fn(async () => result), maybeSingle: vi.fn(async () => result) };
    return chain;
  });
  return { admin: { from } as unknown as NonNullable<Parameters<typeof readCustomerHeaderEvidence>[1]>, calls, from };
}
describe('authenticated customer header evidence reader', () => {
  it('loads owned persisted evidence with tenant filters on every table', async () => {
    const { context, rows } = storedRows(); const mock = client(rows);
    const result = await readCustomerHeaderEvidence({ organizationId: context.actorOrganizationId,
      documentId: context.document.id, headerIndex: 0 }, mock.admin);
    expect(result.status).toBe('verified');
    for (const table of Object.keys(rows)) expect(mock.calls).toContainEqual([table, 'organization_id', context.actorOrganizationId]);
    expect(mock.calls).toContainEqual(['document_extractions', 'document_id', context.document.id]);
    expect(mock.calls).toContainEqual(['extraction_source_artifacts', 'source_document_id', context.document.id]);
    expect(mock.calls).toContainEqual(['extraction_source_artifacts', 'id', context.artifact.id]);
  });
  it('rechecks tenant ownership even if storage returned an incorrectly scoped row', async () => {
    const { context, rows } = storedRows(); rows.projects = { ...context.project, organization_id: context.document.id };
    const mock = client(rows);
    expect(await readCustomerHeaderEvidence({ organizationId: context.actorOrganizationId,
      documentId: context.document.id, headerIndex: 0 }, mock.admin)).toEqual({ status: 'rejected', reason: 'tenant_mismatch' });
  });
  it('does not fall back to an older verified header when the preferred extraction lacks evidence', async () => {
    const { context, rows } = storedRows();
    rows.document_extractions = [{ ...context.extraction, data: { extraction: { text_preview: 'current body' } } }, context.extraction];
    const mock = client(rows);
    expect(await readCustomerHeaderEvidence({ organizationId: context.actorOrganizationId,
      documentId: context.document.id, headerIndex: 0 }, mock.admin)).toEqual({ status: 'rejected', reason: 'source_artifact_unproven' });
    expect(mock.from).not.toHaveBeenCalledWith('extraction_source_artifacts');
  });
  it.each(['documents', 'projects', 'document_extractions', 'extraction_source_artifacts'])('fails closed on %s read errors', async table => {
    const { context, rows } = storedRows(); const mock = client(rows, table);
    expect(await readCustomerHeaderEvidence({ organizationId: context.actorOrganizationId,
      documentId: context.document.id, headerIndex: 0 }, mock.admin)).toEqual({ status: 'read_failed' });
  });
  it('returns not found without reading evidence for a missing document', async () => {
    const { context, rows } = storedRows(); const mock = client({ ...rows, documents: null });
    expect(await readCustomerHeaderEvidence({ organizationId: context.actorOrganizationId,
      documentId: context.document.id, headerIndex: 0 }, mock.admin)).toEqual({ status: 'not_found' });
    expect(mock.from).toHaveBeenCalledTimes(1);
  });
});
