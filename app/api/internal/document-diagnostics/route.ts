import { z } from 'zod';

import { getActorContext } from '@/lib/server/getActorContext';
import { readDocumentDiagnostics } from '@/lib/server/documentDiagnosticsRead';

export const runtime = 'nodejs';
export const maxDuration = 30;

const querySchema = z.object({
  documentId: z.string().uuid(),
  diagnosticId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export async function GET(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  }
  const search = new URL(request.url).searchParams;
  const raw = Object.fromEntries(search.entries());
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid diagnostics request' }, { status: 400 });
  }
  const result = await readDocumentDiagnostics({
    organizationId: actor.actor.organizationId,
    sourceDocumentId: parsed.data.documentId,
  });
  switch (result.status) {
    case 'ok': {
      const diagnostics = parsed.data.diagnosticId
        ? result.diagnostics.filter((entry) => entry.diagnosticId === parsed.data.diagnosticId)
        : result.diagnostics;
      return Response.json({ ok: true, diagnostics });
    }
    case 'not_configured':
      return Response.json({ ok: false, error: 'document_diagnostics_not_configured' }, { status: 503 });
    case 'read_failed':
      console.error('[documentDiagnostics] read failed', { reason: result.reason });
      return Response.json({ ok: false, error: 'document_diagnostics_read_failed' }, { status: 500 });
  }
}
