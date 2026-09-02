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

describe('queue projection reads live assessment metrics', () => {
  const QUEUE = path.join(
    process.cwd(), 'supabase', 'migrations',
    '20260904000300_review_queue_terminology.sql',
  );

  // The queue previously read automationAssessment.deterministicCandidateSteps,
  // a property renamed when trusted qualification was removed. The SQL kept
  // compiling and silently returned 0 for every row, so a rename verified only
  // in TypeScript is not verified at all.
  it('reads only metric properties the task actually emits', () => {
    const sql = readFileSync(QUEUE, 'utf8');
    const referenced = [...sql.matchAll(/automationAssessment'->>'([A-Za-z]+)'/g)]
      .map((match) => match[1]!);
    expect(referenced.length).toBeGreaterThan(0);

    const task = readFileSync(
      path.join(process.cwd(), 'lib', 'forgewing', 'tasks', 'workflowAssessment.ts'),
      'utf8',
    );
    for (const property of referenced) {
      // Each referenced property must appear as a field of the emitted metrics.
      expect(task).toContain(`${property}:`);
    }
  });

  it('no longer names a trusted-qualification metric anywhere', () => {
    const sql = readFileSync(QUEUE, 'utf8');
    // Comments explain the removed name; the SQL body must not use it.
    const body = sql.replace(/^\s*--.*$/gm, ' ');
    expect(body).not.toContain('deterministicCandidateSteps');
    expect(body).not.toContain('qualified_deterministic_count');
  });
});

describe('reviewed specification structural validation', () => {
  const STRUCTURAL = path.join(
    process.cwd(), 'supabase', 'migrations',
    '20260904000400_reviewed_specification_structural_validation.sql',
  );

  it('declares a JSON type for every field the schemas define', () => {
    const sql = readFileSync(STRUCTURAL, 'utf8');
    const declared = new Set(
      [...sql.matchAll(/WHEN '([A-Za-z]+)' THEN '(?:string|boolean|string_array)'/g)]
        .map((match) => match[1]!),
    );
    for (const fields of Object.values(REVIEWED_SPECIFICATION_FIELDS)) {
      for (const field of fields) {
        expect(declared).toContain(field.name);
      }
    }
  });

  it('maps list fields to string arrays and booleans to boolean', () => {
    const sql = readFileSync(STRUCTURAL, 'utf8');
    for (const fields of Object.values(REVIEWED_SPECIFICATION_FIELDS)) {
      for (const field of fields) {
        if (field.kind === 'list') {
          expect(sql).toContain(`WHEN '${field.name}' THEN 'string_array'`);
        }
        if (field.kind === 'boolean') {
          expect(sql).toContain(`WHEN '${field.name}' THEN 'boolean'`);
        }
      }
    }
  });

  it('rejects executable-shaped keys recursively, not just at the top level', () => {
    const sql = readFileSync(STRUCTURAL, 'utf8');
    // Nesting was the obvious way around a top-level check.
    expect(sql).toMatch(/workflow_specification_has_executable_key\("p_value" -> v_key\)/);
    expect(sql).toMatch(/workflow_specification_has_executable_key\(v_child\)/);
    expect(sql).toContain('jsonb_array_elements');
  });

  it('refuses a non-object specification instead of normalizing it to NULL', () => {
    const sql = readFileSync(STRUCTURAL, 'utf8');
    expect(sql).toMatch(/jsonb_typeof\("p_specification"\) <> 'object'/);
    // The old CASE that silently turned a scalar into NULL must be gone.
    expect(sql).not.toMatch(/THEN "p_specification" ELSE NULL END/);
  });

  it('stays structural and does not encode business meaning', () => {
    const sql = readFileSync(STRUCTURAL, 'utf8').toLowerCase();
    // No semantic vocabulary: SQL must not judge whether a rule reads sensibly.
    for (const semantic of ['deterministic_enough', 'reasonable', 'quality', 'similar']) {
      expect(sql).not.toContain(semantic);
    }
  });
});
