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

const CANONICAL_PRODUCTION_EDGES = new Set([
  'lib/validator/triggerProjectValidation.ts -> @/lib/canonical/publication/publishProjectTruthShadow',
  // ── Authority cutover (amendment A13) ──
  // Validation may now depend on the canonical tree for AUTHORITY, not merely
  // for publication. These edges are the deliberate consequence of promoting
  // the canonical registry to selectable runtime truth; the seal stays narrow
  // so no further validator -> canonical edge can appear unreviewed.
  'lib/validator/projectValidator.ts -> @/lib/canonical/authority/resolveProjectTruthAuthority',
  'lib/validator/projectValidator.ts -> @/lib/canonical/authority/canonicalExecutionContext',
  // Transaction authority reroute: the validator projects canonical transactions
  // into the existing row interface at the seam. Rule packs read that projection
  // off their input and import nothing from lib/canonical themselves.
  'lib/validator/projectValidator.ts -> @/lib/canonical/authority/canonicalValidatorProjection',
  'lib/validator/projectValidator.ts -> @/lib/canonical/publication/projectTruthPublicationIdentity',
  'lib/validator/shared.ts -> @/lib/canonical/authority/canonicalExecutionContext',
  // Authority metadata is persisted with every run and threaded from the
  // execution context rather than recomputed downstream.
  'lib/validator/persistValidationRun.ts -> @/lib/canonical/authority/canonicalExecutionContext',
  'lib/validator/triggerProjectValidation.ts -> @/lib/canonical/authority/canonicalExecutionContext',
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

function canonicalProductionEdges(): string[] {
  return allEdges()
    .filter((edge) => (
      !edge.source.startsWith('lib/canonical/')
      && !edge.source.startsWith('lib/evaluation/')
      && isWithin(resolveImportTarget(edge), 'lib/canonical')
    ))
    .map((edge) => `${edge.source} -> ${edge.specifier}`)
    .sort();
}

function publicationImportViolations(workspaceRoot = ROOT): string[] {
  const publicationRoot = path.join(workspaceRoot, 'lib/canonical/publication');
  return walk(publicationRoot)
    .flatMap((file) => importsInFile(file, workspaceRoot))
    .filter((edge) => {
      const target = resolveImportTarget(edge);
      return target === 'lib/projectFacts'
        || isWithin(target, 'lib/evaluation')
        || isWithin(target, 'lib/execution')
        || isWithin(target, 'lib/decisions')
        || target.startsWith('lib/server/approval')
        || target.startsWith('lib/server/decision')
        || target === 'lib/server/executionQueue'
        || target === 'lib/validator/persistValidationRun'
        || target === 'lib/validator/approvalGate'
        || isWithin(target, 'components')
        || isWithin(target, 'app');
    })
    .map((edge) => `${edge.source} -> ${edge.specifier}`)
    .sort();
}

function publicationTypeReverseDependencies(): string[] {
  return allEdges()
    .filter((edge) => !edge.source.startsWith('lib/canonical/publication/'))
    .filter((edge) => (
      resolveImportTarget(edge) === 'lib/canonical/publication/projectTruthPublication'
    ))
    .map((edge) => `${edge.source} -> ${edge.specifier}`)
    .sort();
}

function publicationRuntimeAuthorityViolations(workspaceRoot = ROOT): string[] {
  const publicationRoot = path.join(workspaceRoot, 'lib/canonical/publication');
  return walk(publicationRoot).flatMap((file) => {
    const source = path.relative(workspaceRoot, file).replaceAll('\\', '/');
    const text = readFileSync(file, 'utf8');
    const violations: string[] = [];
    if (/\.from\s*\(\s*['"](?:documents|extraction_source_artifacts)['"]\s*\)/.test(text)) {
      violations.push(`${source} -> forbidden mutable source read`);
    }
    if (/\b(?:createBucket|create_bucket)\b/.test(text)) {
      violations.push(`${source} -> forbidden bucket provisioning`);
    }
    if (/\b(?:assembleContractPricingRows|assembleContractPricingRowsWithCandidates)\b/.test(text)) {
      violations.push(`${source} -> forbidden pricing reassembly`);
    }
    if (/\b(?:ContractPricingAssemblyResult|ContractPricingSourceRowIdentity|candidatesBySourceRow)\b/.test(text)) {
      violations.push(`${source} -> forbidden pricing candidate dependency`);
    }
    return violations;
  }).sort();
}

/**
 * Rule packs must never rediscover which authority produced their input.
 *
 * A pack that read the authority mode, the environment variable, or reached
 * into `lib/canonical` would reintroduce per-pack truth decisions — the exact
 * failure the single-projection seam exists to prevent. Packs receive already
 * normalized inputs and stay unaware of the authority behind them.
 */
function rulePackAuthorityViolations(workspaceRoot = ROOT): string[] {
  const packRoot = path.join(workspaceRoot, 'lib/validator/rulePacks');
  if (!existsSync(packRoot)) return [];
  return walk(packRoot)
    .filter((file) => !file.endsWith('.test.ts'))
    .flatMap((file) => {
      const source = path.relative(workspaceRoot, file).replaceAll('\\', '/');
      const text = readFileSync(file, 'utf8');
      const violations: string[] = [];
      if (/EIGHTFORGE_PROJECT_TRUTH_AUTHORITY|readProjectTruthAuthorityMode|resolveProjectTruthAuthorityMode/.test(text)) {
        violations.push(`${source} -> rule pack reads authority configuration`);
      }
      if (/process\.env/.test(text)) {
        violations.push(`${source} -> rule pack parses the environment`);
      }
      for (const edge of importsInFile(file, workspaceRoot)) {
        if (isWithin(resolveImportTarget(edge), 'lib/canonical')) {
          violations.push(`${source} -> rule pack imports ${edge.specifier}`);
        }
      }
      return violations;
    })
    .sort();
}

/**
 * There is exactly one canonical-to-validator projection module.
 *
 * A second projection would let canonical truth reach the validator by two
 * mappings that could drift apart, which is the per-pack divergence the A13
 * cutover forbids.
 */
function canonicalProjectionModules(workspaceRoot = ROOT): string[] {
  const authorityRoot = path.join(workspaceRoot, 'lib/canonical/authority');
  if (!existsSync(authorityRoot)) return [];
  return walk(authorityRoot)
    .filter((file) => !file.endsWith('.test.ts'))
    .filter((file) => {
      const text = readFileSync(file, 'utf8');
      // A projection module is one that constructs validator-facing rows.
      return /export function projectCanonical\w*(?:RateScheduleItems|TransactionRows)\s*\(/.test(text);
    })
    .map((file) => path.relative(workspaceRoot, file).replaceAll('\\', '/'))
    .sort();
}

function pricingAssemblyLeakageViolations(workspaceRoot = ROOT): string[] {
  const allowedDualViewCallers = new Set([
    'lib/pipeline/documentPipeline.ts',
    'lib/validator/projectValidator.ts',
  ]);
  const allowedCandidateConsumers = new Set([
    'lib/contracts/analyzeContractIntelligence.ts',
    'lib/contracts/contractPricingAssembly.ts',
    'lib/pipeline/documentPipeline.ts',
    'lib/validator/projectValidator.ts',
  ]);

  return productionReaderFiles(workspaceRoot)
    .flatMap((file) => {
      const source = path.relative(workspaceRoot, file).replaceAll('\\', '/');
      const text = readFileSync(file, 'utf8');
      const violations: string[] = [];
      const isValidationCallGraphSource = source.startsWith('lib/validator/')
        || source === 'lib/contracts/analyzeContractIntelligence.ts'
        || source.startsWith('lib/canonical/publication/');
      if (
        source !== 'lib/contracts/contractPricingAssembly.ts'
        && isValidationCallGraphSource
        && /\bassembleContractPricingRows\s*\(/.test(text)
      ) {
        violations.push(`${source} -> compatibility assembler invocation`);
      }
      if (
        !allowedDualViewCallers.has(source)
        && source !== 'lib/contracts/contractPricingAssembly.ts'
        && /\bassembleContractPricingRowsWithCandidates\s*\(/.test(text)
      ) {
        violations.push(`${source} -> unauthorized dual-view assembler invocation`);
      }
      if (
        !allowedCandidateConsumers.has(source)
        && /\b(?:ContractPricingAssemblyResult|ContractPricingSourceRowIdentity|candidatesBySourceRow)\b/.test(text)
      ) {
        violations.push(`${source} -> pricing candidate leakage`);
      }
      return violations;
    })
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

  it('freezes the only production import into the canonical tree', () => {
    const actual = canonicalProductionEdges();
    const unexpected = actual.filter((edge) => !CANONICAL_PRODUCTION_EDGES.has(edge));
    const missingFrozenEdge = [...CANONICAL_PRODUCTION_EDGES].filter(
      (edge) => !actual.includes(edge),
    );
    expect({ unexpected, missingFrozenEdge }).toEqual({
      unexpected: [],
      missingFrozenEdge: [],
    });
  }, 30_000);

  it('keeps rule packs unaware of which authority produced their input', () => {
    expect(rulePackAuthorityViolations()).toEqual([]);
  }, 30_000);

  it('keeps exactly one canonical-to-validator projection module', () => {
    expect(canonicalProjectionModules())
      .toEqual(['lib/canonical/authority/canonicalValidatorProjection.ts']);
  }, 30_000);

  it('keeps the publication layer isolated from production authorities and UI', () => {
    expect(publicationImportViolations()).toEqual([]);
  });

  it('prevents publication types from becoming a reverse dependency', () => {
    expect(publicationTypeReverseDependencies()).toEqual([]);
  });

  it('prevents publication from reading mutable source identity or provisioning infrastructure', () => {
    expect(publicationRuntimeAuthorityViolations()).toEqual([]);
  });

  it('limits dual-view pricing assembly and candidate data to authorized internal consumers', () => {
    expect(pricingAssemblyLeakageViolations()).toEqual([]);

    const analyzer = readFileSync(
      path.join(ROOT, 'lib/contracts/analyzeContractIntelligence.ts'),
      'utf8',
    );
    expect(analyzer).not.toMatch(/\bassembleContractPricingRows(?:WithCandidates)?\b/);
  });

  it('locks the A12 persisted-rate-row compatibility boundary in the architecture contract', () => {
    const plan = readFileSync(
      path.join(ROOT, 'docs/audits/canonical-production-shadow-publisher-plan-2026-08-02.md'),
      'utf8',
    );
    const normalized = plan.replace(/\s+/g, ' ');

    expect(plan).toContain('| A12 |');
    for (const alias of ['`category`', '`source_category`', '`material_type`', '`canonical_category`']) {
      expect(normalized).toContain(alias);
    }
    expect(normalized).toContain('| Selected rows exist | Any | Disabled |');
    expect(normalized).toContain('| No selected rows | All four aliases absent or blank | Allowed |');
    expect(normalized).toContain('| No selected rows | Any alias nonblank and valid | Disabled |');
    expect(normalized).toContain('| No selected rows | Any alias nonblank but invalid or unresolvable | Disabled |');
    expect(normalized).toMatch(/non-string, non-null alias value/);
    expect(normalized).toMatch(/missing contract rate, `BLOCKED`, and at-risk exposure/);
    expect(normalized).toMatch(/Selection rescue and persisted compatibility fallback are separate controls/);
    expect(normalized).toMatch(/compatibility path is not a second canonical pricing authority/);
  });
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

  it('catches forbidden publication authority references', () => {
    const root = fixtureRoot();
    source(root, 'lib/canonical/publication/sourceRead.ts', "admin.from('documents'); admin.from('extraction_source_artifacts');");
    source(root, 'lib/canonical/publication/provision.ts', 'storage.createBucket();');
    source(root, 'lib/canonical/publication/reassemble.ts', 'assembleContractPricingRows([]);');
    source(root, 'lib/canonical/publication/candidates.ts', 'const retained = input.candidatesBySourceRow;');
    expect(publicationRuntimeAuthorityViolations(root)).toEqual([
      'lib/canonical/publication/candidates.ts -> forbidden pricing candidate dependency',
      'lib/canonical/publication/provision.ts -> forbidden bucket provisioning',
      'lib/canonical/publication/reassemble.ts -> forbidden pricing reassembly',
      'lib/canonical/publication/sourceRead.ts -> forbidden mutable source read',
    ]);
  });
});
