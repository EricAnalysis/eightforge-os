import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  admitDocumentProcessing,
  closeDocumentProcessingAdmission,
} from '@/lib/server/documentProcessingHold';

const ADMISSION_ID = '00000000-0000-4000-8000-000000000001';
const ADMITTED = {
  data: { admitted: true, admission_id: ADMISSION_ID, hold_version: 0, lease_expires_at: '2026-11-11T00:15:00Z' },
  error: null,
};
const HELD = { data: { admitted: false, reason: 'held', hold_version: 3 }, error: null };
const RPC_DOWN = { data: null, error: { message: 'fetch failed', code: '' } };

type RpcReply = { data: unknown; error: { message: string; code?: string } | null };
function rpcClient(admit: RpcReply) {
  return vi.fn(async (fn: string) => (fn === 'admit_document_processing'
    ? admit
    : { data: { closed: true, outcome: 'completed' }, error: null }));
}

const INPUT = { entryPoint: 'documents_process', organizationId: 'org-1', documentId: 'doc-1' } as const;

describe('admitDocumentProcessing', () => {
  it('returns a durable admission when the database admits', async () => {
    const rpc = rpcClient(ADMITTED);
    await expect(admitDocumentProcessing({ rpc }, INPUT)).resolves.toEqual({
      status: 'admitted', admissionId: ADMISSION_ID, holdVersion: 0, leaseExpiresAt: '2026-11-11T00:15:00Z',
    });
    expect(rpc).toHaveBeenCalledWith('admit_document_processing', {
      p_entry_point: 'documents_process', p_organization_id: 'org-1', p_document_id: 'doc-1', p_job_id: null,
    });
  });

  it('reports a hold', async () => {
    await expect(admitDocumentProcessing({ rpc: rpcClient(HELD) }, INPUT))
      .resolves.toEqual({ status: 'held', holdVersion: 3 });
  });

  it.each([
    ['no admin client', null],
    ['an RPC error', { rpc: rpcClient(RPC_DOWN) }],
    ['a thrown RPC', { rpc: vi.fn(async () => { throw new Error('socket hang up'); }) }],
    ['a reply without admitted', { rpc: rpcClient({ data: { hold_version: 0 }, error: null }) }],
    ['an admitted reply without an id', { rpc: rpcClient({ data: { admitted: true, hold_version: 0 }, error: null }) }],
    ['a refusal with an unknown reason', { rpc: rpcClient({ data: { admitted: false, reason: 'maybe', hold_version: 0 }, error: null }) }],
    ['a string reply', { rpc: rpcClient({ data: 'true', error: null }) }],
  ])('fails closed on %s', async (_label, admin) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await admitDocumentProcessing(admin as never, INPUT);
    expect(result.status).toBe('unavailable');
  });
});

describe('closeDocumentProcessingAdmission', () => {
  it('never throws, whatever the database does', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(closeDocumentProcessingAdmission(
      { rpc: vi.fn(async () => { throw new Error('down'); }) }, ADMISSION_ID, 'failed',
    )).resolves.toBeUndefined();
    await expect(closeDocumentProcessingAdmission(
      { rpc: vi.fn(async () => RPC_DOWN) }, ADMISSION_ID, 'completed',
    )).resolves.toBeUndefined();
    await expect(closeDocumentProcessingAdmission(null, ADMISSION_ID, 'completed')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const ACTOR = { ok: true, actor: { actorId: 'user-1', organizationId: 'org-1', displayName: null, role: null, email: null } };

function chain(single: () => Promise<unknown>) {
  const query: Record<string, unknown> = {};
  for (const key of ['select', 'eq', 'update', 'insert', 'in', 'neq', 'is', 'order', 'limit']) {
    query[key] = vi.fn(() => query);
  }
  query.single = vi.fn(single);
  query.maybeSingle = vi.fn(single);
  query.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null });
  return query;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/documents/process', () => {
  async function post(admit: RpcReply) {
    const rpc = rpcClient(admit);
    const from = vi.fn((table: string) => chain(async () => (table === 'organizations'
      ? { data: { analysis_mode: 'deterministic' }, error: null }
      : { data: { id: 'doc-1' }, error: null })));
    const processDocument = vi.fn(async () => ({ success: true, jobId: 'job-1' }));
    vi.doMock('@/lib/server/getActorContext', () => ({ getActorContext: vi.fn(async () => ACTOR) }));
    vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => ({ from, rpc }) }));
    vi.doMock('@/lib/pipeline/processDocument', () => ({ processDocument }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { POST } = await import('@/app/api/documents/process/route');
    const response = await POST(new Request('http://localhost/api/documents/process', {
      method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify({ documentId: 'doc-1' }),
    }));
    return { response, body: await response.json(), processDocument, rpc };
  }

  it('gate off: processes under a durable admission and closes it', async () => {
    const { response, processDocument, rpc } = await post(ADMITTED);
    expect(response.status).toBe(200);
    expect(processDocument).toHaveBeenCalledOnce();
    expect(processDocument).toHaveBeenCalledWith(expect.objectContaining({ admissionId: ADMISSION_ID }));
    expect(rpc).toHaveBeenCalledWith('close_document_processing_admission', {
      p_admission_id: ADMISSION_ID, p_outcome: 'completed',
    });
  });

  it('held: refuses with a typed 503 before the pipeline creates any job', async () => {
    const { response, body, processDocument, rpc } = await post(HELD);
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ success: false, code: 'DOCUMENT_PROCESSING_HELD', holdVersion: 3 });
    expect(typeof body.message).toBe('string');
    expect(body.error).toBe(body.message);
    expect(processDocument).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('unverified hold state: refuses rather than assuming processing is allowed', async () => {
    const { response, body, processDocument } = await post(RPC_DOWN);
    expect(response.status).toBe(503);
    expect(body.code).toBe('DOCUMENT_PROCESSING_HOLD_UNVERIFIED');
    expect(processDocument).not.toHaveBeenCalled();
  });
});

describe('POST /api/documents/[id]/analyze', () => {
  async function post(admit: RpcReply) {
    const rpc = rpcClient(admit);
    const createAnalysisJob = vi.fn(async () => ({ id: 'job-1' }));
    const dispatch = vi.fn(async () => Response.json({ success: true, extraction: { id: 'x' } }));
    vi.stubGlobal('fetch', dispatch);
    vi.stubEnv('SUPABASE_URL', 'https://example.invalid');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
      from: (table: string) => chain(async () => (table === 'organizations'
        ? { data: { analysis_mode: 'deterministic' }, error: null }
        : { data: { id: 'doc-1' }, error: null })),
    }) }));
    vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => ({
      from: () => chain(async () => ({ data: { organization_id: 'org-1' }, error: null })),
      rpc,
    }) }));
    vi.doMock('@/lib/server/analysisJobService', () => ({ createAnalysisJob }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { POST } = await import('@/app/api/documents/[id]/analyze/route');
    const response = await POST(new Request('http://localhost/api/documents/doc-1/analyze', {
      method: 'POST', headers: { Authorization: 'Bearer t' },
    }), { params: Promise.resolve({ id: 'doc-1' }) });
    return { response, createAnalysisJob, dispatch, rpc };
  }

  it('gate off: creates the job under the admission and dispatches it', async () => {
    const { response, createAnalysisJob, dispatch, rpc } = await post(ADMITTED);
    expect(response.status).toBe(200);
    expect(createAnalysisJob).toHaveBeenCalledWith(expect.objectContaining({ admissionId: ADMISSION_ID }));
    expect(dispatch).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('close_document_processing_admission', {
      p_admission_id: ADMISSION_ID, p_outcome: 'completed',
    });
  });

  it.each([['held', HELD], ['unverified', RPC_DOWN]])('%s: creates no job and dispatches nothing', async (_label, reply) => {
    const { response, createAnalysisJob, dispatch } = await post(reply);
    expect(response.status).toBe(503);
    expect(createAnalysisJob).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// The route's first import loads the full extraction module graph.
describe('POST /api/jobs/process/[jobId]', { timeout: 30_000 }, () => {
  async function post(admit: RpcReply) {
    const rpc = rpcClient(admit);
    const download = vi.fn(async () => ({ data: null, error: { message: 'stop here' } }));
    const from = vi.fn(() => chain(async () => ({
      data: { id: 'doc-1', storage_path: 'org-1/a.pdf', organization_id: 'org-1', project_id: null },
      error: null,
    })));
    const jobService = {
      getJob: vi.fn(async () => ({
        id: 'job-1', document_id: 'doc-1', organization_id: 'org-1',
        status: 'queued', analysis_mode: 'deterministic', attempt_count: 0,
      })),
      claimQueuedJob: vi.fn(async () => true),
      updateJobStatus: vi.fn(async () => undefined),
      setDocumentStatus: vi.fn(async () => undefined),
    };
    vi.doMock('@/lib/server/getActorContext', () => ({ getActorContext: vi.fn(async () => ACTOR) }));
    vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn(() => ({
      from, rpc, storage: { from: vi.fn(() => ({ download })) },
    })) }));
    vi.doMock('@/lib/server/analysisJobService', () => jobService);
    vi.doMock('@/lib/extraction/persistence/complianceShadow', () => ({
      captureStorageObjectVersion: vi.fn(async () => null),
      scheduleExtractionComplianceShadow: vi.fn(async () => null),
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { POST } = await import('@/app/api/jobs/process/[jobId]/route');
    const response = await POST(new Request('http://localhost/api/jobs/process/job-1', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'job-1' }) });
    return { response, jobService, download, from, rpc };
  }

  it('gate off: claims the job under its own claim admission', async () => {
    const { jobService, rpc } = await post(ADMITTED);
    expect(rpc).toHaveBeenCalledWith('admit_document_processing', {
      p_entry_point: 'job_process', p_organization_id: 'org-1', p_document_id: 'doc-1', p_job_id: 'job-1',
    });
    expect(jobService.claimQueuedJob).toHaveBeenCalledWith(expect.objectContaining({ claimAdmissionId: ADMISSION_ID }));
    expect(rpc).toHaveBeenCalledWith('close_document_processing_admission', {
      p_admission_id: ADMISSION_ID, p_outcome: 'failed',
    });
  });

  it.each([['held', HELD], ['unverified', RPC_DOWN]])('%s: leaves the queued job and the document untouched', async (_label, reply) => {
    const { response, jobService, download, from } = await post(reply);
    expect(response.status).toBe(503);
    expect(jobService.claimQueuedJob).not.toHaveBeenCalled();
    expect(jobService.updateJobStatus).not.toHaveBeenCalled();
    expect(jobService.setDocumentStatus).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});

describe('POST /api/documents/[id]/evaluate', () => {
  async function post(admit: RpcReply, canonicalWritesFenced = false) {
    const rpc = rpcClient(admit);
    const update = vi.fn();
    const from = vi.fn(() => {
      const query = chain(async () => ({
        data: { id: 'doc-1', organization_id: 'org-1', domain: 'contracts', document_type: 'contract', processing_status: 'extracted' },
        error: null,
      }));
      query.update = vi.fn(() => { update(); return query; });
      return query;
    });
    const generateAndPersistCanonicalIntelligence = vi.fn(async () => {
      if (canonicalWritesFenced) {
        // The snapshot rewrite goes through the real admission transport and
        // the database answers with a fence refusal (the writer only logs it).
        const context = await import('@/lib/server/documentProcessingAdmissionContext');
        await context.withDocumentProcessingAdmissionHeader(async () => Response.json(
          { code: '55000', details: 'document_processing_write_fenced:revoked' }, { status: 400 },
        ))('http://x/rest/v1/document_extractions', { method: 'PATCH' });
      }
      return {
        handled: true, family: 'contract', intelligence: { decisions: [] },
        decisions_created: 0, decisions_updated: 0, decisions_preserved: 0,
        tasks_created: 0, tasks_updated: 0, tasks_preserved: 0,
      };
    });
    vi.doMock('@/lib/server/getActorContext', () => ({ getActorContext: vi.fn(async () => ACTOR) }));
    vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn(() => ({ from, rpc })) }));
    vi.doMock('@/lib/server/intelligencePersistence', () => ({ generateAndPersistCanonicalIntelligence }));
    vi.doMock('@/lib/server/ruleEngine', () => ({ loadFactsWithDerived: vi.fn(), loadRules: vi.fn(), evaluateRule: vi.fn() }));
    vi.doMock('@/lib/server/decisionEngine', () => ({ createDecisionsFromRules: vi.fn() }));
    vi.doMock('@/lib/server/workflowEngine', () => ({ createTasksFromDecisions: vi.fn() }));
    vi.doMock('@/lib/server/activity/logActivityEvent', () => ({ logActivityEvent: vi.fn() }));
    const { POST } = await import('@/app/api/documents/[id]/evaluate/route');
    const response = await POST(new Request('http://localhost/api/documents/doc-1/evaluate', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: 'doc-1' }) });
    return { response, generateAndPersistCanonicalIntelligence, update, rpc };
  }

  it('gate off: evaluates and closes the admission', async () => {
    const { response, generateAndPersistCanonicalIntelligence, rpc } = await post(ADMITTED);
    expect(response.status).toBe(200);
    expect(generateAndPersistCanonicalIntelligence).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('close_document_processing_admission', {
      p_admission_id: ADMISSION_ID, p_outcome: 'completed',
    });
  });

  it.each([['held', HELD], ['unverified', RPC_DOWN]])('%s: writes no output and no document status', async (_label, reply) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { response, generateAndPersistCanonicalIntelligence, update } = await post(reply);
    expect(response.status).toBe(503);
    expect(generateAndPersistCanonicalIntelligence).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('fenced protected write: typed 409, nothing recorded as decisioned, document not marked failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { response, update, rpc } = await post(ADMITTED, true);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'DOCUMENT_PROCESSING_WRITE_FENCED', reasons: ['revoked'] });
    expect(update).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('close_document_processing_admission', {
      p_admission_id: ADMISSION_ID, p_outcome: 'failed',
    });
  });
});

// ---------------------------------------------------------------------------
// Operator route
// ---------------------------------------------------------------------------

describe('/api/internal/document-processing-hold', () => {
  const OPERATOR = { ok: true, actor: { actorId: 'op-1', organizationId: 'org-1', displayName: null, role: 'member', email: 'Operator@Example.test' } };
  const KEY = '00000000-0000-4000-8000-0000000000aa';
  let rpc: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rpc = vi.fn(async (fn: string) => (fn === 'read_document_processing_hold_state'
      ? { data: { held: true, drain_state: 'draining' }, error: null }
      : { data: { replayed: false, held: true, outcome: 'applied', hold_version: 1 }, error: null }));
  });

  async function route(actor: unknown) {
    vi.doMock('@/lib/server/getActorContext', () => ({ getActorContext: vi.fn(async () => actor) }));
    vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => ({ rpc }) }));
    return import('@/app/api/internal/document-processing-hold/route');
  }
  function postBody(body: unknown) {
    return new Request('http://localhost/api/internal/document-processing-hold', {
      method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify(body),
    });
  }

  it('refuses an unauthenticated caller', async () => {
    const { POST } = await route({ ok: false, status: 401, error: 'Unauthorized' });
    expect((await POST(postBody({ action: 'hold', requestKey: KEY, reason: 'x' }))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses everyone when no operator allowlist is configured', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', '');
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_ROLES', '');
    const { POST, GET } = await route({ ...OPERATOR, actor: { ...OPERATOR.actor, role: 'owner' } });
    expect((await POST(postBody({ action: 'hold', requestKey: KEY, reason: 'x' }))).status).toBe(403);
    expect((await GET(new Request('http://localhost/x'))).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses an organization admin who is not an allowlisted operator', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', 'someone-else@example.test');
    const { POST } = await route({ ...OPERATOR, actor: { ...OPERATOR.actor, role: 'admin' } });
    expect((await POST(postBody({ action: 'hold', requestKey: KEY, reason: 'x' }))).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('records a hold attributed to the session actor, never the body', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', 'operator@example.test');
    const { POST } = await route(OPERATOR);
    const response = await POST(postBody({ action: 'hold', requestKey: KEY, reason: ' A1/A2 window ' }));
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('set_document_processing_hold', {
      p_request_key: KEY, p_action: 'hold', p_reason: 'A1/A2 window',
      p_actor_id: 'op-1', p_actor_email: 'Operator@Example.test',
    });
  });

  it.each([
    ['an actor field', { action: 'hold', requestKey: KEY, reason: 'x', actorId: 'someone' }],
    ['an unknown action', { action: 'pause', requestKey: KEY, reason: 'x' }],
    ['a non-uuid key', { action: 'hold', requestKey: 'abc', reason: 'x' }],
    ['a blank reason', { action: 'release', requestKey: KEY, reason: '   ' }],
  ])('rejects %s', async (_label, body) => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', 'operator@example.test');
    const { POST } = await route(OPERATOR);
    expect((await POST(postBody(body))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps a changed replay to 409', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', 'operator@example.test');
    rpc.mockResolvedValueOnce({ data: null, error: {
      message: 'request key was already used for a different request', code: '22023',
      details: 'document_processing_hold_replay_conflict',
    } });
    const { POST } = await route(OPERATOR);
    expect((await POST(postBody({ action: 'release', requestKey: KEY, reason: 'done' }))).status).toBe(409);
  });

  it('maps a lock timeout (55P03) to a retryable 503 on both transition and read', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', 'operator@example.test');
    const busy = { data: null, error: { message: 'canceling statement due to lock timeout', code: '55P03' } };
    rpc.mockResolvedValueOnce(busy).mockResolvedValueOnce(busy);
    const { POST, GET } = await route(OPERATOR);
    const transition = await POST(postBody({ action: 'hold', requestKey: KEY, reason: 'window' }));
    expect(transition.status).toBe(503);
    expect(await transition.json()).toEqual({ ok: false, error: 'hold_lock_busy' });
    const read = await GET(new Request('http://localhost/x'));
    expect(read.status).toBe(503);
    expect(await read.json()).toEqual({ ok: false, error: 'hold_lock_busy' });
  });

  it('revokes write-valid admissions, and refuses revoke without a hold', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', 'operator@example.test');
    const { POST } = await route(OPERATOR);
    expect((await POST(postBody({ action: 'revoke', requestKey: KEY, reason: 'drain now' }))).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('set_document_processing_hold', expect.objectContaining({ p_action: 'revoke' }));
    rpc.mockResolvedValueOnce({ data: null, error: {
      message: 'revoking admissions requires an active hold', code: '55000', details: 'document_processing_hold_not_held',
    } });
    const refused = await POST(postBody({ action: 'revoke', requestKey: '00000000-0000-4000-8000-0000000000ab', reason: 'x' }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, error: 'not_held' });
  });

  it('reads hold and drain state', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_ROLES', 'platform_operator');
    const { GET } = await route({ ...OPERATOR, actor: { ...OPERATOR.actor, email: null, role: 'platform_operator' } });
    const response = await GET(new Request('http://localhost/x'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, state: { held: true, drain_state: 'draining' } });
  });
});
