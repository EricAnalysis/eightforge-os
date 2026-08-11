import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260811160000_p2_immutable_source_artifact_ingestion.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
const replayScript = readFileSync(
  path.join(process.cwd(), 'scripts', 'verify-step0-migration-replay.sh'),
  'utf8',
);
const functionBody = sql.match(
  /CREATE OR REPLACE FUNCTION public\.record_extraction_source_artifact_identity\(payload jsonb\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
)?.[1] ?? '';

describe('P2 immutable source artifact ingestion migration', () => {
  it('adds legacy-safe provenance and one-hash-per-document-version protection', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS storage_bucket text/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS storage_path text/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS identity_origin text/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_extraction_source_artifacts_document_version[\s\S]*organization_id,[\s\S]*source_document_id,[\s\S]*storage_object_version/i,
    );
    expect(sql).toContain('conflict_count bigint');
    expect(sql).toContain('representative_organization_id uuid');
    expect(sql).toContain('representative_source_document_id uuid');
    expect(sql).toContain('representative_storage_object_version text');
    expect(sql).toMatch(/HAVING count\(\*\) > 1[\s\S]*ORDER BY[\s\S]*organization_id,[\s\S]*source_document_id,[\s\S]*storage_object_version[\s\S]*LIMIT 1/i);
    expect(sql).toContain('conflict_count=%s, organization_id=%s, source_document_id=%s, storage_object_version=%s');
    expect(sql).not.toMatch(/ALTER COLUMN (?:storage_bucket|storage_path|identity_origin) SET NOT NULL/i);
  });

  it('installs a service-role-only hardened recorder', () => {
    expect(sql).toMatch(
      /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = ''/i,
    );
    expect(sql).toContain(
      'ALTER FUNCTION public.record_extraction_source_artifact_identity(jsonb) OWNER TO postgres;',
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_extraction_source_artifact_identity\(jsonb\)\s+FROM PUBLIC, anon, authenticated;/i,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.record_extraction_source_artifact_identity\(jsonb\)\s+TO service_role;/i,
    );
    expect(functionBody).toContain("IF auth.role() <> 'service_role'");
    expect(functionBody).toMatch(/FROM public\.documents/);
    expect(functionBody).toMatch(/FROM public\.extraction_source_artifacts/);
    expect(functionBody).not.toMatch(/\bFROM documents\b|\bFROM extraction_source_artifacts\b/);
  });

  it('serializes retries without hashing the conflict out of the lock key', () => {
    const lockExpression = functionBody.match(
      /pg_advisory_xact_lock\(hashtextextended\(([\s\S]*?),\s*0\s*\)\)/,
    )?.[1] ?? '';
    expect(lockExpression).toContain('object_version');
    expect(lockExpression).not.toContain('source_sha');
    expect(functionBody).toContain("outcome text := 'newly_populated'");
    expect(functionBody).toContain("outcome := 'already_populated'");
    expect(functionBody).toContain("RAISE EXCEPTION 'immutable source artifact identity conflict'");
    expect(functionBody).toMatch(
      /source_row\.storage_bucket IS NOT NULL[\s\S]*source_row\.storage_bucket <> object_bucket/,
    );
    expect(functionBody).toMatch(
      /source_row\.storage_path IS NOT NULL[\s\S]*source_row\.storage_path <> object_path/,
    );
  });

  it('executes retry, privilege, and conflicting-hash fixtures during fresh replay', () => {
    expect(replayScript).toContain('P2 immutable source identity retry did not converge');
    expect(replayScript).toContain('P2 source identity recorder leaked execute privilege');
    expect(replayScript).toContain('DATABASE P2 IMMUTABLE SOURCE IDENTITY CONFLICT: FAILED');
    expect(replayScript).toContain('DATABASE P2 IMMUTABLE SOURCE IDENTITY / RETRY / CONFLICT: PASS');
  });
});
