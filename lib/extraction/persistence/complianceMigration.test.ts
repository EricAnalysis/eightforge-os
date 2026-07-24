import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Static source-shape checks only. PostgreSQL execution and replay invariants
// are verified by scripts/verify-step0-migration-replay.sh.
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
  'extraction_fragment_dependencies',
  'extraction_field_candidates',
  'extraction_field_candidate_sources',
  'extraction_verified_fields',
  'extraction_verified_field_sources',
  'extraction_processing_gaps',
  'extraction_gap_sources',
  'extraction_snapshots',
  'extraction_snapshot_members',
  'canonical_document_facts',
  'canonical_document_fact_sources',
  'derived_document_facts',
  'derived_document_fact_dependencies',
  'human_fact_assertions',
  'document_interpretation_snapshots',
  'document_interpretation_records',
  'entity_resolution_runs',
  'entity_resolutions',
  'extraction_snapshot_invalidations',
  'extraction_replay_requests',
  'document_projection_stamps',
] as const;

const mutableTables = ['document_extraction_snapshot_assignments'] as const;
const allTables = [...immutableTables, ...mutableTables] as const;

describe('Step 0 compliance migration static source contract', () => {
  it('creates exactly the required organization-scoped table inventory', () => {
    const createdTables = [...sql.matchAll(
      /CREATE TABLE IF NOT EXISTS public\.([a-z_]+)/g,
    )].map((match) => match[1]);
    expect(createdTables.sort()).toEqual([...allTables].sort());

    for (const table of allTables) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
      expect(sql).toMatch(new RegExp(
        `CREATE TABLE IF NOT EXISTS public\\.${table} \\([\\s\\S]*?organization_id uuid NOT NULL`,
      ));
    }
    for (const table of immutableTables) {
      expect(sql).toContain(`'${table}'`);
    }
  });

  it('keeps every ledger append-only and excludes only the current assignment pointer', () => {
    const appendOnlyBlock = sql.match(
      /-- All immutable records[\s\S]*?END;\r?\n\$\$;/,
    )?.[0];
    expect(appendOnlyBlock).toBeDefined();
    for (const table of immutableTables) {
      expect(appendOnlyBlock).toContain(`'${table}'`);
    }
    for (const table of mutableTables) {
      expect(appendOnlyBlock).not.toContain(`'${table}'`);
    }
    expect(appendOnlyBlock).toContain('BEFORE UPDATE OR DELETE');
  });

  it('uses restrictive dependency FKs, RLS, and explicit grant declarations', () => {
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('GRANT SELECT ON TABLE');
    expect(sql).toContain('REVOKE ALL ON TABLE');
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
