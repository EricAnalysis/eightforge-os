import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const PRODUCTION_ROOTS = ['app', 'components', 'lib', 'types'];
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const IMPORT_PATTERN =
  /(?:\bimport\s+(?:[^'"]*?\s+from\s+)?|\bexport\s+[^'"]*?\s+from\s+|\brequire\s*\(|\bimport\s*\()\s*['"]([^'"]+)['"]/g;
const FORBIDDEN_PRODUCTION_SEGMENTS = new Set([
  'test',
  'tests',
  '__tests__',
  'fixture',
  'fixtures',
  '__fixtures__',
  'script',
  'scripts',
  'sample',
  'samples',
  'training',
]);

type ImportEdge = {
  readonly source: string;
  readonly specifier: string;
};

const LEGACY_LAYER_EXCEPTIONS = new Set([
  'lib/extraction/xlsx/normalizeTransactionData.ts -> @/lib/validator/billingKeys',
]);

function walk(directory: string): string[] {
  if (!statSync(directory).isDirectory()) return [];
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') return [];
      return walk(absolute);
    }
    if (!SOURCE_EXTENSION.test(entry) || TEST_FILE.test(entry)) return [];
    return [absolute];
  });
}

function importsInFile(absolutePath: string): ImportEdge[] {
  const source = path.relative(ROOT, absolutePath).replaceAll('\\', '/');
  const text = readFileSync(absolutePath, 'utf8');
  return [...text.matchAll(IMPORT_PATTERN)].map((match) => ({
    source,
    specifier: match[1],
  }));
}

function allEdges(): ImportEdge[] {
  return PRODUCTION_ROOTS.flatMap((root) => walk(path.join(ROOT, root))).flatMap(importsInFile);
}

function specifierSegments(specifier: string): string[] {
  return specifier
    .replace(/^@\//, '')
    .split(/[\\/]/)
    .map((segment) => segment.toLowerCase());
}

function resolveImportTarget(edge: ImportEdge): string {
  const specifier = edge.specifier.replaceAll('\\', '/');
  if (specifier.startsWith('@/')) {
    return specifier.slice(2);
  }
  if (specifier.startsWith('.')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(edge.source), specifier));
  }
  return specifier;
}

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function isLayerViolation(edge: ImportEdge): boolean {
  const target = resolveImportTarget(edge);
  if (edge.source.startsWith('lib/extraction/')) {
    return isWithin(target, 'lib/validator')
      || isWithin(target, 'lib/interpretation')
      || isWithin(target, 'lib/contracts')
      || isWithin(target, 'lib/invoices');
  }
  if (edge.source.startsWith('lib/interpretation/')) {
    return isWithin(target, 'lib/validator')
      || isWithin(target, 'lib/extraction/pdf')
      || isWithin(target, 'lib/extraction/runtime')
      || isWithin(target, 'lib/extraction/persistence');
  }
  if (edge.source.startsWith('lib/validator/')) {
    return isWithin(target, 'lib/extraction/pdf')
      || isWithin(target, 'lib/extraction/runtime')
      || isWithin(target, 'lib/extraction/persistence')
      || isWithin(target, 'lib/pipeline/nodes');
  }
  return false;
}

describe('production architecture import boundaries', () => {
  it('forbids production imports from tests, fixtures, scripts, samples, and training data', () => {
    const violations = allEdges()
      .filter((edge) => specifierSegments(edge.specifier).some(
        (segment) => FORBIDDEN_PRODUCTION_SEGMENTS.has(segment),
      ))
      .map((edge) => `${edge.source} -> ${edge.specifier}`);
    expect(violations).toEqual([]);
  });

  it('enforces Extraction -> Interpretation -> Validation with frozen legacy exceptions', () => {
    const violations = allEdges()
      .filter(isLayerViolation)
      .map((edge) => `${edge.source} -> ${edge.specifier}`);
    const unexpected = violations.filter((edge) => !LEGACY_LAYER_EXCEPTIONS.has(edge));
    const missingFrozenException = [...LEGACY_LAYER_EXCEPTIONS].filter(
      (edge) => !violations.includes(edge),
    );
    expect({ unexpected, missingFrozenException }).toEqual({
      unexpected: [],
      missingFrozenException: [],
    });
  });

  it('rejects relative-import back-edge bypasses', () => {
    expect([
      {
        source: 'lib/extraction/domain/example.ts',
        specifier: '../../validator/example',
      },
      {
        source: 'lib/interpretation/example.ts',
        specifier: '../extraction/persistence/example',
      },
      {
        source: 'lib/validator/example.ts',
        specifier: '../extraction/runtime/example',
      },
      {
        source: 'lib/extraction/domain/example.ts',
        specifier: '@/lib/validator',
      },
      {
        source: 'lib/extraction/domain/example.ts',
        specifier: '..\\..\\validator',
      },
    ].map(isLayerViolation)).toEqual([true, true, true, true, true]);
  });
});
