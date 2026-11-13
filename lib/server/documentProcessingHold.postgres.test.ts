// Offline qualification of the document processing hold against disposable
// PostgreSQL 17 + PostgREST v14.7. Skipped unless run through
// scripts/qualify-document-processing-hold.sh, which creates and destroys the
// containers. Never point this at a hosted database.
//
// "Simulated clock" steps backdate lease timestamps as the disposable
// superuser (session_replication_role = replica) instead of waiting 15 minutes.
// Production has no such path: the tables are function-write-only.

import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  admitDocumentProcessing,
  closeDocumentProcessingAdmission,
  readDocumentProcessingHoldState,
  setDocumentProcessingHold,
  type DocumentProcessingHoldRpcClient,
} from '@/lib/server/documentProcessingHold';
import {
  DOCUMENT_PROCESSING_ADMISSION_HEADER as ADMISSION_HEADER,
  documentProcessingFenceRefusals,
  runWithDocumentProcessingAdmission,
  withDocumentProcessingAdmissionHeader,
} from '@/lib/server/documentProcessingAdmissionContext';
import { withStageTimeout } from '@/lib/server/stageTimeout';

const env = process.env;
const enabled = env.DOCUMENT_PROCESSING_HOLD_DISPOSABLE_DB === '1';
const db = env.HOLD_DB_CONTAINER ?? '';
const restA = env.HOLD_REST_A_CONTAINER ?? '';
const urls = [env.HOLD_REST_A_URL, env.HOLD_REST_B_URL, env.HOLD_REST_PREHOLD_URL];
if (enabled && (!/^ef-hold-db-\d+$/.test(db) || !/^ef-hold-rest-a-\d+$/.test(restA)
  || urls.some((u) => !u || new URL(u).hostname !== '127.0.0.1') || !env.HOLD_JWT_SECRET)) {
  throw new Error('Disposable hold containers, loopback PostgREST URLs and JWT secret are required.');
}

const ORG = 'd0000000-0000-4000-8000-000000000001';
const OPERATOR = 'd0000000-0000-4000-8000-0000000000a1';
const DOC = 'd0000000-0000-4000-8000-000000000101';
const DOC_FIXTURE = 'd0000000-0000-4000-8000-000000000102';
const DOC_PERF = 'd0000000-0000-4000-8000-000000000103';
const timings: Record<string, string> = {};

function token(role: 'service_role' | 'authenticated' | 'anon'): string {
  const enc = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({
    role, sub: role === 'authenticated' ? OPERATOR : undefined, exp: Math.floor(Date.now() / 1000) + 7200,
  })}`;
  return `${body}.${createHmac('sha256', env.HOLD_JWT_SECRET!).update(body).digest('base64url')}`;
}

/** supabase-js targets /rest/v1; the disposable PostgREST serves at /. */
const restFetch: typeof fetch = (input, init) => fetch(String(input).replace('/rest/v1', ''), init);

function client(
  url: string,
  role: 'service_role' | 'authenticated' | 'anon' = 'service_role',
  headers: Record<string, string> = {},
): SupabaseClient {
  return createClient(url, token(role), {
    auth: { persistSession: false },
    global: { fetch: restFetch, headers },
  });
}

/** The production admin client's transport: admission header from AsyncLocalStorage. */
function admissionAwareClient(url: string): SupabaseClient {
  return createClient(url, token('service_role'), {
    auth: { persistSession: false },
    global: { fetch: withDocumentProcessingAdmissionHeader(restFetch) },
  });
}

function sql(statement: string, database = 'postgres'): string {
  return execFileSync('docker', ['exec', '-i', db, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', database], { input: statement, encoding: 'utf8' }).trim();
}

function session(statement: string): Promise<{ out: string; code: number | null; ms: number }> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', '-i', db, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1',
      '-U', 'postgres', '-d', 'postgres']);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out: out.trim(), code, ms: performance.now() - started }));
    child.stdin.end(statement);
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForRest(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const { data } = await client(url).rpc('read_document_processing_hold_state');
      if (data) return;
    } catch { /* restarting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`PostgREST at ${url} did not become ready`);
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const fmt = (values: number[]) =>
  `n=${values.length} p50=${percentile(values, 50).toFixed(2)}ms p95=${percentile(values, 95).toFixed(2)}ms max=${Math.max(...values).toFixed(2)}ms`;

let admin: SupabaseClient;
let adminB: SupabaseClient;
let rpcA: DocumentProcessingHoldRpcClient;

/** A restarted container gets a new ephemeral host port; re-resolve it. */
async function reattachRestA(): Promise<void> {
  const port = execFileSync('docker', ['port', restA, '3000/tcp'], { encoding: 'utf8' }).split('\n')[0].split(':').pop();
  urls[0] = `http://127.0.0.1:${port}`;
  admin = client(urls[0]);
  rpcA = admin as unknown as DocumentProcessingHoldRpcClient;
  await waitForRest(urls[0]);
}

async function hold(action: 'hold' | 'release' | 'revoke', reason = `qualification ${action}`, key: string = randomUUID()) {
  return setDocumentProcessingHold(rpcA, { requestKey: key, action, reason, actorId: OPERATOR, actorEmail: 'op@example.test' });
}
async function state() {
  const result = await readDocumentProcessingHoldState(rpcA);
  if (result.status !== 'ok') throw new Error(`state read failed: ${result.message}`);
  return result.state as Record<string, unknown>;
}
async function admit(documentId = DOC, entryPoint: 'documents_process' | 'document_evaluate' = 'documents_process') {
  return admitDocumentProcessing(rpcA, { entryPoint, organizationId: ORG, documentId });
}
/** The exact insert 5a7fb05's createAnalysisJob sends. */
function legacyCreateJob(c: SupabaseClient, documentId = DOC) {
  return c.from('document_analysis_jobs').insert({
    document_id: documentId, organization_id: ORG, analysis_mode: 'deterministic',
    status: 'queued', triggered_by: 'manual',
  }).select().single();
}
/** The exact update 5a7fb05's claimQueuedJob sends. */
function legacyClaim(c: SupabaseClient, jobId: string) {
  return c.from('document_analysis_jobs').update({
    status: 'running', started_at: new Date().toISOString(), attempt_count: 1,
  }).eq('id', jobId).eq('status', 'queued').select('id');
}
/** Simulated clock: expire leases and age the hold, as disposable superuser. */
function expireLeasesAndAgeHold(): void {
  sql(`SET session_replication_role = replica;
    UPDATE public.document_processing_admissions
      SET admitted_at = admitted_at - interval '2 hours', lease_expires_at = lease_expires_at - interval '2 hours'
      WHERE lease_expires_at > clock_timestamp();
    UPDATE public.document_processing_control SET held_since = held_since - interval '2 hours' WHERE held;`);
}
function fingerprint(): string {
  // Every public table except the hold's own ledger and the job table it fences.
  return sql(`SELECT md5(string_agg(t.relname || ':' || t.fp, ',' ORDER BY t.relname)) FROM (
      SELECT c.relname, (xpath('/row/f/text()', query_to_xml(format(
        'SELECT md5(coalesce(string_agg(x::text, %L ORDER BY x::text), %L)) AS f FROM public.%I x', '|', '', c.relname),
        false, true, '')))[1]::text AS fp
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname NOT IN ('document_processing_control', 'document_processing_hold_transitions',
                              'document_processing_admissions', 'document_analysis_jobs')
    ) t;`);
}

describe.skipIf(!enabled)('document processing hold — disposable PostgreSQL/PostgREST', { timeout: 600_000 }, () => {
  beforeAll(async () => {
    admin = client(urls[0]!);
    adminB = client(urls[1]!);
    rpcA = admin as unknown as DocumentProcessingHoldRpcClient;
    const seed = `
      INSERT INTO auth.users(id, email) VALUES ('${OPERATOR}', 'op@example.test');
      INSERT INTO public.organizations(id, name) VALUES ('${ORG}', 'Hold fixture org');
      INSERT INTO public.user_profiles(id, organization_id, role) VALUES ('${OPERATOR}', '${ORG}', 'member');
      INSERT INTO public.documents(id, organization_id, name, storage_path) VALUES
        ('${DOC}', '${ORG}', 'hold doc', 'hold/doc'),
        ('${DOC_FIXTURE}', '${ORG}', 'untouched fixture', 'hold/fixture'),
        ('${DOC_PERF}', '${ORG}', 'perf doc', 'hold/perf');
      INSERT INTO public.document_extractions(document_id, organization_id, data)
        VALUES ('${DOC_FIXTURE}', '${ORG}', '{"fields":{"fixture":true}}');`;
    sql(seed);
    sql(seed, 'prehold');
    sql(`NOTIFY pgrst, 'reload schema';`);
    sql(`NOTIFY pgrst, 'reload schema';`, 'prehold');
    await waitForRest(urls[0]!);
    await waitForRest(urls[1]!);
  });

  afterAll(() => {
    if (!enabled) return;
    console.log('\n=== DOCUMENT PROCESSING HOLD PERFORMANCE (disposable, synthetic) ===');
    for (const [k, v] of Object.entries(timings)) console.log(`${k}: ${v}`);
  });

  let preHoldQueuedJob = '';
  let inFlightAdmission = '';

  it('01 default: processing is allowed and the drain is not_held', async () => {
    const s = await state();
    expect(s).toMatchObject({ held: false, hold_version: 0, drain_state: 'not_held', admission_lease_seconds: 900 });
    const a = await admit();
    expect(a.status).toBe('admitted');
    if (a.status === 'admitted') await closeDocumentProcessingAdmission(rpcA, a.admissionId, 'completed');
    const legacy = await legacyCreateJob(admin);
    expect(legacy.error).toBeNull();
    preHoldQueuedJob = (legacy.data as { id: string }).id;
  });

  it('03 unauthorized: only the service role can transition, and no role can write the tables', async () => {
    for (const role of ['authenticated', 'anon'] as const) {
      const c = client(urls[0]!, role);
      const set = await c.rpc('set_document_processing_hold', {
        p_request_key: randomUUID(), p_action: 'hold', p_reason: 'x', p_actor_id: OPERATOR,
      });
      expect(set.error?.code).toBe('42501');
      const admitted = await c.rpc('admit_document_processing', {
        p_entry_point: 'documents_process', p_organization_id: ORG, p_document_id: DOC,
      });
      expect(admitted.error?.code).toBe('42501');
      const read = await c.from('document_processing_control').select('*');
      expect(read.error?.code).toBe('42501');
    }
    const direct = await admin.from('document_processing_control').update({ held: true }).eq('singleton', true).select();
    expect(direct.error?.code).toBe('42501');
    const forged = await admin.from('document_processing_hold_transitions').insert({
      request_key: randomUUID(), request_digest_sha256: 'a'.repeat(64), action: 'release', outcome: 'applied',
      actor_id: OPERATOR, reason: 'forged', held_before: true, held_after: false, hold_version_after: 9,
    });
    expect(forged.error?.code).toBe('42501');
    const forgedAdmission = await admin.from('document_processing_admissions').insert({
      entry_point: 'documents_process', organization_id: ORG, document_id: DOC,
      admitted_hold_version: 0, admitted_at: new Date().toISOString(), lease_expires_at: '2999-01-01T00:00:00Z',
    });
    expect(forgedAdmission.error?.code).toBe('42501');
    expect((await state()).held).toBe(false);
  });

  it('07 (setup) an admission granted before the hold is in flight', async () => {
    const a = await admit();
    expect(a.status).toBe('admitted');
    inFlightAdmission = a.status === 'admitted' ? a.admissionId : '';
  });

  it('02 authorized hold: applied, versioned, audited with the actor', async () => {
    const started = performance.now();
    const r = await hold('hold', 'A1/A2 maintenance window');
    timings['hold activation (RPC round trip)'] = `${(performance.now() - started).toFixed(2)}ms`;
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.transition).toMatchObject({ replayed: false, action: 'hold', outcome: 'applied', held: true, hold_version: 1 });
    const audit = sql(`SELECT action, outcome, actor_id, actor_email, reason, held_before, held_after, hold_version_after
      FROM public.document_processing_hold_transitions WHERE id = '${r.transition.transition_id}'`);
    expect(audit).toBe(`hold|applied|${OPERATOR}|op@example.test|A1/A2 maintenance window|f|t|1`);
  });

  it('05 new processing is refused while held, at the RPC and at the job table', async () => {
    expect(await admit()).toEqual({ status: 'held', holdVersion: 1 });
    expect(await admit(DOC, 'document_evaluate')).toEqual({ status: 'held', holdVersion: 1 });
    const before = sql(`SELECT count(*) FROM public.document_analysis_jobs`);
    const legacy = await legacyCreateJob(admin);
    expect(legacy.error?.code).toBe('55000');
    expect(legacy.error?.details).toBe('document_processing_hold_active');
    expect(sql(`SELECT count(*) FROM public.document_analysis_jobs`)).toBe(before);
  });

  it('06 queued work is preserved: a legacy claim is refused and the job is unchanged', async () => {
    const before = sql(`SELECT status, attempt_count, started_at IS NULL FROM public.document_analysis_jobs WHERE id = '${preHoldQueuedJob}'`);
    const claim = await legacyClaim(admin, preHoldQueuedJob);
    expect(claim.error?.code).toBe('55000');
    expect(sql(`SELECT status, attempt_count, started_at IS NULL FROM public.document_analysis_jobs WHERE id = '${preHoldQueuedJob}'`))
      .toBe(before);
    expect(before).toBe('queued|0|t');
    expect((await state()).jobs_queued).toBeGreaterThanOrEqual(1);
  });

  let inFlightJob = '';
  it('07 the in-flight admitted request keeps working and stays tracked', async () => {
    const created = await admin.from('document_analysis_jobs').insert({
      document_id: DOC, organization_id: ORG, analysis_mode: 'deterministic', status: 'queued',
      triggered_by: 'manual', admission_id: inFlightAdmission,
    }).select('id').single();
    expect(created.error).toBeNull();
    inFlightJob = (created.data as { id: string }).id;
    // An admission cannot be borrowed for another document.
    const borrowed = await admin.from('document_analysis_jobs').insert({
      document_id: DOC_PERF, organization_id: ORG, analysis_mode: 'deterministic', status: 'queued',
      triggered_by: 'manual', admission_id: inFlightAdmission,
    });
    expect(borrowed.error?.code).toBe('55000');
    const s = await state();
    expect(s).toMatchObject({ drain_state: 'draining', admissions_write_valid: 1 });
  });

  it('08 normal completion: terminal writes are never fenced; closing ends write authority', async () => {
    const done = await admin.from('document_analysis_jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', inFlightJob);
    expect(done.error).toBeNull();
    await closeDocumentProcessingAdmission(rpcA, inFlightAdmission, 'completed');
    const again = await admin.rpc('close_document_processing_admission', { p_admission_id: inFlightAdmission, p_outcome: 'failed' });
    expect(again.data).toEqual({ closed: false, outcome: 'completed' });
    // A closed admission can no longer write (write fence), so it no longer
    // holds the drain open.
    expect(await state()).toMatchObject({ drain_state: 'drained', admissions_write_valid: 0 });
  });

  let crashedAdmission = '';
  it('09 worker crash: an unclosed admission blocks the drain, then reads as abandoned, never completed', async () => {
    await hold('release', 'open briefly for crash fixture');
    const a = await admit();
    crashedAdmission = a.status === 'admitted' ? a.admissionId : '';
    const job = await admin.from('document_analysis_jobs').insert({
      document_id: DOC, organization_id: ORG, analysis_mode: 'deterministic', status: 'queued',
      triggered_by: 'manual', admission_id: crashedAdmission,
    }).select('id').single();
    await admin.from('document_analysis_jobs').update({ status: 'running' }).eq('id', (job.data as { id: string }).id);
    await hold('hold', 'crash fixture hold');
    // "Crash": the request never closes its admission or its job.
    expect(await state()).toMatchObject({ drain_state: 'draining', admissions_write_valid: 1 });
    expireLeasesAndAgeHold();
    const s = await state();
    expect(s).toMatchObject({ drain_state: 'drained', admissions_abandoned: 1, admissions_write_valid: 0 });
    expect(Number(s.jobs_running)).toBeGreaterThanOrEqual(1);
    expect(sql(`SELECT closed_at IS NULL, outcome IS NULL FROM public.document_processing_admissions WHERE id = '${crashedAdmission}'`))
      .toBe('t|t');
  });

  it('10 stale lease: an expired admission cannot create or claim a job while held', async () => {
    const created = await admin.from('document_analysis_jobs').insert({
      document_id: DOC, organization_id: ORG, analysis_mode: 'deterministic', status: 'queued',
      triggered_by: 'manual', admission_id: crashedAdmission,
    });
    expect(created.error?.code).toBe('55000');
    const claim = await admin.from('document_analysis_jobs')
      .update({ status: 'running', claim_admission_id: crashedAdmission }).eq('id', preHoldQueuedJob).eq('status', 'queued');
    expect(claim.error?.code).toBe('55000');
    // Leases and identity are immutable even to the service role's functions.
    const tamper = await session(`UPDATE public.document_processing_admissions
      SET lease_expires_at = '2999-01-01' WHERE id = '${crashedAdmission}';`);
    expect(tamper.out).toContain('an admission can only be closed once');
  });

  let heldVersion = 0;
  it('11/12 restart and multiple instances: the hold survives PostgREST and database restarts', async () => {
    heldVersion = Number((await state()).hold_version);
    expect((await readDocumentProcessingHoldState(adminB as never)).status).toBe('ok');
    expect(await admitDocumentProcessing(adminB as never, { entryPoint: 'job_process', organizationId: ORG, documentId: DOC, jobId: preHoldQueuedJob }))
      .toEqual({ status: 'held', holdVersion: heldVersion });
    execFileSync('docker', ['restart', restA]);
    await reattachRestA();
    expect(await admit()).toEqual({ status: 'held', holdVersion: heldVersion });
    execFileSync('docker', ['restart', db]);
    await waitFor(() => {
      try { return sql('SELECT 1') === '1'; } catch { return false; }
    }, 'database restart', 60_000);
    await reattachRestA();
    await waitForRest(urls[1]!);
    expect(await admit()).toEqual({ status: 'held', holdVersion: heldVersion });
    expect(await admitDocumentProcessing(adminB as never, { entryPoint: 'documents_process', organizationId: ORG, documentId: DOC }))
      .toEqual({ status: 'held', holdVersion: heldVersion });
  });

  let holdKey = '';
  it('15 duplicate hold: audited as already_held, version unchanged', async () => {
    holdKey = randomUUID();
    const r = await hold('hold', 'second operator also holds', holdKey);
    expect(r.status === 'ok' && r.transition).toMatchObject({ outcome: 'already_held', held: true, hold_version: heldVersion, replayed: false });
  });

  it('16 replay: same key + same request replays; same key + changed request conflicts', async () => {
    const replay = await hold('hold', 'second operator also holds', holdKey);
    expect(replay.status === 'ok' && replay.transition).toMatchObject({ replayed: true, outcome: 'already_held' });
    const changed = await hold('release', 'second operator also holds', holdKey);
    expect(changed.status).toBe('replay_conflict');
    const changedReason = await hold('hold', 'different reason', holdKey);
    expect(changedReason.status).toBe('replay_conflict');
    expect(sql(`SELECT count(*) FROM public.document_processing_hold_transitions WHERE request_key = '${holdKey}'`)).toBe('1');
    expect((await state()).held).toBe(true);
  });

  it('17 connectivity failure: processing is refused, never assumed allowed', async () => {
    const dead = client('http://127.0.0.1:1') as unknown as DocumentProcessingHoldRpcClient;
    expect((await admitDocumentProcessing(dead, { entryPoint: 'documents_process', organizationId: ORG, documentId: DOC })).status)
      .toBe('unavailable');
    execFileSync('docker', ['stop', restA]);
    try {
      expect((await admit()).status).toBe('unavailable');
    } finally {
      execFileSync('docker', ['start', restA]);
    }
    await reattachRestA();
    // A missing control row also fails closed (simulated corruption).
    sql(`CREATE TABLE public.qual_saved_control AS SELECT * FROM public.document_processing_control;
      SET session_replication_role = replica;
      DELETE FROM public.document_processing_control;`);
    try {
      expect((await admit()).status).toBe('unavailable');
      const legacy = await legacyCreateJob(admin);
      expect(legacy.error?.details).toBe('document_processing_hold_unverified');
    } finally {
      sql(`SET session_replication_role = replica;
        INSERT INTO public.document_processing_control SELECT * FROM public.qual_saved_control;
        DROP TABLE public.qual_saved_control;`);
    }
    expect(await admit()).toEqual({ status: 'held', holdVersion: heldVersion });
  });

  it('18 migration boundary: drained only when no admission can write; expired writers are fenced', async () => {
    await hold('release', 'boundary fixture');
    const a = await admit();
    const admission = a.status === 'admitted' ? a.admissionId : '';
    await hold('hold', 'boundary hold');
    const draining = await state();
    expect(draining).toMatchObject({ drain_state: 'draining', admissions_write_valid: 1 });
    expect(new Date(String(draining.natural_drain_at)).getTime())
      .toBeGreaterThan(new Date(String(draining.held_since)).getTime());
    // A simulated authority guard (stand-in for A1) installed while draining
    // would refuse the still-valid in-flight writer: exactly why the window
    // waits for 'drained' before migrating. (The fence passes it; the guard
    // refuses it.)
    sql(`CREATE FUNCTION public.qual_refuse_blob() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'authority guard' USING ERRCODE = '42501'; END $$;
       CREATE TRIGGER qual_authority_guard BEFORE INSERT OR UPDATE ON public.document_extractions
         FOR EACH ROW EXECUTE FUNCTION public.qual_refuse_blob();`);
    try {
      const crossed = await client(urls[0]!, 'service_role', { [ADMISSION_HEADER]: admission })
        .from('document_extractions').insert({ document_id: DOC, organization_id: ORG, data: {} });
      expect(crossed.error?.code).toBe('42501');
      expect(crossed.error?.message).toBe('authority guard');
    } finally {
      sql(`DROP TRIGGER qual_authority_guard ON public.document_extractions; DROP FUNCTION public.qual_refuse_blob();`);
    }
    expireLeasesAndAgeHold();
    expect((await state()).drain_state).toBe('drained');
    // The writer that outlived its lease is refused by the database, with and
    // without its admission header.
    const orphan = await client(urls[0]!, 'service_role', { [ADMISSION_HEADER]: admission })
      .from('document_extractions').insert({ document_id: DOC, organization_id: ORG, data: { orphan: admission } });
    expect(orphan.error?.details).toBe('document_processing_write_fenced:expired');
    const unadmitted = await admin.from('document_extractions').insert({ document_id: DOC, organization_id: ORG, data: {} });
    expect(unadmitted.error?.details).toBe('document_processing_write_fenced:held_unadmitted');
  });

  it('19 compatibility: deployed 5a7fb05 shapes against the new schema, and new code against the old schema', async () => {
    // Old writes while held.
    expect((await legacyCreateJob(admin)).error?.code).toBe('55000');
    expect((await legacyClaim(admin, preHoldQueuedJob)).error?.code).toBe('55000');
    const terminal = await admin.from('document_analysis_jobs').update({ status: 'failed', error_message: 'x' })
      .eq('id', inFlightJob);
    expect(terminal.error).toBeNull();
    const docStatus = await admin.from('documents').update({ processing_status: 'failed' }).eq('id', DOC);
    expect(docStatus.error).toBeNull();
    // Jobless evaluate-style blob rewrite (5a7fb05 sends no admission): fenced.
    // Fixture blob written by a direct (non-application) session.
    sql(`INSERT INTO public.document_extractions(document_id, organization_id, data)
      VALUES ('${DOC}', '${ORG}', '{"marker":"t19"}');`);
    const evaluateWrite = await admin.from('document_extractions').update({ data: { rewritten: true } })
      .eq('document_id', DOC).is('field_key', null);
    expect(evaluateWrite.error?.details).toBe('document_processing_write_fenced:held_unadmitted');
    // New code against the deployed (pre-hold) schema: fails closed.
    const pre = client(urls[2]!) as unknown as DocumentProcessingHoldRpcClient;
    expect((await admitDocumentProcessing(pre, { entryPoint: 'documents_process', organizationId: ORG, documentId: DOC })).status)
      .toBe('unavailable');
    // Old code against the old schema is unaffected (sanity).
    expect((await legacyCreateJob(client(urls[2]!))).error).toBeNull();
  });

  it('13/14 release, then admission resumes for new and old shapes', async () => {
    const r = await hold('release', 'window complete');
    expect(r.status === 'ok' && r.transition).toMatchObject({ outcome: 'applied', held: false });
    const s = await state();
    expect(s).toMatchObject({ held: false, drain_state: 'not_held', held_since: null });
    const a = await admit();
    expect(a.status).toBe('admitted');
    expect((await legacyCreateJob(admin)).error).toBeNull();
    const claimed = await legacyClaim(admin, preHoldQueuedJob);
    expect(claimed.error).toBeNull();
    expect(claimed.data).toHaveLength(1);
    const noop = await hold('release', 'release again');
    expect(noop.status === 'ok' && noop.transition).toMatchObject({ outcome: 'already_released', held: false });
    expect(sql(`SELECT count(*) FROM public.document_processing_hold_transitions`)).toBe(
      sql(`SELECT count(DISTINCT request_key) FROM public.document_processing_hold_transitions`));
  });

  it('04 concurrent hold and admission resolve deterministically (both lock orders)', async () => {
    // A: admission commits late while holding the share lock; hold must wait,
    // and the late admission is then visible to the drain.
    const a = session(`BEGIN; SELECT public.admit_document_processing('documents_process','${ORG}','${DOC}')->>'admitted';
      SELECT pg_sleep(2); COMMIT;`);
    await waitFor(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(2)%' AND pid <> pg_backend_pid() AND state = 'active'`) !== '0', 'admission session');
    const b = session(`SELECT public.set_document_processing_hold('${randomUUID()}','hold','race','${OPERATOR}')->>'outcome';`);
    await waitFor(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%set_document_processing_hold%'`) !== '0', 'hold waits on admission');
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.out).toBe('true');
    expect(rb.out).toBe('applied');
    // The hold's lock wait was observed above; elapsed time is corroboration
    // only (docker exec start-up eats part of the 2 s window on a loaded host).
    expect(rb.ms).toBeGreaterThan(500);
    // Ordering: the late admission committed before the hold took effect.
    expect(sql(`SELECT count(*) FROM public.document_processing_admissions
      WHERE admitted_at > (SELECT held_since FROM public.document_processing_control)`)).toBe('0');
    expect(await state()).toMatchObject({ held: true, drain_state: 'draining', admissions_write_valid: 2 });

    // B: an uncommitted hold holds the exclusive lock; an admission issued
    // meanwhile must wait, then refuse. Starting from the released state, an
    // admission that did NOT wait would read the committed 'not held' and be
    // admitted, so the refusal itself proves the wait.
    await hold('release', 'race 2 start');
    const h = session(`BEGIN; SELECT public.set_document_processing_hold('${randomUUID()}','hold','race 2','${OPERATOR}')->>'outcome';
      SELECT pg_sleep(4); COMMIT;`);
    await waitFor(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND pid <> pg_backend_pid() AND state = 'active'`) !== '0', 'hold session')
      .catch(async (e) => { const r = await h; throw new Error(`${(e as Error).message}; hold session exited ${r.code}: ${r.out}`); });
    expect(sql(`SELECT held FROM public.document_processing_control`)).toBe('f');
    const late = session(`SELECT public.admit_document_processing('documents_process','${ORG}','${DOC}')::text;`);
    const [rh, rl] = await Promise.all([h, late]);
    expect(rh.code).toBe(0);
    expect(JSON.parse(rl.out)).toMatchObject({ admitted: false, reason: 'held' });
    expect(rl.ms).toBeGreaterThan(1000);

    // C: 100 parallel admissions racing one hold over REST.
    await hold('release', 'parallel race');
    const holdVersionBefore = Number((await state()).hold_version);
    const startedCount = Number(sql(`SELECT count(*) FROM public.document_processing_admissions`));
    const t0 = performance.now();
    // 50 admissions start at once; the hold fires alongside them; 50 more are
    // staggered over 0-1225 ms: the hold's HTTP request can queue in PostgREST's own pool behind the burst, so the window must outlast that.
    let holdReturned = Infinity;
    const holding = hold('hold', 'parallel race hold').then((r) => { holdReturned = performance.now(); return r; });
    const lateIssued: number[] = [];
    const replies = await Promise.all([
      ...Array.from({ length: 50 }, () => admit(DOC_PERF)),
      ...Array.from({ length: 50 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i * 25));
        lateIssued[i] = performance.now();
        return admit(DOC_PERF);
      }),
    ]);
    await holding;
    timings['100 parallel admissions racing one hold (wall)'] = `${(performance.now() - t0).toFixed(2)}ms`;
    const admitted = replies.filter((r) => r.status === 'admitted');
    const held = replies.filter((r) => r.status === 'held');
    expect(admitted.length + held.length).toBe(100);
    // Fair lock queue, not starvation: every admission issued after the hold
    // RPC returned is refused (row locks let such a burst delay the hold).
    const issuedAfterHold = replies.slice(50).filter((_, i) => lateIssued[i] > holdReturned);
    expect(issuedAfterHold.length).toBeGreaterThan(0);
    expect(issuedAfterHold.every((r) => r.status === 'held')).toBe(true);
    expect(Number(sql(`SELECT count(*) FROM public.document_processing_admissions`)) - startedCount).toBe(admitted.length);
    expect(admitted.every((r) => r.status === 'admitted' && r.holdVersion === holdVersionBefore)).toBe(true);
    expect(held.every((r) => r.status === 'held' && r.holdVersion === holdVersionBefore + 1)).toBe(true);
    expect(sql(`SELECT count(*) FROM public.document_processing_admissions
      WHERE admitted_at > (SELECT held_since FROM public.document_processing_control)`)).toBe('0');
    timings['parallel race split'] = `${admitted.length} admitted before hold, ${held.length} refused after`;
    await hold('release', 'parallel race done');
  });

  it('20 no canonical or Validator writes: a full hold cycle changes no other table', async () => {
    const before = fingerprint();
    await hold('hold', 'fingerprint hold');
    await state();
    await admit();
    await legacyCreateJob(admin);
    await hold('hold', 'fingerprint duplicate');
    await hold('release', 'fingerprint release');
    const a = await admit(DOC_FIXTURE, 'document_evaluate');
    if (a.status === 'admitted') await closeDocumentProcessingAdmission(rpcA, a.admissionId, 'completed');
    expect(fingerprint()).toBe(before);
  });

  it('perf: admission, drain read and trigger overhead on synthetic history', async () => {
    // Synthetic history: 100k terminal jobs, 50k expired closed admissions.
    sql(`INSERT INTO public.document_analysis_jobs(document_id, organization_id, status, triggered_by, created_at)
           SELECT '${DOC_PERF}', '${ORG}', CASE WHEN g % 2 = 0 THEN 'completed' ELSE 'failed' END, 'upload',
                  clock_timestamp() - make_interval(secs => g)
           FROM generate_series(1, 100000) g;
         INSERT INTO public.document_processing_admissions(entry_point, organization_id, document_id,
           admitted_hold_version, admitted_at, lease_expires_at, closed_at, outcome)
           SELECT 'documents_process', '${ORG}', '${DOC_PERF}', 0, clock_timestamp() - interval '30 days',
                  clock_timestamp() - interval '29 days', clock_timestamp() - interval '29 days', 'completed'
           FROM generate_series(1, 50000);
         ANALYZE public.document_analysis_jobs; ANALYZE public.document_processing_admissions;`);
    const admitTimes: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      const r = await admit(DOC_PERF);
      admitTimes.push(performance.now() - t);
      if (r.status === 'admitted') await closeDocumentProcessingAdmission(rpcA, r.admissionId, 'completed');
    }
    timings['admission RPC via PostgREST (normal operation)'] = fmt(admitTimes);
    const legacyTimes: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      await admin.from('document_analysis_jobs').select('id').eq('id', DOC_PERF).maybeSingle();
      legacyTimes.push(performance.now() - t);
    }
    timings['baseline: trivial PostgREST read (same client)'] = fmt(legacyTimes);
    await hold('hold', 'perf hold');
    const readTimes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      await state();
      readTimes.push(performance.now() - t);
    }
    timings['drain state read via PostgREST (100k jobs, 50k admissions history)'] = fmt(readTimes);
    timings['drain state read in-database'] = sql(`EXPLAIN (ANALYZE, TIMING ON, SUMMARY ON) SELECT public.read_document_processing_hold_state();`)
      .split('\n').filter((l) => l.includes('Execution Time')).join(' ');
    const plan = sql(`EXPLAIN SELECT count(*) FROM public.document_analysis_jobs WHERE status IN ('queued','running');
      EXPLAIN SELECT count(*) FROM public.document_processing_admissions WHERE lease_expires_at > now();
      EXPLAIN SELECT count(*) FROM public.document_processing_admissions WHERE closed_at IS NULL AND lease_expires_at <= now();`);
    expect(plan).not.toMatch(/Seq Scan on document_analysis_jobs/);
    expect(plan).not.toMatch(/Seq Scan on document_processing_admissions/);
    timings['drain query plans'] = plan.split('\n').filter((l) => /Scan/.test(l)).map((l) => l.trim()).join(' | ');
    await hold('release', 'perf release');
    // Trigger overhead per job insert (the only per-run cost besides one admit + one close).
    const withTrigger = sql(`EXPLAIN (ANALYZE, SUMMARY ON) INSERT INTO public.document_analysis_jobs(document_id, organization_id, status, triggered_by)
      SELECT '${DOC_PERF}', '${ORG}', 'completed', 'upload' FROM generate_series(1, 5000);`)
      .split('\n').filter((l) => /Trigger document_analysis_jobs_hold_fence|Execution Time/.test(l)).map((l) => l.trim()).join(' | ');
    timings['5000 job inserts, fence trigger (not held)'] = withTrigger;
    // Hold propagation under load: 4 workers admitting continuously.
    let stop = false;
    let firstRefusalAfterHold = Infinity;
    let holdCommittedAt = Infinity;
    const workers = Array.from({ length: 4 }, async () => {
      while (!stop) {
        const r = await admit(DOC_PERF);
        if (r.status === 'held') firstRefusalAfterHold = Math.min(firstRefusalAfterHold, performance.now());
        if (r.status === 'admitted') await closeDocumentProcessingAdmission(rpcA, r.admissionId, 'completed');
      }
    });
    await new Promise((r) => setTimeout(r, 500));
    const t = performance.now();
    await hold('hold', 'propagation');
    holdCommittedAt = performance.now();
    timings['hold activation under 4-worker admission load (RPC)'] = `${(holdCommittedAt - t).toFixed(2)}ms`;
    await new Promise((r) => setTimeout(r, 500));
    stop = true;
    await Promise.all(workers);
    timings['first refusal after hold RPC returned'] = `${Math.max(0, firstRefusalAfterHold - holdCommittedAt).toFixed(2)}ms`;
    expect(sql(`SELECT count(*) FROM public.document_processing_admissions
      WHERE admitted_at > (SELECT held_since FROM public.document_processing_control)`)).toBe('0');
    await hold('release', 'perf done');
  });
});

// ---------------------------------------------------------------------------
// Write-time fence (migration 20261105120100)
// ---------------------------------------------------------------------------

const ORG2 = 'f0000000-0000-4000-8000-000000000002';
const FA = 'f0000000-0000-4000-8000-000000000101';
const FB = 'f0000000-0000-4000-8000-000000000102';
const FC = 'f0000000-0000-4000-8000-000000000103';
const FDEL = 'f0000000-0000-4000-8000-000000000104';
const FPERF = 'f0000000-0000-4000-8000-000000000105';
const FD = 'f0000000-0000-4000-8000-000000000106';
const fenceTimings: Record<string, string> = {};

async function admitFor(
  documentId: string,
  organizationId = ORG,
  entryPoint: 'documents_process' | 'document_analyze' | 'document_evaluate' | 'project_rerun' = 'documents_process',
): Promise<string> {
  const a = await admitDocumentProcessing(rpcA, { entryPoint, organizationId, documentId });
  if (a.status !== 'admitted') throw new Error(`expected admission for ${documentId}, got ${a.status}`);
  return a.admissionId;
}
const headerClient = (admissionId: string) => client(urls[0]!, 'service_role', { [ADMISSION_HEADER]: admissionId });
function blob(c: SupabaseClient, documentId: string, organizationId: string | null, marker: string) {
  return c.from('document_extractions')
    .insert({ document_id: documentId, organization_id: organizationId, data: { marker } }).select('id').single();
}
const markerCount = (marker: string) =>
  sql(`SELECT count(*) FROM public.document_extractions WHERE data->>'marker' = '${marker}'`);
/** Simulated clock for one admission (disposable superuser only). */
function expireAdmission(admissionId: string): void {
  sql(`SET session_replication_role = replica;
    UPDATE public.document_processing_admissions
      SET admitted_at = admitted_at - interval '2 hours', lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = '${admissionId}';`);
}
async function ensureReleased(): Promise<void> {
  if ((await state()).held) await hold('release', 'fence fixture reset');
}
/** A psql transaction that presents itself exactly as PostgREST does. */
const asPostgrest = (admissionId: string | null) => `SET LOCAL ROLE service_role;
  DO $do$ BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    PERFORM set_config('request.headers', '${JSON.stringify(admissionId ? { [ADMISSION_HEADER]: admissionId } : {})}', true);
  END $do$;`;
const fenceDetail = (r: { error: { details?: string | null } | null }) => r.error?.details ?? null;

describe.skipIf(!enabled)('document processing write fence — disposable PostgreSQL/PostgREST', { timeout: 600_000 }, () => {
  beforeAll(async () => {
    sql(`INSERT INTO public.organizations(id, name) VALUES ('${ORG2}', 'Fence other org');
      INSERT INTO public.documents(id, organization_id, name, storage_path) VALUES
        ('${FA}', '${ORG}', 'fence A', 'fence/a'), ('${FB}', '${ORG}', 'fence B', 'fence/b'),
        ('${FC}', '${ORG2}', 'fence other org', 'fence/c'), ('${FDEL}', '${ORG}', 'fence delete', 'fence/del'),
        ('${FPERF}', '${ORG}', 'fence perf', 'fence/perf'), ('${FD}', '${ORG}', 'fence D', 'fence/d');
      INSERT INTO public.document_extractions(document_id, organization_id, data)
        VALUES ('${FDEL}', '${ORG}', '{"marker":"fdel"}');
      -- An active fact for W10's legacy supersede to target (a zero-row
      -- UPDATE writes nothing, so it would prove nothing).
      INSERT INTO public.document_extractions(document_id, organization_id, data, field_key, field_value_text, status)
        VALUES ('${FA}', '${ORG}', '{}', 'w10_key', 'v', 'active');`);
    await ensureReleased();
  });

  afterAll(() => {
    if (!enabled) return;
    console.log('\n=== WRITE FENCE PERFORMANCE (disposable, synthetic) ===');
    for (const [k, v] of Object.entries(fenceTimings)) console.log(`${k}: ${v}`);
  });

  let a1 = '';
  it('W01 valid admission: blob insert, fact insert, supersede and blob update all commit', async () => {
    a1 = await admitFor(FA);
    const c = headerClient(a1);
    expect((await blob(c, FA, ORG, 'w01')).error).toBeNull();
    const fact = await c.from('document_extractions').insert({
      document_id: FA, organization_id: ORG, data: {}, field_key: 'w01_key', field_value_text: 'v1', status: 'active',
    });
    expect(fact.error).toBeNull();
    const supersede = await c.from('document_extractions').update({ status: 'superseded' })
      .eq('document_id', FA).eq('field_key', 'w01_key');
    expect(supersede.error).toBeNull();
    const rewrite = await c.from('document_extractions').update({ data: { marker: 'w01', diagnostics: true } })
      .eq('document_id', FA).is('field_key', null);
    expect(rewrite.error).toBeNull();
  });

  it('W02 expired admission: refused, and nothing is written', async () => {
    expireAdmission(a1);
    const r = await blob(headerClient(a1), FA, ORG, 'w02');
    expect(fenceDetail(r)).toBe('document_processing_write_fenced:expired');
    expect(r.error?.code).toBe('55000');
    expect(markerCount('w02')).toBe('0');
    // Supplying a new timestamp cannot renew authority: leases are immutable.
    const renew = await admin.from('document_processing_admissions')
      .update({ lease_expires_at: '2999-01-01T00:00:00Z' }).eq('id', a1);
    expect(renew.error?.code).toBe('42501');
  });

  it('W03 closed admission: refused', async () => {
    const id = await admitFor(FA);
    await closeDocumentProcessingAdmission(rpcA, id, 'completed');
    const r = await blob(headerClient(id), FA, ORG, 'w03');
    expect(fenceDetail(r)).toBe('document_processing_write_fenced:closed');
    expect(markerCount('w03')).toBe('0');
  });

  it('W03b stale worker: a newer admission for the document supersedes the older one', async () => {
    const older = await admitFor(FA);
    const newer = await admitFor(FA);
    expect(fenceDetail(await blob(headerClient(older), FA, ORG, 'w03b-old')))
      .toBe('document_processing_write_fenced:superseded');
    expect((await blob(headerClient(newer), FA, ORG, 'w03b-new')).error).toBeNull();
    expect(markerCount('w03b-old')).toBe('0');
    await closeDocumentProcessingAdmission(rpcA, newer, 'completed');
  });

  it('W04 writer resumes after lease expiration (real AsyncLocalStorage transport)', async () => {
    const id = await admitFor(FB);
    const aware = admissionAwareClient(urls[0]!);
    let resume!: () => void;
    const gate = new Promise<void>((r) => { resume = r; });
    const writer = runWithDocumentProcessingAdmission(id, async () => {
      const before = await blob(aware, FB, ORG, 'w04-before');
      await gate;
      const after = await blob(aware, FB, ORG, 'w04-after');
      return { before, after, refusals: [...documentProcessingFenceRefusals()] };
    });
    await waitFor(() => markerCount('w04-before') === '1', 'first write');
    expireAdmission(id);
    resume();
    const r = await writer;
    expect(r.before.error).toBeNull();
    expect(fenceDetail(r.after)).toBe('document_processing_write_fenced:expired');
    expect(r.refusals).toEqual(['expired']);
    expect(markerCount('w04-after')).toBe('0');
  });

  it('W08 timeout leaves asynchronous work running: the abandoned stage cannot write after close', async () => {
    const id = await admitFor(FB);
    const aware = admissionAwareClient(urls[0]!);
    let orphan!: Promise<{ error: { details?: string | null } | null }>;
    const request = runWithDocumentProcessingAdmission(id, async () => {
      orphan = (async () => {
        await new Promise((r) => setTimeout(r, 800));
        return blob(aware, FB, ORG, 'w08-orphan');
      })();
      // The real stage helper: rejects at 150 ms and does not cancel the work.
      return withStageTimeout(orphan, 'canonical persistence', 150);
    });
    await expect(request).rejects.toThrow('timed out after 150ms');
    // The route's finally block closes the admission; the stage keeps running.
    await closeDocumentProcessingAdmission(rpcA, id, 'failed');
    const late = await orphan;
    expect(fenceDetail(late)).toBe('document_processing_write_fenced:closed');
    expect(markerCount('w08-orphan')).toBe('0');
  });

  it('W09 fire-and-forget after completion: protected write refused, Validator and bookkeeping writes pass', async () => {
    const id = await admitFor(FB);
    const aware = admissionAwareClient(urls[0]!);
    let detached!: Promise<Record<string, { error: unknown }>>;
    await runWithDocumentProcessingAdmission(id, async () => {
      // Like `void triggerProjectValidation(...)`: not awaited by the request.
      detached = (async () => {
        await new Promise((r) => setTimeout(r, 500));
        return {
          extraction: await blob(aware, FB, ORG, 'w09-late'),
          validation: await aware.from('activity_events').insert({
            organization_id: ORG, entity_type: 'project_validation_run', entity_id: FB, event_type: 'validation_run_completed',
          }),
          status: await aware.from('documents').update({ processing_status: 'decisioned' }).eq('id', FB),
        };
      })();
    });
    await closeDocumentProcessingAdmission(rpcA, id, 'completed');
    const r = await detached;
    expect(fenceDetail(r.extraction as never)).toBe('document_processing_write_fenced:closed');
    expect(r.validation.error).toBeNull();
    expect(r.status.error).toBeNull();
    expect(markerCount('w09-late')).toBe('0');
  });

  it('W13 cross-organization and cross-document attempts are refused', async () => {
    const id = await admitFor(FA);
    const c = headerClient(id);
    expect(fenceDetail(await blob(c, FC, ORG2, 'w13-doc'))).toBe('document_processing_write_fenced:document_mismatch');
    expect(fenceDetail(await blob(c, FA, ORG2, 'w13-org'))).toBe('document_processing_write_fenced:organization_mismatch');
    const move = await c.from('document_extractions').update({ document_id: FC })
      .eq('document_id', FA).eq('data->>marker', 'w03b-new');
    expect(fenceDetail(move)).toBe('document_processing_write_fenced:document_mismatch');
    expect(markerCount('w13-doc') + markerCount('w13-org')).toBe('00');
    await closeDocumentProcessingAdmission(rpcA, id, 'completed');
  });

  it('W14a forged or malformed admissions are refused even without a hold', async () => {
    expect(fenceDetail(await blob(headerClient(randomUUID()), FA, ORG, 'w14-forged')))
      .toBe('document_processing_write_fenced:unknown_admission');
    expect(fenceDetail(await blob(headerClient('not-a-uuid'), FA, ORG, 'w14-malformed')))
      .toBe('document_processing_write_fenced:malformed_admission');
    // Without a hold, an unadmitted write is the deployed application's normal path.
    expect((await blob(admin, FA, ORG, 'w14-legacy-normal')).error).toBeNull();
  });

  it('B1 derived refreshes never supersede source processing; a newer source run supersedes everything older', async () => {
    const run = await admitFor(FB);                                   // in-flight documents_process
    const evaluate = await admitFor(FB, ORG, 'document_evaluate');    // user clicks evaluate
    const rerun = await admitFor(FB, ORG, 'project_rerun');           // sibling's 7b rerun
    // The run producing new output keeps writing; the derived refreshes also write.
    expect((await blob(headerClient(run), FB, ORG, 'b1-run')).error).toBeNull();
    expect((await blob(headerClient(evaluate), FB, ORG, 'b1-evaluate')).error).toBeNull();
    expect((await blob(headerClient(rerun), FB, ORG, 'b1-rerun')).error).toBeNull();
    // A newer source run makes all three stale.
    const newer = await admitFor(FB, ORG, 'document_analyze');
    for (const [id, marker] of [[run, 'b1-run-2'], [evaluate, 'b1-evaluate-2'], [rerun, 'b1-rerun-2']]) {
      expect(fenceDetail(await blob(headerClient(id), FB, ORG, marker))).toBe('document_processing_write_fenced:superseded');
      expect(markerCount(marker)).toBe('0');
    }
    for (const id of [run, evaluate, rerun, newer]) await closeDocumentProcessingAdmission(rpcA, id, 'completed');
  });

  it('B3 a browser session presenting a valid server admission is refused', async () => {
    const serverAdmission = await admitFor(FA);
    const browser = client(urls[0]!, 'authenticated', { [ADMISSION_HEADER]: serverAdmission });
    const r = await blob(browser, FA, ORG, 'b3-borrowed');
    expect(fenceDetail(r)).toBe('document_processing_write_fenced:admission_role_mismatch');
    expect(markerCount('b3-borrowed')).toBe('0');
    // The server itself still writes under it.
    expect((await blob(headerClient(serverAdmission), FA, ORG, 'b3-server')).error).toBeNull();
    await closeDocumentProcessingAdmission(rpcA, serverAdmission, 'completed');
  });

  it('B5 null document or organization never rides an admission; legacy null-org rows stay updatable', async () => {
    const id = await admitFor(FA);
    const c = headerClient(id);
    expect(fenceDetail(await c.from('document_extractions').insert({ document_id: null, organization_id: ORG, data: { marker: 'b5-nodoc' } })))
      .toBe('document_processing_write_fenced:document_mismatch');
    expect(fenceDetail(await blob(c, FA, null, 'b5-noorg'))).toBe('document_processing_write_fenced:organization_mismatch');
    expect(fenceDetail(await c.from('document_extractions').update({ organization_id: ORG2 }).eq('data->>marker', 'b3-server')))
      .toBe('document_processing_write_fenced:organization_mismatch');
    expect(fenceDetail(await c.from('document_extractions').update({ organization_id: null }).eq('data->>marker', 'b3-server')))
      .toBe('document_processing_write_fenced:organization_mismatch');
    // A legacy row with no organization, inside the admitted document.
    sql(`INSERT INTO public.document_extractions(document_id, organization_id, data)
      VALUES ('${FA}', NULL, '{"marker":"b5-legacy"}');`);
    const legacy = await c.from('document_extractions').update({ data: { marker: 'b5-legacy-updated' } })
      .eq('data->>marker', 'b5-legacy');
    expect(legacy.error).toBeNull();
    expect(markerCount('b5-legacy-updated')).toBe('1');
    expect(markerCount('b5-nodoc') + markerCount('b5-noorg')).toBe('00');
    await closeDocumentProcessingAdmission(rpcA, id, 'completed');
  });

  it('B5b multi-row statements: an accepted row never vouches for a later row that moves tenant or document', async () => {
    const id = await admitFor(FA);
    const c = headerClient(id);
    // Fixture rows written directly (no request context). Inserted in this
    // order, so a sequential scan visits the org-matching row FIRST: before the
    // cache-key fix it filled the per-transaction cache and let the next rows
    // through.
    sql(`INSERT INTO public.document_extractions(document_id, organization_id, data) VALUES
      ('${FA}', '${ORG}',  '{"marker":"b5b-own"}'),
      ('${FA}', NULL,      '{"marker":"b5b-null-org"}'),
      ('${FA}', '${ORG2}', '{"marker":"b5b-other-org"}');`);
    const moveTenant = await c.from('document_extractions').update({ organization_id: ORG })
      .in('data->>marker', ['b5b-own', 'b5b-null-org', 'b5b-other-org']);
    expect(fenceDetail(moveTenant)).toBe('document_processing_write_fenced:organization_mismatch');
    expect(sql(`SELECT string_agg(data->>'marker' || '=' || coalesce(organization_id::text, 'null'), ',' ORDER BY data->>'marker')
      FROM public.document_extractions WHERE data->>'marker' LIKE 'b5b-%'`))
      .toBe(`b5b-null-org=null,b5b-other-org=${ORG2},b5b-own=${ORG}`);

    // Two-row upsert: a genuine insert first, then an ON CONFLICT update that
    // would pull a document-less row (another tenant) into the admitted
    // document. Before the fix the UPDATE reused the INSERT's cache key.
    const strayId = randomUUID();
    sql(`INSERT INTO public.document_extractions(id, document_id, organization_id, data)
      VALUES ('${strayId}', NULL, '${ORG2}', '{"marker":"b5c-stray"}');`);
    const upsert = await c.from('document_extractions').upsert([
      { id: randomUUID(), document_id: FA, organization_id: ORG, data: { marker: 'b5c-new' } },
      { id: strayId, document_id: FA, organization_id: ORG, data: { marker: 'b5c-moved' } },
    ], { onConflict: 'id' });
    expect(fenceDetail(upsert)).toBe('document_processing_write_fenced:document_mismatch');
    expect(markerCount('b5c-new') + markerCount('b5c-moved')).toBe('00');
    expect(sql(`SELECT coalesce(document_id::text, 'null') || '|' || organization_id FROM public.document_extractions WHERE id = '${strayId}'`))
      .toBe(`null|${ORG2}`);
    await closeDocumentProcessingAdmission(rpcA, id, 'completed');
  });

  it('B4 no exclusive lock when not held; transitions give up after lock_timeout instead of stalling', async () => {
    const id = await admitFor(FB);
    const writer = session(`BEGIN; ${asPostgrest(id)}
      INSERT INTO public.document_extractions(document_id, organization_id, data) VALUES ('${FB}', '${ORG}', '{"marker":"b4-long"}');
      SELECT pg_sleep(8); COMMIT;`);
    await waitFor(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(8)%' AND pid <> pg_backend_pid() AND state = 'active'`) !== '0', 'long writer in flight');
    // Not held: the drain read does not queue behind the writer.
    let t = performance.now();
    expect((await state()).drain_state).toBe('not_held');
    const readMs = performance.now() - t;
    expect(readMs).toBeLessThan(2000);
    // A hold would queue behind the writer: it gives up at lock_timeout (5 s),
    // changes nothing, and reports busy.
    t = performance.now();
    const busy = await hold('hold', 'b4 hold behind long writer');
    const holdMs = performance.now() - t;
    expect(busy.status).toBe('busy');
    expect(holdMs).toBeGreaterThan(4000);
    expect((await state()).held).toBe(false);
    expect((await writer).code).toBe(0);
    expect(markerCount('b4-long')).toBe('1');
    fenceTimings['B4 drain read (not held) beside an in-flight writer'] = `${readMs.toFixed(0)}ms`;
    fenceTimings['B4 hold behind an 8 s writer gave up after'] = `${holdMs.toFixed(0)}ms (lock_timeout 5 s)`;
    await closeDocumentProcessingAdmission(rpcA, id, 'completed');
  });

  let inFlight = '';
  it('W06a concurrent hold and protected write: the hold waits for the in-flight writer', async () => {
    inFlight = await admitFor(FD);
    // The writer prints its clock just before COMMIT. If the hold waited for
    // it, held_since (stamped after the lock is granted) is later than that.
    // 3 s stays inside the hold's 5 s lock_timeout.
    const writer = session(`BEGIN; ${asPostgrest(inFlight)}
      INSERT INTO public.document_extractions(document_id, organization_id, data) VALUES ('${FD}', '${ORG}', '{"marker":"w06a"}');
      SELECT pg_sleep(3); SELECT 'writer_done_at=' || clock_timestamp()::text; COMMIT;`);
    await waitFor(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(3)%' AND pid <> pg_backend_pid() AND state = 'active'`) !== '0', 'writer in flight');
    const holder = session(`SELECT public.set_document_processing_hold('${randomUUID()}','hold','w06a hold','${OPERATOR}')->>'outcome';`);
    const [w, h] = await Promise.all([writer, holder]);
    expect(w.code).toBe(0);
    expect(h.out).toBe('applied');
    const writerDoneAt = w.out.split('\n').find((l) => l.startsWith('writer_done_at='))!.slice('writer_done_at='.length);
    expect(sql(`SELECT held_since > '${writerDoneAt}'::timestamptz FROM public.document_processing_control`)).toBe('t');
    expect(markerCount('w06a')).toBe('1');
  });

  it('W05 writer resumes after hold activation: still valid, tracked, and the drain waits for it', async () => {
    expect((await blob(headerClient(inFlight), FD, ORG, 'w05-after-hold')).error).toBeNull();
    expect(await state()).toMatchObject({ held: true, drain_state: 'draining' });
    expect(Number((await state()).admissions_write_valid)).toBeGreaterThanOrEqual(1);
  });

  it('W10 legacy (5a7fb05) direct extraction writers are refused while held', async () => {
    expect(fenceDetail(await blob(admin, FA, ORG, 'w10-blob'))).toBe('document_processing_write_fenced:held_unadmitted');
    const supersede = await admin.from('document_extractions').update({ status: 'superseded' })
      .eq('document_id', FA).eq('status', 'active').not('field_key', 'is', null);
    expect(fenceDetail(supersede)).toBe('document_processing_write_fenced:held_unadmitted');
    const evaluateRewrite = await admin.from('document_extractions').update({ data: { marker: 'w10-rewrite' } })
      .eq('document_id', FA).is('field_key', null);
    expect(fenceDetail(evaluateRewrite)).toBe('document_processing_write_fenced:held_unadmitted');
    expect(markerCount('w10-blob') + markerCount('w10-rewrite')).toBe('00');
  });

  it('W11 legitimate terminal bookkeeping still commits while held, with or without a stale admission', async () => {
    // Fixture: a job already running before the hold (replica mode bypasses
    // the job fence for the fixture insert only).
    const job = sql(`SET session_replication_role = replica;
      INSERT INTO public.document_analysis_jobs(document_id, organization_id, status, triggered_by)
      VALUES ('${FD}', '${ORG}', 'running', 'manual') RETURNING id;`).split('\n').filter(Boolean).pop()!;
    const legacy = await admin.from('document_analysis_jobs').update({ status: 'failed', error_message: 'fenced' }).eq('id', job);
    expect(legacy.error).toBeNull();
    const stale = await headerClient(a1).from('documents').update({ processing_status: 'failed' }).eq('id', FD);
    expect(stale.error).toBeNull();
  });

  it('W12 unrelated document operations are not blocked by the fence', async () => {
    expect((await admin.from('documents').update({ name: 'renamed while held' }).eq('id', FB)).error).toBeNull();
    // Deleting a document cascades to its extraction rows (DELETE is not fenced).
    expect((await admin.from('documents').delete().eq('id', FDEL)).error).toBeNull();
    expect(markerCount('fdel')).toBe('0');
  });

  it('W14b unauthorized direct writes while held are refused', async () => {
    // A browser session is refused by the fence (or earlier, by privileges/RLS);
    // either way nothing is written. Record which layer refused.
    const refusedBy = (r: { error: { code?: string; details?: string | null } | null }) =>
      r.error?.details?.startsWith('document_processing_write_fenced:') ? r.error.details
        : r.error?.code === '42501' ? 'privilege_or_rls' : `NOT REFUSED (${JSON.stringify(r.error)})`;
    const browser = client(urls[0]!, 'authenticated');
    const plain = refusedBy(await blob(browser, FA, ORG, 'w14-browser'));
    expect(['document_processing_write_fenced:held_unadmitted', 'privilege_or_rls']).toContain(plain);
    const forged = client(urls[0]!, 'authenticated', { [ADMISSION_HEADER]: randomUUID() });
    const forgedBy = refusedBy(await blob(forged, FA, ORG, 'w14-browser-forged'));
    expect(['document_processing_write_fenced:admission_role_mismatch', 'privilege_or_rls']).toContain(forgedBy);
    fenceTimings['browser write while held refused by'] = `${plain}; forged header: ${forgedBy}`;
    expect((await blob(client(urls[0]!, 'anon'), FA, ORG, 'w14-anon')).error).not.toBeNull();
    const noPrivilege = await browser.rpc('admit_document_processing', {
      p_entry_point: 'documents_process', p_organization_id: ORG, p_document_id: FA,
    });
    expect(noPrivilege.error?.code).toBe('42501');
    expect(markerCount('w14-browser') + markerCount('w14-browser-forged') + markerCount('w14-anon')).toBe('000');
  });

  it('W06b concurrent revoke and protected write: the writer waits, then is refused', async () => {
    const revoker = session(`BEGIN;
      SELECT public.set_document_processing_hold('${randomUUID()}','revoke','w06b revoke','${OPERATOR}')->>'revoked_admissions';
      SELECT pg_sleep(5); COMMIT;`);
    await waitFor(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(5)%' AND pid <> pg_backend_pid() AND state = 'active'`) !== '0', 'revoke in flight');
    // Still valid at this instant: the revoke has not committed.
    expect(sql(`SELECT closed_at IS NULL FROM public.document_processing_admissions WHERE id = '${inFlight}'`)).toBe('t');
    const t = performance.now();
    let writerDone = 0;
    const writer = blob(headerClient(inFlight), FD, ORG, 'w06b').then((r) => { writerDone = performance.now(); return r; });
    const [rv, w] = await Promise.all([revoker, writer]);
    const revokeDone = performance.now();
    expect(rv.code).toBe(0);
    expect(Number(rv.out.split('\n')[0])).toBeGreaterThanOrEqual(1);
    // The writer was issued while its admission was still valid, yet it is
    // refused as revoked: its check ran only after the revoke committed, so it
    // waited on the hold lock rather than racing past it.
    expect(fenceDetail(w)).toBe('document_processing_write_fenced:revoked');
    expect(writerDone - t).toBeGreaterThan(1000);
    fenceTimings['W06b writer blocked behind uncommitted revoke'] =
      `${(writerDone - t).toFixed(0)}ms (revoke session returned ${(revokeDone - t).toFixed(0)}ms after the writer was issued)`;
    expect(markerCount('w06b')).toBe('0');
    expect(await state()).toMatchObject({ drain_state: 'drained', admissions_write_valid: 0 });
  });

  it('W07 a transaction that wrote under a valid admission cannot commit after it expires', async () => {
    await hold('release', 'w07 fixture');
    const id = await admitFor(FD);
    const writer = session(`BEGIN; ${asPostgrest(id)}
      INSERT INTO public.document_extractions(document_id, organization_id, data) VALUES ('${FD}', '${ORG}', '{"marker":"w07"}');
      SELECT 'inserted';
      SELECT pg_sleep(3); COMMIT;`);
    await waitFor(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(3)%' AND pid <> pg_backend_pid() AND state = 'active'`) !== '0', 'writer between insert and commit');
    expireAdmission(id);
    const w = await writer;
    expect(w.out).toContain('inserted');
    expect(w.out).toContain('protected processing write refused: expired');
    expect(w.code).not.toBe(0);
    expect(markerCount('w07')).toBe('0');
    // Control: the same interleaving without expiry commits.
    const ok = await admitFor(FD);
    const control = await session(`BEGIN; ${asPostgrest(ok)}
      INSERT INTO public.document_extractions(document_id, organization_id, data) VALUES ('${FD}', '${ORG}', '{"marker":"w07-control"}');
      SELECT pg_sleep(1); COMMIT;`);
    expect(control.code).toBe(0);
    expect(markerCount('w07-control')).toBe('1');
    await closeDocumentProcessingAdmission(rpcA, ok, 'completed');
  });

  it('W15 processing restart: admissions survive PostgREST and database restarts; validity is unchanged', async () => {
    const id = await admitFor(FB);
    execFileSync('docker', ['restart', restA]);
    await reattachRestA();
    execFileSync('docker', ['restart', db]);
    await waitFor(() => {
      try { return sql('SELECT 1') === '1'; } catch { return false; }
    }, 'database restart', 60_000);
    await reattachRestA();
    expect((await blob(headerClient(id), FB, ORG, 'w15-valid')).error).toBeNull();
    expireAdmission(id);
    expect(fenceDetail(await blob(headerClient(id), FB, ORG, 'w15-expired'))).toBe('document_processing_write_fenced:expired');
  });

  it('W16 verified drained state: drained only when no admission can write, and it stays drained', async () => {
    const pending = await admitFor(FA);
    await hold('hold', 'w16 hold');
    expect(await state()).toMatchObject({ drain_state: 'draining' });
    // The drain read is ordered after an in-flight protected write.
    const writer = session(`BEGIN; ${asPostgrest(pending)}
      INSERT INTO public.document_extractions(document_id, organization_id, data) VALUES ('${FA}', '${ORG}', '{"marker":"w16-inflight"}');
      SELECT pg_sleep(2); COMMIT;`);
    await waitFor(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(2)%' AND pid <> pg_backend_pid() AND state = 'active'`) !== '0', 'writer in flight');
    const t = performance.now();
    const read = await state();
    fenceTimings['drain read waiting behind an in-flight protected write'] = `${(performance.now() - t).toFixed(0)}ms`;
    expect(performance.now() - t).toBeGreaterThan(1000);
    expect((await writer).code).toBe(0);
    expect(read.drain_state).toBe('draining');
    expect(markerCount('w16-inflight')).toBe('1');

    const revoked = await hold('revoke', 'w16 revoke');
    expect(revoked.status === 'ok' && Number(revoked.transition.revoked_admissions)).toBeGreaterThanOrEqual(1);
    expect(await state()).toMatchObject({ drain_state: 'drained', admissions_write_valid: 0 });
    // Every writer variant is now refused.
    expect(fenceDetail(await blob(headerClient(pending), FA, ORG, 'w16-x'))).toBe('document_processing_write_fenced:revoked');
    expect(fenceDetail(await blob(admin, FA, ORG, 'w16-x'))).toBe('document_processing_write_fenced:held_unadmitted');
    expect(fenceDetail(await blob(headerClient(randomUUID()), FA, ORG, 'w16-x'))).toBe('document_processing_write_fenced:unknown_admission');
    expect((await admin.from('document_analysis_jobs').insert({
      document_id: FA, organization_id: ORG, status: 'queued', triggered_by: 'manual', admission_id: pending,
    })).error?.code).toBe('55000');
    expect(await admit(FA)).toMatchObject({ status: 'held' });
    expect(markerCount('w16-x')).toBe('0');
    expect(await state()).toMatchObject({ drain_state: 'drained' });
    // Revoke is audited and only valid while held.
    expect(sql(`SELECT action, outcome, held_before, held_after FROM public.document_processing_hold_transitions
      WHERE request_key = (SELECT request_key FROM public.document_processing_hold_transitions WHERE action = 'revoke' ORDER BY recorded_at DESC LIMIT 1)`))
      .toBe('revoke|revoked|t|t');
    await hold('release', 'w16 release');
    expect((await hold('revoke', 'revoke without hold')).status).toBe('not_held');
    const fresh = await admitFor(FA);
    expect((await blob(headerClient(fresh), FA, ORG, 'w16-after-release')).error).toBeNull();
    await closeDocumentProcessingAdmission(rpcA, fresh, 'completed');
  });

  it('perf: fence overhead per protected write', async () => {
    const rows = (n: number, marker: string) => Array.from({ length: n }, (_, i) => ({
      document_id: FPERF, organization_id: ORG, data: { marker }, field_key: `perf_${i}`, field_value_text: String(i), status: 'active',
    }));
    async function timeInserts(c: SupabaseClient, label: string): Promise<number[]> {
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t = performance.now();
        const r = await c.from('document_extractions').insert(rows(500, label));
        times.push(performance.now() - t);
        if (r.error) throw new Error(`${label}: ${r.error.message}`);
      }
      return times;
    }
    const id = await admitFor(FPERF);
    fenceTimings['500-row fact insert, admitted (BEFORE + commit check)'] = fmt(await timeInserts(headerClient(id), 'perf-admitted'));
    fenceTimings['500-row fact insert, unadmitted, not held'] = fmt(await timeInserts(admin, 'perf-legacy'));
    sql(`ALTER TABLE public.document_extractions DISABLE TRIGGER document_extractions_processing_write_fence;
      ALTER TABLE public.document_extractions DISABLE TRIGGER document_extractions_processing_write_fence_commit;`);
    try {
      fenceTimings['500-row fact insert, fence triggers disabled (baseline)'] = fmt(await timeInserts(admin, 'perf-baseline'));
    } finally {
      sql(`ALTER TABLE public.document_extractions ENABLE TRIGGER document_extractions_processing_write_fence;
        ALTER TABLE public.document_extractions ENABLE TRIGGER document_extractions_processing_write_fence_commit;`);
    }
    const single: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      await blob(headerClient(id), FPERF, ORG, 'perf-single');
      single.push(performance.now() - t);
    }
    fenceTimings['single admitted blob insert'] = fmt(single);
    await closeDocumentProcessingAdmission(rpcA, id, 'completed');
  });
});

// ---------------------------------------------------------------------------
// Platform-owner grant ledger (migration 20261105120200)
// ---------------------------------------------------------------------------

const OWNER_B = 'e0000000-0000-4000-8000-0000000000b2';
const NO_PROFILE = 'e0000000-0000-4000-8000-0000000000ff';

describe.skipIf(!enabled)('platform-owner grant ledger — disposable PostgreSQL/PostgREST', { timeout: 600_000 }, () => {
  /** A direct database session, as the owner's SQL editor would be. */
  const grant = (subject: string, granted: boolean, recordedBy: string, reason: string) =>
    session(`INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
      VALUES ('${subject}', ${granted}, '${recordedBy}', '${reason}');`);
  const isOwner = async (userId: string) => {
    const { data, error } = await admin.rpc('is_platform_owner', { p_user_id: userId });
    if (error) throw new Error(error.message);
    return data;
  };

  beforeAll(() => {
    sql(`INSERT INTO auth.users(id, email) VALUES ('${OWNER_B}', 'second@example.test');
      INSERT INTO public.user_profiles(id, organization_id, role) VALUES ('${OWNER_B}', '${ORG}', 'admin');`);
  });

  it('P1 nobody is platform owner until the bootstrap grant; then exactly the granted account is', async () => {
    expect(await isOwner(OPERATOR)).toBe(false);
    const boot = await grant(OPERATOR, true, OPERATOR, 'Founder bootstrap');
    expect(boot.code).toBe(0);
    expect(await isOwner(OPERATOR)).toBe(true);
    expect(await isOwner(OWNER_B)).toBe(false);
    // Provenance: who, why, when, and which database role recorded it.
    expect(sql(`SELECT recorded_by, reason, recorded_by_db_role, recorded_at IS NOT NULL
      FROM public.platform_owner_grant_events WHERE subject_user_id = '${OPERATOR}'`))
      .toBe(`${OPERATOR}|Founder bootstrap|postgres|t`);
  });

  it('P2 no API role can grant, alter or erase ownership, or even ask the ledger as a browser', async () => {
    const forged = await admin.from('platform_owner_grant_events')
      .insert({ subject_user_id: OWNER_B, granted: true, recorded_by: OWNER_B, reason: 'self-grant via API' });
    expect(forged.error?.code).toBe('42501');
    expect((await admin.from('platform_owner_grant_events').update({ granted: false }).eq('subject_user_id', OPERATOR)).error?.code).toBe('42501');
    expect((await admin.from('platform_owner_grant_events').delete().eq('subject_user_id', OPERATOR)).error?.code).toBe('42501');
    for (const role of ['authenticated', 'anon'] as const) {
      const r = await client(urls[0]!, role).rpc('is_platform_owner', { p_user_id: OPERATOR });
      expect(r.error?.code).toBe('42501');
      expect((await client(urls[0]!, role).from('platform_owner_grant_events').select('*')).error?.code).toBe('42501');
    }
    expect(await isOwner(OWNER_B)).toBe(false);
    expect(await isOwner(OPERATOR)).toBe(true);
  });

  it('P3 the ledger is append-only even for a direct session', async () => {
    const update = await session(`UPDATE public.platform_owner_grant_events SET granted = false WHERE subject_user_id = '${OPERATOR}';`);
    expect(update.out).toContain('append-only');
    const del = await session(`DELETE FROM public.platform_owner_grant_events;`);
    expect(del.out).toContain('append-only');
    const trunc = await session(`TRUNCATE public.platform_owner_grant_events;`);
    expect(trunc.out).toContain('append-only');
    expect(await isOwner(OPERATOR)).toBe(true);
  });

  it('P4 one platform owner at a time: a second grant is refused until the first is revoked', async () => {
    const second = await grant(OWNER_B, true, OPERATOR, 'second owner while first active');
    expect(second.out).toContain('another platform owner is active');
    expect(await isOwner(OWNER_B)).toBe(false);
    expect((await grant(OPERATOR, false, OPERATOR, 'hand over')).code).toBe(0);
    expect(await isOwner(OPERATOR)).toBe(false);
    expect((await grant(OWNER_B, true, OPERATOR, 'hand over')).code).toBe(0);
    expect(await isOwner(OWNER_B)).toBe(true);
    // Hand back for the remaining tests.
    expect((await grant(OWNER_B, false, OWNER_B, 'hand back')).code).toBe(0);
    expect((await grant(OPERATOR, true, OWNER_B, 'hand back')).code).toBe(0);
    expect(await isOwner(OPERATOR)).toBe(true);
    expect(await isOwner(OWNER_B)).toBe(false);
  });

  it('P5 every event names real accounts', async () => {
    expect((await grant(NO_PROFILE, true, OPERATOR, 'ghost subject')).out).toContain('subject has no user profile');
    expect((await grant(OPERATOR, true, NO_PROFILE, 'ghost recorder')).out).toContain('recorder has no user profile');
  });

  it('P6 concurrent grants for two accounts: exactly one can become active', async () => {
    expect((await grant(OPERATOR, false, OPERATOR, 'reset for race')).code).toBe(0);
    const [a, b] = await Promise.all([
      session(`BEGIN; INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
        VALUES ('${OPERATOR}', true, '${OPERATOR}', 'race a'); SELECT pg_sleep(1); COMMIT;`),
      session(`BEGIN; INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
        VALUES ('${OWNER_B}', true, '${OPERATOR}', 'race b'); SELECT pg_sleep(1); COMMIT;`),
    ]);
    expect([a.code, b.code].filter((c) => c === 0)).toHaveLength(1);
    const owners = [await isOwner(OPERATOR), await isOwner(OWNER_B)].filter(Boolean);
    expect(owners).toHaveLength(1);
  });

  it('P7 revocation takes effect immediately and stays audited', async () => {
    const active = (await isOwner(OPERATOR)) ? OPERATOR : OWNER_B;
    expect((await grant(active, false, active, 'revoked')).code).toBe(0);
    expect(await isOwner(active)).toBe(false);
    expect(Number(sql(`SELECT count(*) FROM public.platform_owner_grant_events`))).toBeGreaterThanOrEqual(8);
  });

  const activeOwnerCount = () => Number(sql(`SELECT count(*) FROM (SELECT DISTINCT ON (subject_user_id) granted
    FROM public.platform_owner_grant_events ORDER BY subject_user_id, event_seq DESC) l WHERE l.granted`));
  const racingGrants = (isolation: string) => Promise.all([OPERATOR, OWNER_B].map((subject) =>
    session(`BEGIN ISOLATION LEVEL ${isolation}; INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
      VALUES ('${subject}', true, '${OPERATOR}', 'race ${isolation}'); SELECT pg_sleep(1); COMMIT;`)));

  it('P8 one owner holds at every isolation level: REPEATABLE READ grants refused; SERIALIZABLE race yields one', async () => {
    expect(activeOwnerCount()).toBe(0);
    // Without the stamp trigger's refusal, both of these commit (two owners).
    const rr = await racingGrants('REPEATABLE READ');
    expect(rr.map((r) => r.code)).not.toContain(0);
    for (const r of rr) expect(r.out).toContain('cannot be recorded under REPEATABLE READ');
    expect(activeOwnerCount()).toBe(0);

    const ser = await racingGrants('SERIALIZABLE');
    expect(ser.filter((r) => r.code === 0)).toHaveLength(1);
    expect(activeOwnerCount()).toBe(1);

    // Revocation is never blocked by isolation level.
    const active = (await isOwner(OPERATOR)) ? OPERATOR : OWNER_B;
    const revoke = await session(`BEGIN ISOLATION LEVEL REPEATABLE READ; INSERT INTO public.platform_owner_grant_events
      (subject_user_id, granted, recorded_by, reason) VALUES ('${active}', false, '${OPERATOR}', 'revoke under RR'); COMMIT;`);
    expect(revoke.code).toBe(0);
    expect(activeOwnerCount()).toBe(0);
  });

  it('P9 the database stamps attribution: a writer cannot supply the role or the time', async () => {
    const forged = await session(`INSERT INTO public.platform_owner_grant_events
      (subject_user_id, granted, recorded_by, reason, recorded_by_db_role, recorded_at)
      VALUES ('${OPERATOR}', false, '${OPERATOR}', 'forged attribution', 'service_role', '2000-01-01T00:00:00Z');`);
    expect(forged.code).toBe(0);
    expect(sql(`SELECT recorded_by_db_role, recorded_at > now() - interval '5 minutes'
      FROM public.platform_owner_grant_events ORDER BY event_seq DESC LIMIT 1`)).toBe('postgres|t');
  });
});
