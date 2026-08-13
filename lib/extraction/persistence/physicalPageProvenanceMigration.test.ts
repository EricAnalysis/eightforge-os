import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260812192944_phase1b_physical_page_provenance.sql',
);

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
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF');
    expect(sql).toContain(
      'organization_id, extraction_run_id, source_artifact_id, source_document_id, page, physical_page_coordinate',
    );
    expect(sql).toContain('has an incompatible definition');
    expect(sql).toContain('pg_catalog.pg_get_triggerdef');
  });

  it('replaces the reviewed publisher explicitly without prosrc surgery', () => {
    expect(sql).toContain("item->'physical_page_coordinate'");
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.publish_extraction_step1_shadow(payload jsonb)');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path TO ''");
    expect(sql).not.toContain('SELECT prosrc INTO function_body');
    expect(sql).not.toContain('replaced_body := replace');
    expect(sql).toContain('unrecognized publish_extraction_step1_shadow definition');
    expect(sql).toContain('ALTER FUNCTION public.publish_extraction_step1_shadow(jsonb) OWNER TO postgres');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.publish_extraction_step1_shadow(jsonb)');
    expect(sql).toContain('TO service_role');
  });
});
