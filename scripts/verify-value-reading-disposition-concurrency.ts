import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { psqlServiceRoleClient, sqlLiteral } from './lib/psqlServiceRoleClient';

/** Disposable B4.4 two-session qualification. Reuses B4.2 source fixtures,
 * but each probe has its own proposal, request digests and anchor. It waits
 * for an observed PostgreSQL lock rather than assuming a timing race. */
const databaseUrl = process.env.B42_DATABASE_URL;
if (!databaseUrl) throw new Error('B42_DATABASE_URL is required');
const db = psqlServiceRoleClient(databaseUrl);
const ORG = 'b4200000-0000-4000-8000-000000000001';
const ACTOR = 'b4200000-0000-4000-8000-0000000000a1';
const DOC = 'b4200000-0000-4000-8000-0000000000d1';
const PROJECT = 'b4200000-0000-4000-8000-0000000000e1';
const ARTIFACT = 'b4200000-0000-4000-8000-0000000000f1';
const hash = (key: string) => createHash('sha256').update(`b44-concurrency:${key}`).digest('hex');
const q = sqlLiteral;
const region = q(JSON.stringify({ coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 1, y_max: 2 }] }));
const value = q(JSON.stringify({ description: 'Concurrency fixture', unit_type: 'CY', rate_amount: 14.5 }));
function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`B4.4 CONCURRENCY FAIL: ${label}`);
}
function session(name: string) {
  const child = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-At',
    '--dbname', databaseUrl!], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let finished = false;
  child.stdout.on('data', (data) => { stdout += String(data); });
  child.stderr.on('data', (data) => { stderr += String(data); });
  const complete = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('error', (error) => { stderr += String(error); });
    child.on('close', (code) => { finished = true; resolve({ code, stdout, stderr }); });
  });
  child.stdin.write(`SET application_name=${q(name)}; SET statement_timeout='60s';
    SET idle_in_transaction_session_timeout='60s'; SET ROLE service_role; SET request.jwt.claim.role='service_role';\n`);
  return { child, complete, output: () => stdout, finished: () => finished };
}
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    check(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
function proposal(key: string) {
  const digest = hash(`proposal:${key}`); const id = `forgewing-proposal-value-reading-${digest}`;
  const anchor = `p8:b44-concurrency:${key}`;
  db.runSql(`SET ROLE service_role; SET request.jwt.claim.role='service_role';
    SELECT json_agg(r) FROM public.record_forgewing_value_reading_proposal(
      ${q(ORG)}, ${q(PROJECT)}, ${q(DOC)}, ${q(ARTIFACT)}, 'b44-concurrency-extraction', ${q(`case:${key}`)},
      8, ${q('a'.repeat(64))}, 'contract_rate_row', ${q(anchor)}, ARRAY['b44-observation'], ${region}::jsonb,
      'value', ${value}::jsonb, 'region_image', NULL, 'priced_value_reading', 'v1', 'forgewing-value-reading-proposal-v3',
      ${q(hash(`request:${key}`))}, ${q(hash(`output:${key}`))}, ${q(digest)}, ${q(id)}, 'Concurrency fixture') r;`);
  return { id, digest, anchor, key };
}
type Probe = ReturnType<typeof proposal>;
function assertion(p: Probe, suffix = 'use', supersedes: string | null = null) {
  return `SELECT json_agg(r) FROM public.record_region_bound_human_fact_assertion(
    ${q(ORG)}, ${q(ACTOR)}, ${q(DOC)}, 'contract_rate_row', ${value}::jsonb, 'active', 'Checked source fixture',
    ${q(ARTIFACT)}, 8, ${region}::jsonb, ${q('a'.repeat(64))}, NULL, ARRAY['b44-observation'], 'fixture',
    ${q(p.anchor)}, 'ai_proposed', ${q(p.id)}, ${q(supersedes)}::uuid, ${q(hash(`${p.key}:${suffix}`))}) r;`;
}
function review(p: Probe, disposition: 'rejected' | 'deferred', legacy = false) {
  return `SELECT json_agg(r) FROM public.${legacy ? 'record_forgewing_recovery_proposal_review' : 'record_forgewing_value_reading_review'}(
    ${q(ORG)}, ${q(p.id)}, ${q(p.digest)}, ${q(ACTOR)}, ${q(disposition)}, ${legacy ? 'NULL, ' : ''}
    'Concurrency disposition', ${q(hash(`${p.key}:review`))}) r;`;
}
function locked(name: string) {
  const result = db.runSql(`SELECT json_build_object('waiting', EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity WHERE application_name=${q(name)} AND wait_event_type='Lock'))`) as { waiting: boolean };
  return result.waiting;
}
function truthCount(p: Probe) {
  return (db.runSql(`SELECT json_build_object('n', count(*)) FROM public.human_fact_assertions
    WHERE source_document_id=${q(DOC)} AND anchor_key=${q(p.anchor)}`) as { n: number }).n;
}

// Reproduce the deployed B4.2 gap with its exact, hash-pinned B3 definition.
// The owner-only function replacement and the demonstrated assertion both
// roll back together; the forward guard is restored before fixed checks run.
const deployed = readFileSync('supabase/migrations/20261004220000_forgewing_value_reading_proposals.sql', 'utf8')
  .replace(/\r\n/g, '\n');
check(createHash('sha256').update(deployed).digest('hex')
  === '127fcbb41a6e6bcff51cd6c871a173c4c7c44ea235eca23c6d8e55a6263592c7',
  'deployed B4.2 migration LF-normalized SHA-256 is unchanged');
const b3Start = 'CREATE OR REPLACE FUNCTION public.record_region_bound_human_fact_assertion(';
check(deployed.includes(b3Start), 'exact deployed B3 function is available');
const deployedB3 = deployed.slice(deployed.indexOf(b3Start));
for (const disposition of ['rejected', 'deferred'] as const) {
  const p = proposal(`baseline-${disposition}`);
  db.runSql(`SET ROLE service_role; SET request.jwt.claim.role='service_role'; ${review(p, disposition)}`);
  const result = db.runSql(`BEGIN; ${deployedB3}
    SET LOCAL ROLE service_role; SET LOCAL request.jwt.claim.role='service_role';
    DO $$ DECLARE r record; BEGIN
      SELECT * INTO r FROM public.record_region_bound_human_fact_assertion(
        ${q(ORG)}, ${q(ACTOR)}, ${q(DOC)}, 'contract_rate_row', ${value}::jsonb, 'active', 'Baseline reproduction',
        ${q(ARTIFACT)}, 8, ${region}::jsonb, ${q('a'.repeat(64))}, NULL, ARRAY['b44-observation'], 'fixture',
        ${q(p.anchor)}, 'ai_proposed', ${q(p.id)}, NULL, ${q(hash(`${p.key}:use`))});
      IF NOT r.inserted OR NOT EXISTS (SELECT 1 FROM public.human_fact_assertions
        WHERE id = r.assertion_id AND review_origin='ai_proposed_operator_approved') THEN
        RAISE EXCEPTION 'B4.4 baseline defect did not reproduce';
      END IF;
    END $$;
    SELECT json_build_object('baseline_promoted', true); ROLLBACK;`) as { baseline_promoted: boolean };
  check(result.baseline_promoted && truthCount(p) === 0, `${disposition} baseline promoted only inside rollback transaction`);
  const fixed = session(`b44-fixed-baseline-${disposition}`); fixed.child.stdin.end(assertion(p));
  const refused = await fixed.complete;
  check(refused.code !== 0 && /23514/.test(refused.stderr) && truthCount(p) === 0,
    `forward migration refuses same ${disposition} fixture after baseline rollback`);
}
console.log('B4.4 DEPLOYED B3 REJECTED / DEFERRED PROMOTION DEFECT REPRODUCED IN ROLLBACK: PASS');

for (const [key, disposition, legacy] of [
  ['reject-first', 'rejected', false], ['defer-first', 'deferred', false], ['legacy-first', 'rejected', true],
] as const) {
  const p = proposal(key); const holder = session(`b44-holder-${key}`); const writerName = `b44-writer-${key}`;
  let writer: ReturnType<typeof session> | null = null;
  try {
    holder.child.stdin.write(`BEGIN; ${review(p, disposition, legacy)}\n\\echo REVIEW_LOCK_HELD\n`);
    await until(() => holder.output().includes('REVIEW_LOCK_HELD') || holder.finished(), 'review row lock');
    check(holder.output().includes('REVIEW_LOCK_HELD'), 'review transaction acquired its lock');
    writer = session(writerName); writer.child.stdin.end(assertion(p));
    await until(() => locked(writerName) || writer!.finished(), 'B3 citation waiting for review');
    check(!writer.finished() && locked(writerName), 'B3 waits on review transaction');
    check(truthCount(p) === 0, 'waiting citation created no truth');
    holder.child.stdin.end('COMMIT;\n');
    const held = await holder.complete; const refused = await writer.complete;
    check(held.code === 0, `review committed: ${held.stderr}`);
    check(refused.code !== 0 && /23514/.test(refused.stderr), `citation refuses after disposition commit: ${refused.stderr}`);
    check(truthCount(p) === 0, 'refused concurrent citation leaves no truth');
  } finally {
    holder.child.kill(); writer?.child.kill();
  }
}

// Reverse ordering: a committed human assertion remains truth after a review.
const p = proposal('promotion-first'); const holder = session('b44-promotion-holder');
let later: ReturnType<typeof session> | null = null;
try {
  holder.child.stdin.write(`BEGIN; ${assertion(p)}\n\\echo ASSERTION_LOCK_HELD\n`);
  await until(() => holder.output().includes('ASSERTION_LOCK_HELD') || holder.finished(), 'assertion row lock');
  check(holder.output().includes('ASSERTION_LOCK_HELD'), 'human assertion acquired proposal lock');
  later = session('b44-later-review'); later.child.stdin.end(review(p, 'rejected'));
  await until(() => locked('b44-later-review') || later!.finished(), 'later review waiting on assertion');
  check(!later.finished() && locked('b44-later-review'), 'review waits for earlier human assertion');
  holder.child.stdin.end('COMMIT;\n');
  check((await holder.complete).code === 0, 'human assertion commits');
  check((await later.complete).code === 0, 'later rejection commits');
  check(truthCount(p) === 1, 'later review preserves existing truth');
  const replay = db.runSql(`SET ROLE service_role; SET request.jwt.claim.role='service_role'; ${assertion(p)}`) as
    Array<{ assertion_id: string; inserted: boolean }>;
  check(replay.length === 1 && replay[0]!.inserted === false, 'exact assertion replay survives later rejection');
  const refused = session('b44-new-citation'); refused.child.stdin.end(assertion(p, 'new-use', replay[0]!.assertion_id));
  const result = await refused.complete;
  check(result.code !== 0 && /23514/.test(result.stderr) && truthCount(p) === 1, 'new citation refused without mutating prior truth');
} finally {
  holder.child.kill(); later?.child.kill();
}
console.log('B4.4 TWO-SESSION DISPOSITION / CITATION SERIALIZATION / HISTORICAL TRUTH REPLAY: PASS');
