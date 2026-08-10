import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260810191912_harden_extraction_dependency_closure_invariant.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
const functionBody = sql.match(/AS \$\$([\s\S]*?)\$\$;/)?.[1] ?? '';

const closureTables = [
  'extraction_field_candidates',
  'extraction_verified_fields',
  'canonical_document_facts',
  'extraction_fragment_artifacts',
  'extraction_table_continuation_links',
  'extraction_table_chains',
  'extraction_table_sections',
  'extraction_arbitration_decisions',
  'semantic_column_mappings',
  'derived_document_facts',
] as const;

describe('dependency-closure security hardening migration', () => {
  it('installs one explicit trusted-owner SECURITY DEFINER function', () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION public\.check_extraction_dependency_closure\(\)/g))
      .toHaveLength(1);
    expect(sql).toMatch(/LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog/i);
    expect(sql).toContain(
      'ALTER FUNCTION public.check_extraction_dependency_closure() OWNER TO postgres;',
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.check_extraction_dependency_closure\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/i,
    );
  });

  it('contains the complete effective closure branch inventory', () => {
    for (const table of closureTables) {
      expect(sql).toContain(`TG_TABLE_NAME = '${table}'`);
    }
    expect(sql).toContain("NEW.decision IN ('conflict', 'unresolved')");
    expect(sql).toContain("NEW.kind NOT IN ('cell', 'region')");
  });

  it('uses only schema-qualified persistent relations and no dynamic reconstruction', () => {
    const relationReferences = [...functionBody.matchAll(
      /^\s*(?:FROM|JOIN)\s+([a-z_][a-z0-9_.]*)/gim,
    )]
      .map((match) => match[1]);
    expect(relationReferences.length).toBeGreaterThan(0);
    expect(relationReferences.every((relation) => relation.startsWith('public.'))).toBe(true);
    expect(functionBody).not.toMatch(
      /\bpg_proc\b|\bprosrc\b|\bEXECUTE\s+format\s*\(|\bformat\s*\(/i,
    );
  });

  it('preserves the established closure errors and deferred-trigger compatibility', () => {
    for (const message of [
      'verified field sources must exactly equal ordered candidate sources',
      'canonical fact requires exactly one coherent primary verified source',
      'canonical fact dependencies must be closed into the snapshot root',
      'partial or ambiguous table chains require an explicit gap',
      'arbitration decision has an invalid accepted-candidate partition',
      'semantic column mapping chain must belong to its extraction snapshot',
      'semantic column mapping fields must close to verified snapshot members',
      '% requires a non-empty valid dependency closure',
    ]) {
      expect(sql).toContain(message);
    }
    expect(sql).not.toMatch(/CREATE CONSTRAINT TRIGGER|DROP TRIGGER/i);
  });
});
