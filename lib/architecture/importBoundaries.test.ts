import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';

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
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
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

function moduleSpecifiers(text: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const record = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0]!)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
    ) {
      specifiers.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, record);
  };
  record(sourceFile);
  return specifiers;
}

function importsInFile(absolutePath: string, workspaceRoot = ROOT): ImportEdge[] {
  const source = path.relative(workspaceRoot, absolutePath).replaceAll('\\', '/');
  const text = readFileSync(absolutePath, 'utf8');
  return moduleSpecifiers(text, absolutePath).map((specifier) => ({
    source,
    specifier,
  }));
}

function importsInFileFast(absolutePath: string, workspaceRoot = ROOT): ImportEdge[] {
  const source = path.relative(workspaceRoot, absolutePath).replaceAll('\\', '/');
  const text = readFileSync(absolutePath, 'utf8');
  return [...text.matchAll(IMPORT_PATTERN)].map((match) => ({ source, specifier: match[1]! }));
}

let productionEdges: ImportEdge[] | null = null;

function allEdges(): ImportEdge[] {
  productionEdges ??= PRODUCTION_ROOTS
    .flatMap((root) => walk(path.join(ROOT, root)))
    .flatMap((file) => importsInFileFast(file));
  return productionEdges;
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

function productionReaderFiles(workspaceRoot: string, roots = ['app', 'components', 'lib']): string[] {
  const excludedRoots = new Set(['lib/canonical', 'lib/evaluation']);
  const visit = (directory: string): string[] => {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
    const relativeDirectory = path.relative(workspaceRoot, directory).replaceAll('\\', '/');
    if (excludedRoots.has(relativeDirectory)) return [];
    return readdirSync(directory).flatMap((entry) => {
      const absolute = path.join(directory, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) return visit(absolute);
      if (!SOURCE_EXTENSION.test(entry) || TEST_FILE.test(entry)) return [];
      return [absolute];
    });
  };
  return roots.flatMap((root) => visit(path.join(workspaceRoot, root)));
}

function canonicalProjectReaderCutovers(
  workspaceRoot: string,
  roots = ['app', 'components', 'lib'],
): string[] {
  return productionReaderFiles(workspaceRoot, roots)
    .flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return /canonical[\\/]project[\\/]/.test(text)
        ? importsInFile(file, workspaceRoot)
        : [];
    })
    .filter((edge) => isWithin(resolveImportTarget(edge), 'lib/canonical/project'))
    .map((edge) => `${edge.source} -> ${edge.specifier}`)
    .sort();
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
  }, 30_000);

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

  it('has no production reader cutover to the shadow Project Truth registry', () => {
    expect(canonicalProjectReaderCutovers(ROOT)).toEqual([]);
  }, 30_000);
});

describe('shadow Project Truth reader-cutover guard', () => {
  const temporaryRoots: string[] = [];
  const fixtureRoot = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'eightforge-reader-guard-'));
    temporaryRoots.push(root);
    return root;
  };
  const source = (root: string, relativePath: string, contents: string): void => {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('catches alias imports', () => {
    const root = fixtureRoot();
    source(root, 'app/reader.ts', "import { buildCanonicalProjectTruth } from '@/lib/canonical/project/projectTruthBuilder';");
    expect(canonicalProjectReaderCutovers(root)).toEqual([
      "app/reader.ts -> @/lib/canonical/project/projectTruthBuilder",
    ]);
  });

  it('catches relative, static require, and dynamic import forms', () => {
    const root = fixtureRoot();
    source(root, 'lib/consumers/relative.ts', "import type { CanonicalProjectTruth } from '../canonical/project/projectTruth';");
    source(root, 'components/required.ts', "const truth = require('../lib/canonical/project/projectTruth');");
    source(root, 'app/dynamic.ts', "const truth = import('../lib/canonical/project/projectTruthBuilder');");
    expect(canonicalProjectReaderCutovers(root)).toEqual([
      "app/dynamic.ts -> ../lib/canonical/project/projectTruthBuilder",
      "components/required.ts -> ../lib/canonical/project/projectTruth",
      "lib/consumers/relative.ts -> ../canonical/project/projectTruth",
    ]);
  });

  it('inspects nested directories named canonical outside lib/canonical', () => {
    const root = fixtureRoot();
    source(root, 'components/feature/canonical/reader.ts', "export { buildCanonicalProjectTruth } from '@/lib/canonical/project/projectTruthBuilder';");
    expect(canonicalProjectReaderCutovers(root)).toEqual([
      "components/feature/canonical/reader.ts -> @/lib/canonical/project/projectTruthBuilder",
    ]);
  });

  it('does not throw when an optional scan root is missing', () => {
    const root = fixtureRoot();
    expect(canonicalProjectReaderCutovers(root, ['missing-root'])).toEqual([]);
  });

  it('permits canonical, evaluation, and test-only imports', () => {
    const root = fixtureRoot();
    source(root, 'lib/canonical/internal.ts', "import type { CanonicalProjectTruth } from './project/projectTruth';");
    source(root, 'lib/evaluation/proof.ts', "import { buildCanonicalProjectTruth } from '../canonical/project/projectTruthBuilder';");
    source(root, 'app/reader.test.ts', "import { buildCanonicalProjectTruth } from '@/lib/canonical/project/projectTruthBuilder';");
    expect(canonicalProjectReaderCutovers(root)).toEqual([]);
  });
});
