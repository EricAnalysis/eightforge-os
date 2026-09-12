import { execFileSync } from 'node:child_process';

import {
  persistForgewingRecoveryGenerationOutcome,
  recoveryGenerationDiagnosticId,
  type RecoveryGenerationOutcome,
} from '@/lib/server/forgewingRecoveryGenerationOutcomePersistence';

const databaseUrl = process.env.PHASE15_DATABASE_URL;
if (!databaseUrl) throw new Error('PHASE15_DATABASE_URL is required');

function literal(value: unknown): string {
  if (value == null) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(statement: string): unknown {
  const common = [
    '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--set=VERBOSITY=verbose',
    '-At', '--dbname', databaseUrl!,
  ];
  const output = process.platform === 'win32'
    ? execFileSync('wsl.exe', [
      '-u', 'root', '-e', '/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/bin/psql', ...common,
    ], { input: statement, encoding: 'utf8' })
    : execFileSync('psql', common, { input: statement, encoding: 'utf8' });
  const text = output.trim();
  return text.length === 0 ? null : JSON.parse(text);
}

const organizationId = 'a1000000-0000-4000-8000-000000000001';
const sourceDocumentId = 'a2000000-0000-4000-8000-000000000016';
const sourceArtifactId = 'a3000000-0000-4000-8000-000000000016';
runSql(`INSERT INTO public.documents(id, organization_id, name, storage_path)
  VALUES (${literal(sourceDocumentId)}::uuid, ${literal(organizationId)}::uuid,
    'phase15.pdf', 'phase15/phase15.pdf');
  INSERT INTO public.extraction_source_artifacts(
    id, organization_id, source_document_id, source_sha256, storage_object_version,
    media_type_sniffed, byte_length, storage_bucket, storage_path, identity_origin)
  VALUES (${literal(sourceArtifactId)}::uuid, ${literal(organizationId)}::uuid,
    ${literal(sourceDocumentId)}::uuid, repeat('f',64), 'phase15:1',
    'application/pdf', 1, 'documents', 'phase15/phase15.pdf', 'upload');
  SELECT NULL::json;`);

const admin = {
  async rpc(name: string, args: Record<string, unknown>) {
    if (name !== 'record_forgewing_recovery_generation_outcome') {
      return { data: null, error: { message: 'unexpected RPC' } };
    }
    try {
      const row = runSql(`SET ROLE service_role;
        SET request.jwt.claim.role='service_role';
        SELECT row_to_json(result) FROM public.record_forgewing_recovery_generation_outcome(
          ${literal(args.p_organization_id)}::uuid,
          ${literal(args.p_source_document_id)}::uuid,
          ${literal(args.p_source_artifact_id)}::uuid,
          ${literal(args.p_extraction_snapshot_id)},
          ${args.p_physical_page_number == null ? 'NULL' : Number(args.p_physical_page_number)},
          ${literal(args.p_page_representation_digest)},
          ${literal(args.p_diagnostic_id)},
          ${literal(args.p_recovery_type)},
          ${literal(args.p_outcome_code)},
          ${literal(args.p_sanitized_reason)},
          ${args.p_provider_invoked ? 'true' : 'false'},
          ${literal(JSON.stringify(args.p_candidate_ids))}::jsonb) AS result;`);
      return { data: row, error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : 'database error' } };
    }
  },
};

const outcome: RecoveryGenerationOutcome = {
  organizationId, sourceDocumentId, sourceArtifactId,
  extractionSnapshotId: 'phase15-snapshot', physicalPageNumber: 106,
  pageRepresentationDigest: '1'.repeat(64),
  recoveryType: 'priced_schedule_continuation_attribution',
  outcomeCode: 'provider_failed', sanitizedReason: 'provider_timeout',
  providerInvoked: true,
  candidateIds: [`recovery-candidate-v2-${'2'.repeat(64)}`],
};
const first = await persistForgewingRecoveryGenerationOutcome(outcome, { admin });
const replay = await persistForgewingRecoveryGenerationOutcome(outcome, { admin });
if (first.status !== 'persisted' || !first.inserted
  || replay.status !== 'persisted' || replay.inserted
  || first.outcomeRowId !== replay.outcomeRowId) {
  throw new Error('Phase 15 real RPC idempotency failed');
}

const diagnosticId = recoveryGenerationDiagnosticId(outcome);
runSql(`SET request.jwt.claim.role='service_role';
DO $$
DECLARE
  outcome_fn regprocedure := 'public.record_forgewing_recovery_generation_outcome(uuid,uuid,uuid,text,integer,text,text,text,text,text,boolean,jsonb)'::regprocedure;
  validator_fn regprocedure := 'public.is_valid_recovery_generation_candidate_ids(jsonb)'::regprocedure;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid='public.forgewing_recovery_generation_outcomes'::regclass) THEN
    RAISE EXCEPTION 'Phase 15 outcome RLS is disabled';
  END IF;
  IF has_function_privilege('anon', outcome_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', outcome_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', outcome_fn, 'EXECUTE')
     OR has_function_privilege('service_role', validator_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'Phase 15 function ACL mismatch';
  END IF;
  IF has_table_privilege('anon', 'public.forgewing_recovery_generation_outcomes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.forgewing_recovery_generation_outcomes', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.forgewing_recovery_generation_outcomes', 'SELECT')
     OR has_table_privilege('service_role', 'public.forgewing_recovery_generation_outcomes', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'Phase 15 table ACL mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc function
    JOIN pg_roles owner ON owner.oid=function.proowner
    WHERE function.oid=outcome_fn
      AND (NOT function.prosecdef OR owner.rolname <> 'postgres'
        OR function.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[])
  ) THEN RAISE EXCEPTION 'Phase 15 SECURITY DEFINER posture mismatch'; END IF;
  IF (SELECT count(*) FROM public.forgewing_recovery_generation_outcomes
      WHERE organization_id=${literal(organizationId)}::uuid
        AND diagnostic_id=${literal(diagnosticId)}) <> 1 THEN
    RAISE EXCEPTION 'Phase 15 outcome row missing or duplicated';
  END IF;

  BEGIN
    UPDATE public.forgewing_recovery_generation_outcomes SET sanitized_reason='provider_error'
    WHERE diagnostic_id=${literal(diagnosticId)};
    RAISE EXCEPTION 'Phase 15 update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  BEGIN
    DELETE FROM public.forgewing_recovery_generation_outcomes
    WHERE diagnostic_id=${literal(diagnosticId)};
    RAISE EXCEPTION 'Phase 15 delete unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  BEGIN
    PERFORM public.record_forgewing_recovery_generation_outcome(
      ${literal(organizationId)}::uuid, ${literal(sourceDocumentId)}::uuid,
      'a3000000-0000-4000-8000-000000000001'::uuid, 'phase15-snapshot', 106,
      repeat('1',64), repeat('3',64), 'priced_schedule_continuation_attribution',
      'provider_failed', 'provider_error', true, '[]'::jsonb);
    RAISE EXCEPTION 'Phase 15 foreign artifact unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL; END;
END $$;
SELECT NULL::json;`);

let unauthorizedFailed = false;
try {
  runSql(`SET request.jwt.claim.role='authenticated';
    SELECT public.record_forgewing_recovery_generation_outcome(
      ${literal(organizationId)}::uuid, ${literal(sourceDocumentId)}::uuid,
      ${literal(sourceArtifactId)}::uuid, 'phase15-snapshot', 106, repeat('1',64),
      repeat('4',64), 'priced_schedule_continuation_attribution',
      'provider_failed', 'provider_error', true, '[]'::jsonb);`);
} catch (error) {
  unauthorizedFailed = String(error).includes('42501');
}
if (!unauthorizedFailed) throw new Error('Phase 15 non-service RPC call did not raise 42501');

process.stdout.write('PHASE 15 RECOVERY GENERATION OUTCOME REAL POSTGRESQL QUALIFICATION: PASS\n');
