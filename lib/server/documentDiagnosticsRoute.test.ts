import { beforeEach, describe, expect, it, vi } from 'vitest';

const readDiagnostics = vi.hoisted(() => vi.fn());
const actorContext = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/documentDiagnosticsRead', () => ({ readDocumentDiagnostics: readDiagnostics }));
vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: actorContext }));

import { GET } from '@/app/api/internal/document-diagnostics/route';

const ORG = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const DIAGNOSTIC = 'a'.repeat(64);

function request(query = `documentId=${DOC}`): Request {
  return new Request(`http://localhost/api/internal/document-diagnostics?${query}`,
    { headers: { authorization: 'Bearer operator-session-jwt' } });
}

describe('document diagnostics route', () => {
  beforeEach(() => {
    readDiagnostics.mockReset().mockResolvedValue({ status: 'ok', diagnostics: [] });
    actorContext.mockReset().mockResolvedValue({ ok: true,
      actor: { actorId: '33333333-3333-4333-8333-333333333333', organizationId: ORG } });
  });

  it('authenticates before reading', async () => {
    actorContext.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    expect((await GET(request())).status).toBe(401);
    expect(readDiagnostics).not.toHaveBeenCalled();
  });

  it('derives organization identity from the session', async () => {
    await GET(request());
    expect(readDiagnostics).toHaveBeenCalledWith({ organizationId: ORG, sourceDocumentId: DOC });
  });

  it('accepts only document and diagnostic identity from the browser', async () => {
    for (const query of ['', `documentId=${DOC}&organizationId=${ORG}`,
      `documentId=${DOC}&candidateId=x`, `documentId=${DOC}&severity=info`]) {
      expect((await GET(request(query))).status).toBe(400);
    }
    expect(readDiagnostics).not.toHaveBeenCalled();
  });

  it('filters by an optional deterministic diagnostic id', async () => {
    readDiagnostics.mockResolvedValue({ status: 'ok', diagnostics: [
      { diagnosticId: DIAGNOSTIC }, { diagnosticId: 'b'.repeat(64) },
    ] });
    const payload = await (await GET(request(`documentId=${DOC}&diagnosticId=${DIAGNOSTIC}`))).json();
    expect(payload.diagnostics).toEqual([{ diagnosticId: DIAGNOSTIC }]);
  });

  it('does not leak database read errors', async () => {
    readDiagnostics.mockResolvedValue({ status: 'read_failed', reason: 'secret database message' });
    const response = await GET(request());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false,
      error: 'document_diagnostics_read_failed' });
  });
});
