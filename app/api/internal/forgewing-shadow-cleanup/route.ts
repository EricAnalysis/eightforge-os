import { timingSafeEqual } from 'node:crypto';

import { cleanupReasoningShadowArtifacts } from '@/lib/extraction/persistence/forgewingShadowCleanup';

export const runtime = 'nodejs';
export const maxDuration = 60;

function authorized(request: Request, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ ok: false, error: 'cleanup_not_configured' }, { status: 503 });
  if (!authorized(request, secret)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const result = await cleanupReasoningShadowArtifacts();
  if (result.status === 'failed') {
    console.error('[forgewingShadowCleanup] scheduled cleanup failed', {
      warningCodes: result.warningCodes,
      scanned: result.scanned,
      deleted: result.deleted,
    });
    return Response.json({ ok: false, ...result }, { status: 503 });
  }
  if (result.status === 'partial') {
    console.warn('[forgewingShadowCleanup] scheduled cleanup incomplete', {
      warningCodes: result.warningCodes,
      scanned: result.scanned,
      deleted: result.deleted,
      failedBatches: result.failedBatches,
      truncated: result.truncated,
    });
  }
  return Response.json({ ok: true, ...result });
}
