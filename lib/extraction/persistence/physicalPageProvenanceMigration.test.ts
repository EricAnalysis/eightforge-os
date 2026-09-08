import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260812192944_phase1b_physical_page_provenance.sql',
);
const replayPath = path.join(process.cwd(), 'scripts/verify-step0-migration-replay.sh');
const md5 = (value: string): string => createHash('md5').update(value).digest('hex');
const normalizeReplaySql = (value: string): string => value.replaceAll('\r\n', '\n');

describe('Phase 1B physical-page provenance migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  it('is additive and leaves historical coordinates nullable', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS physical_page_coordinate jsonb');
    expect(sql).not.toMatch(/physical_page_coordinate jsonb\s+NOT NULL/i);
    expect(sql).not.toMatch(/UPDATE public\.extraction_(page|fragment)_artifacts/i);
    expect(sql).toContain("|| ')) NOT VALID'");
    expect(sql).toContain('VALIDATE CONSTRAINT %I');
    expect(sql).toContain('has an incompatible physical_page_coordinate column');
    expect(sql).toContain('has an incompatible physical-page constraint');
  });

  it('binds resolved coordinates to the persisted document, artifact, and page', () => {
    expect(sql).toContain("coordinate->>'sourceDocumentId' = expected_document_id::text");
    expect(sql).toContain("coordinate->>'sourceArtifactId' = expected_artifact_id::text");
    expect(sql).toContain("(coordinate->>'physicalPageNumber')::numeric = expected_page");
    expect(sql).toContain("coordinate->>'totalPhysicalPages'");
    expect(sql).toContain("coordinate->>'mappingBasis' = 'unproven'");
    expect(sql).toContain("coordinate->'physicalPageNumber' = 'null'::jsonb");
    expect(sql).toContain('coordinate IS NULL OR COALESCE((');
    expect(sql).toContain("coordinate ?& ARRAY[");
    expect(sql).toContain("jsonb_typeof(coordinate->'physicalPageNumber') = 'number'");
    expect(sql).toContain('<= 9007199254740991::numeric');
  });

  it('defines retry-safe insert and update enforcement', () => {
    expect(sql).toContain('is_valid_physical_page_coordinate has an incompatible definition');
    expect(sql).toContain('enforce_v2_physical_page_coordinate has an incompatible definition');
    expect(sql).toContain("p.proparallel = 'u'");
    expect(sql).toContain('NOT p.proisstrict');
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF');
    expect(sql).toContain(
      'organization_id, extraction_run_id, source_artifact_id, source_document_id, page, physical_page_coordinate',
    );
    expect(sql).toContain('has an incompatible definition');
    expect(sql).toContain('pg_catalog.pg_get_triggerdef');
  });

  it('replays migration function bodies with platform-invariant line endings', () => {
    const replay = fs.readFileSync(replayPath, 'utf8');
    const validator = sql.match(
      /CREATE OR REPLACE FUNCTION public\.is_valid_physical_page_coordinate[\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
    );
    const expectedHash = sql.match(
      /pg_catalog\.md5\(p\.prosrc\) = '([a-f0-9]{32})'/,
    );
    expect(validator).not.toBeNull();
    expect(expectedHash).not.toBeNull();
    expect(md5(normalizeReplaySql(validator![1]))).toBe(expectedHash![1]);
    expect(normalizeReplaySql('first\r\nembedded\rvalue\nlast\r')).toBe('first\nembedded\rvalue\nlast\r');
    expect(replay).toContain(
      "LC_ALL=C perl -0777 -pe 's/\\r\\n/\\n/g' -- \"${migration}\" > \"${normalized_migration}\"",
    );
    expect(replay).toContain(
      'migration_replay_root="$(mktemp -d -- "${migration_replay_parent}/eightforge-migration-replay.XXXXXX")"',
    );
    expect(replay).toContain('chmod 0711 -- "${migration_replay_root}"');
    expect(replay).toContain('chmod 0644 -- "${normalized_migration}"');
    expect(replay).toContain(
      'phase1b_migration="${migration_replay_root}/20260812192944_phase1b_physical_page_provenance.sql"',
    );
    expect(replay).not.toContain('sed -i');
  });

  it('replaces the reviewed publisher explicitly without prosrc surgery', () => {
    expect(sql).toContain("item->'physical_page_coordinate'");
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.publish_extraction_step1_shadow(payload jsonb)');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path TO ''");
    expect(sql).not.toContain('SELECT prosrc INTO function_body');
    expect(sql).not.toContain('replaced_body := replace');
    expect(sql).toContain('publish_extraction_step1_shadow has an incompatible definition');
    expect(sql).toContain("owner_role.rolname = 'postgres'");
    expect(sql).toContain("language_role.lanname = 'plpgsql'");
    expect(sql).toContain("p.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype");
    expect(sql).toContain('ALTER FUNCTION public.publish_extraction_step1_shadow(jsonb) OWNER TO postgres');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.publish_extraction_step1_shadow(jsonb)');
    expect(sql).toContain('TO service_role');
  });
});
