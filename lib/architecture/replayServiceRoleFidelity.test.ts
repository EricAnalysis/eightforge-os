import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the migration-replay harness against regressing to a `service_role`
 * that does not bypass RLS.
 *
 * Hosted Supabase creates `service_role` with BYPASSRLS. The extraction
 * dependency-closure invariant is enforced by SECURITY INVOKER constraint
 * triggers that are DEFERRABLE INITIALLY DEFERRED, so they fire at COMMIT —
 * outside the SECURITY DEFINER publisher that queued them — and evaluate as the
 * session role. When the replay stub creates `service_role` without BYPASSRLS,
 * the RLS SELECT policies (granted TO authenticated only) hide the closure rows
 * the invariant counts, and the check fails against physically valid data.
 *
 * This is a static guard on the real replay sources. It is not a substitute for
 * the Fresh Postgres replay, which remains the runtime acceptance gate.
 */

const ROOT = process.cwd();
const REPLAY_SOURCE_DIRECTORIES = ['.github/workflows', 'scripts'];
const SERVICE_ROLE_CREATE = /CREATE\s+ROLE\s+service_role\b[^;]*/gi;
const SERVICE_ROLE_ALTER = /ALTER\s+ROLE\s+service_role\b[^;]*/gi;

function collectFiles(directory: string): string[] {
  const absolute = path.join(ROOT, directory);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(absolute, entry);
    if (statSync(full).isDirectory()) {
      return collectFiles(path.join(directory, entry));
    }
    return [path.join(directory, entry)];
  });
}

function replayFilesDefiningServiceRole(): { file: string; contents: string }[] {
  return REPLAY_SOURCE_DIRECTORIES
    .flatMap((directory) => collectFiles(directory))
    .map((file) => ({ file, contents: readFileSync(path.join(ROOT, file), 'utf8') }))
    .filter(({ contents }) => /CREATE\s+ROLE\s+service_role\b/i.test(contents));
}

describe('migration replay service_role fidelity', () => {
  it('finds the replay harness files that define service_role', () => {
    const files = replayFilesDefiningServiceRole().map(({ file }) => file.replace(/\\/g, '/'));

    // Fails loudly if the harness moves, so the guard can never pass vacuously
    // by scanning nothing.
    expect(files).toContain('.github/workflows/migration-fresh-replay.yml');
    expect(files).toContain('scripts/verify-step0-migration-replay.sh');
  });

  it('creates service_role with BYPASSRLS everywhere the replay defines it', () => {
    const offenders: string[] = [];

    for (const { file, contents } of replayFilesDefiningServiceRole()) {
      for (const statement of contents.match(SERVICE_ROLE_CREATE) ?? []) {
        if (!/\bBYPASSRLS\b/i.test(statement)) {
          offenders.push(`${file.replace(/\\/g, '/')}: ${statement.trim()}`);
        }
      }
    }

    expect(offenders, [
      'Replay service_role must be created with BYPASSRLS to match hosted Supabase.',
      'Without it, deferred SECURITY INVOKER closure triggers evaluate under RLS',
      'and the extraction dependency-closure invariant fails against valid data.',
    ].join(' ')).toEqual([]);
  });

  it('never downgrades service_role away from BYPASSRLS on the already-exists path', () => {
    const offenders: string[] = [];

    for (const { file, contents } of replayFilesDefiningServiceRole()) {
      for (const statement of contents.match(SERVICE_ROLE_ALTER) ?? []) {
        if (/\bNOBYPASSRLS\b/i.test(statement)) {
          offenders.push(`${file.replace(/\\/g, '/')}: ${statement.trim()}`);
        }
      }
      // An idempotent stub that swallows duplicate_object without reasserting
      // BYPASSRLS leaves a pre-existing plain role unfixed.
      const hasIdempotentGuard = /duplicate_object/i.test(contents);
      if (hasIdempotentGuard && !/ALTER\s+ROLE\s+service_role\b[^;]*BYPASSRLS/i.test(contents)) {
        offenders.push(
          `${file.replace(/\\/g, '/')}: duplicate_object path does not reassert BYPASSRLS`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
