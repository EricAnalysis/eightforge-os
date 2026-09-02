import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REVIEWED_SPECIFICATION_FIELDS,
  REVIEWED_SPECIFICATION_SCHEMAS,
  type ReviewedClassification,
} from '@/lib/workflowReviewedSpecification';

// The database enforces which keys a reviewed specification may and must have.
// That is deliberately a key-set closure rather than a second copy of the Zod
// contract -- value validation stays in one place -- but the key sets
// themselves exist twice, so they are pinned here. A field added to the
// TypeScript schema without the migration would otherwise be silently rejected
// by the database at write time.
const MIGRATION = path.join(
  process.cwd(), 'supabase', 'migrations',
  '20260903000000_reviewed_specification_db_validation.sql',
);

function sqlArraysFor(classification: string): { required: string[]; allowed: string[] } {
  const sql = readFileSync(MIGRATION, 'utf8');
  // Two CASE blocks in order: required first, then allowed.
  const blocks = sql.split("WHEN '" + classification + "' THEN ARRAY[");
  expect(blocks.length).toBeGreaterThanOrEqual(3);
  const parse = (fragment: string): string[] => {
    const body = fragment.slice(0, fragment.indexOf(']'));
    return body.split(',').map((entry) => entry.trim().replace(/^'|'$/g, ''))
      .filter(Boolean).sort();
  };
  return { required: parse(blocks[1]!), allowed: parse(blocks[2]!) };
}

describe('reviewed specification SQL key parity', () => {
  const classifications = Object.keys(
    REVIEWED_SPECIFICATION_SCHEMAS,
  ) as ReviewedClassification[];

  it.each(classifications)('%s allowed keys match the TypeScript schema', (classification) => {
    const schemaKeys = Object.keys(
      REVIEWED_SPECIFICATION_SCHEMAS[classification].shape,
    ).sort();
    expect(sqlArraysFor(classification).allowed).toEqual(schemaKeys);
  });

  it.each(classifications)('%s required keys are the non-optional fields', (classification) => {
    const required = REVIEWED_SPECIFICATION_FIELDS[classification]
      .filter((field) => !field.optional)
      .map((field) => field.name)
      .sort();
    expect(sqlArraysFor(classification).required).toEqual(required);
  });

  it('forbids the same executable-shaped keys the contract omits', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    for (const key of [
      'code', 'sql', 'query', 'expression', 'script',
      'command', 'runtime', 'deploy', 'executable',
    ]) {
      expect(sql).toContain(`'${key}'`);
    }
  });

  it('keeps the write function security properties intact', () => {
    const replacement = readFileSync(path.join(
      process.cwd(), 'supabase', 'migrations',
      '20260903000100_review_function_specification_closure.sql',
    ), 'utf8');
    expect(replacement).toContain('SECURITY DEFINER');
    expect(replacement).toContain('SET search_path = public, pg_temp');
    expect(replacement).toContain('OWNER TO "postgres"');
    expect(replacement).toContain('TO "service_role"');
    // No table DML grants may appear in a function-only migration.
    expect(replacement).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL) ON TABLE/);
    // The assertion must run before anything is written.
    const assertAt = replacement.indexOf('assert_workflow_reviewed_specification');
    const insertAt = replacement.indexOf('INSERT INTO public.workflow_assessment_reviews');
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(insertAt);
  });
});
