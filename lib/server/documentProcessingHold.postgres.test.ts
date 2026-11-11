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

function client(url: string, role: 'service_role' | 'authenticated' | 'anon' = 'service_role'): SupabaseClient {
  return createClient(url, token(role), {
    auth: { persistSession: false },
    global: { fetch: (input, init) => fetch(String(input).replace('/rest/v1', ''), init) },
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

async function hold(action: 'hold' | 'release', reason = `qualification ${action}`, key: string = randomUUID()) {
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
    expect(s).toMatchObject({ drain_state: 'draining', admissions_open_in_lease: 1 });
  });

  it('08 normal completion: terminal writes are never fenced; closing keeps the lease running', async () => {
    const done = await admin.from('document_analysis_jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', inFlightJob);
    expect(done.error).toBeNull();
    await closeDocumentProcessingAdmission(rpcA, inFlightAdmission, 'completed');
    const again = await admin.rpc('close_document_processing_admission', { p_admission_id: inFlightAdmission, p_outcome: 'failed' });
    expect(again.data).toEqual({ closed: false, outcome: 'completed' });
    const s = await state();
    expect(s).toMatchObject({ drain_state: 'draining', admissions_open_in_lease: 0 });
    expect(Number(s.admissions_closed_in_lease)).toBeGreaterThanOrEqual(1);
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
    expect(await state()).toMatchObject({ drain_state: 'draining', admissions_open_in_lease: 1 });
    expireLeasesAndAgeHold();
    const s = await state();
    expect(s).toMatchObject({ drain_state: 'drained', admissions_abandoned: 1, admissions_open_in_lease: 0 });
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

  it('18 migration boundary: drained only after every lease; the hold does not fence extraction writes', async () => {
    await hold('release', 'boundary fixture');
    const a = await admit();
    const admission = a.status === 'admitted' ? a.admissionId : '';
    await hold('hold', 'boundary hold');
    const draining = await state();
    expect(draining.drain_state).toBe('draining');
    expect(new Date(String(draining.drain_not_before)).getTime())
      .toBeGreaterThanOrEqual(new Date(String(draining.held_since)).getTime() + 900_000);
    // A simulated authority guard (stand-in for A1) installed while draining
    // would refuse the in-flight writer: exactly why the window waits for
    // 'drained' before migrating.
    sql(`CREATE FUNCTION public.qual_refuse_blob() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'authority guard' USING ERRCODE = '42501'; END $$;
       CREATE TRIGGER qual_authority_guard BEFORE INSERT OR UPDATE ON public.document_extractions
         FOR EACH ROW EXECUTE FUNCTION public.qual_refuse_blob();`);
    const crossed = await admin.from('document_extractions').insert({ document_id: DOC, organization_id: ORG, data: {} });
    expect(crossed.error?.code).toBe('42501');
    sql(`DROP TRIGGER qual_authority_guard ON public.document_extractions; DROP FUNCTION public.qual_refuse_blob();`);
    expireLeasesAndAgeHold();
    expect((await state()).drain_state).toBe('drained');
    // Residual (documented, not fixed here): nothing in the database stops a
    // writer that outlives its lease from writing extraction rows directly.
    const orphan = await admin.from('document_extractions').insert({ document_id: DOC, organization_id: ORG, data: { orphan: admission } });
    expect(orphan.error).toBeNull();
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
    // Jobless evaluate-style blob rewrite: NOT fenced by the hold.
    const evaluateWrite = await admin.from('document_extractions').update({ data: { rewritten: true } })
      .eq('document_id', DOC).is('field_key', null);
    expect(evaluateWrite.error).toBeNull();
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
    expect(rb.ms).toBeGreaterThan(1500);
    expect(await state()).toMatchObject({ held: true, drain_state: 'draining', admissions_open_in_lease: 2 });

    // B: hold transition holds FOR UPDATE; admission must wait, then refuse.
    const h = session(`BEGIN; SELECT public.set_document_processing_hold('${randomUUID()}','release','race 2','${OPERATOR}')->>'outcome';
      SELECT pg_sleep(1); SELECT public.set_document_processing_hold('${randomUUID()}','hold','race 2','${OPERATOR}')->>'outcome';
      SELECT pg_sleep(1); COMMIT;`);
    await waitFor(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(1)%' AND pid <> pg_backend_pid() AND state = 'active'`) !== '0', 'hold session');
    const late = session(`SELECT public.admit_document_processing('documents_process','${ORG}','${DOC}')::text;`);
    await waitFor(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%admit_document_processing%'`) !== '0', 'admission waits on hold');
    const [rh, rl] = await Promise.all([h, late]);
    expect(rh.code).toBe(0);
    expect(JSON.parse(rl.out)).toMatchObject({ admitted: false, reason: 'held' });

    // C: 100 parallel admissions racing one hold over REST.
    await hold('release', 'parallel race');
    const holdVersionBefore = Number((await state()).hold_version);
    const startedCount = Number(sql(`SELECT count(*) FROM public.document_processing_admissions`));
    const t0 = performance.now();
    // 50 admissions start at once; the hold fires alongside them; 50 more are
    // staggered across the hold's commit so the race straddles it.
    const holding = hold('hold', 'parallel race hold');
    const replies = await Promise.all([
      ...Array.from({ length: 50 }, () => admit(DOC_PERF)),
      ...Array.from({ length: 50 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i * 5));
        return admit(DOC_PERF);
      }),
    ]);
    await holding;
    timings['100 parallel admissions racing one hold (wall)'] = `${(performance.now() - t0).toFixed(2)}ms`;
    const admitted = replies.filter((r) => r.status === 'admitted');
    const held = replies.filter((r) => r.status === 'held');
    expect(admitted.length + held.length).toBe(100);
    // Fair lock queue: the hold is not starved by the burst, so the race
    // genuinely straddles it.
    expect(admitted.length).toBeGreaterThan(0);
    expect(held.length).toBeGreaterThan(0);
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
