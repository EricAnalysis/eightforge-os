import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards against fixture-identifying literals leaking into production code.
 *
 * Runtime behavior must derive from persisted document/artifact state, never
 * from advance knowledge of a specific contract. A hardcoded document id,
 * project id, or source SHA-256 in a production path is the clearest
 * machine-detectable form of that mistake.
 *
 * Deliberate limits, so this guard is not mistaken for full coverage:
 *  - Project/document *names* are ordinary English words and cannot be banned
 *    generically without encoding the very fixture identities being guarded.
 *  - Page numbers and page counts are legitimate integers elsewhere (budgets,
 *    limits, offsets), so a numeric scan would be noise rather than signal.
 * Those remain a review responsibility. This checks only the unambiguous cases.
 */

const ROOT = process.cwd();
const PRODUCTION_ROOTS = ['app', 'components', 'lib', 'types'];
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Directory segments whose contents are fixture-bound by design and therefore
 * outside the production surface — mirroring the existing import-boundary
 * doctrine that treats evaluation and fixture trees as non-production.
 */
const NON_PRODUCTION_SEGMENTS = new Set([
  '__fixtures__',
  '__tests__',
  'fixtures',
  'evaluation',
]);

const UUID_LITERAL =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const SHA256_LITERAL = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;
const SENTINEL_UUIDS = new Set([
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000000000',
]);

/** Nil / all-zero sentinels are deterministic placeholders, not identities. */
function isSentinelUuid(literal: string): boolean {
  return SENTINEL_UUIDS.has(literal.toLowerCase());
}

function walk(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const absolute = path.join(directory, entry);
    let isDirectory = false;
    try {
      isDirectory = statSync(absolute).isDirectory();
    } catch {
      return [];
    }
    if (isDirectory) {
      if (NON_PRODUCTION_SEGMENTS.has(entry)) return [];
      return walk(absolute);
    }
    return [absolute];
  });
}

function productionSourceFiles(): string[] {
  return PRODUCTION_ROOTS
    .flatMap((root) => walk(path.join(ROOT, root)))
    .filter((file) => SOURCE_EXTENSION.test(file) && !TEST_FILE.test(file));
}

function findLiterals(pattern: RegExp, allow: (literal: string) => boolean): string[] {
  const offenders: string[] = [];
  for (const file of productionSourceFiles()) {
    let contents: string;
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of contents.match(pattern) ?? []) {
      if (allow(match)) continue;
      offenders.push(`${path.relative(ROOT, file)}: ${match}`);
    }
  }
  return offenders.sort((left, right) => left.localeCompare(right, 'en-US'));
}

describe('fixture literal guard', () => {
  it('finds no hardcoded document or project ids in production code', () => {
    expect(findLiterals(UUID_LITERAL, isSentinelUuid)).toEqual([]);
  });

  it('finds no hardcoded source SHA-256 values in production code', () => {
    expect(findLiterals(SHA256_LITERAL, () => false)).toEqual([]);
  });

  it('scans a non-trivial production surface', () => {
    // Guards the guard: a path or extension mistake would silently pass above.
    expect(productionSourceFiles().length).toBeGreaterThan(50);
  });

  it('recognises sentinel uuids without whitelisting real identities', () => {
    expect(isSentinelUuid('00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(isSentinelUuid('00000000-0000-4000-8000-000000000048')).toBe(false);
    expect(isSentinelUuid('18550bfc-c057-4aae-bfa3-db896e36edb0')).toBe(false);
  });
});
