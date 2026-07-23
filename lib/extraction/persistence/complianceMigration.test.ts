import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260723163517_phase3_step0_compliance_foundation.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

const immutableTables = [
  'extraction_source_artifacts',
  'extraction_runs',
  'extraction_run_states',
  'extraction_page_artifacts',
  'extraction_fragment_artifacts',
  'extraction_field_candidates',
  'extraction_verified_fields',
  'extraction_processing_gaps',
  'extraction_snapshots',
  'canonical_document_facts',
  'derived_document_facts',
  'human_fact_assertions',
  'document_interpretation_snapshots',
  'entity_resolution_runs',
  'entity_resolutions',
  'document_projection_stamps',
] as const;

describe('Step 0 compliance migration contract', () => {
  it('creates every required immutable organization-scoped ledger', () => {
    for (const table of immutableTables) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
      expect(sql).toMatch(new RegExp(
        `CREATE TABLE IF NOT EXISTS public\\.${table} \\([\\s\\S]*?organization_id uuid NOT NULL`,
      ));
      expect(sql).toContain(`'${table}'`);
    }
  });

  it('uses restrictive dependency FKs, RLS, service grants, and append-only enforcement', () => {
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('GRANT SELECT ON TABLE');
    expect(sql).toContain('GRANT SELECT ON TABLE');
    expect(sql).not.toContain('GRANT ALL ON TABLE');
    expect(sql).toContain('public.get_current_user_org_id()');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
  });

  it('contains exact idempotency and semantic snapshot uniqueness gates', () => {
    expect(sql).toContain('extraction_runs_idempotency_unique');
    expect(sql).toContain('extraction_runs_attempt_unique');
    expect(sql).toContain('extraction_snapshots_semantic_unique');
    expect(sql).toContain('document_interpretation_snapshots_identity_unique');
    expect(sql).toContain('document_projection_stamps_projection_unique');
    expect(sql).toContain('publish_extraction_compliance_shadow(payload jsonb)');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('canonical fact must equal its primary verified field');
    expect(sql).toContain('snapshot member must belong to the snapshot producing run');
    expect(sql).toContain('projection stamp must close to one source/extraction/interpretation chain');
  });
});
