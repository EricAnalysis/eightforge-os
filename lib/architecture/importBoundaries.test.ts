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
  // The authority mode vocabulary reaches the validator so one input can be built
  // for an explicitly named authority. Required by the A15 shadow comparison,
  // which builds a legacy input and a canonical input from one frozen snapshot.
  'lib/validator/projectValidator.ts -> @/lib/canonical/authority/projectTruthAuthorityMode',
  // ── Non-serving authority comparison (amendment A15) ──
  // The comparison is invoked from the serving orchestrator ONLY, after the
  // serving result is persisted, and only through these three edges. The
  // orchestrator is the one production module allowed to know comparison exists;
  // the validator, the rule packs, and the publisher must not.
  'lib/validator/triggerProjectValidation.ts -> @/lib/canonical/comparison/authorityComparisonFlag',
  'lib/validator/triggerProjectValidation.ts -> @/lib/canonical/comparison/authorityComparisonPersistence',
  'lib/validator/triggerProjectValidation.ts -> @/lib/canonical/comparison/runProjectTruthAuthorityComparison',
]);

const COMPARISON_ROOT = 'lib/canonical/comparison';
const FORGEWING_ROOT = 'lib/forgewing';
const FORGEWING_EVALUATION_ROOT = 'lib/evaluation/forgewing';
const FORGEWING_ALLOWED_OUTBOUND_MODULES = new Set([
  'zod',
  'node:fs',
  '@/lib/extraction/domain/hash',
  '@/lib/server/ai/claudeClient',
]);
const FORGEWING_AUTHORIZED_CONSUMERS = new Set([
  'lib/extraction/persistence/complianceShadow.ts',
]);
const FORGEWING_MENTION_PATTERN = /(?:@\/)?lib[\\/]forgewing(?:[\\/]|\b)|(?:^|[\\/])forgewing[\\/]|\bForgewing[A-Z][A-Za-z0-9_]*\b|\btable_continuation\b/;

function productionFilesIn(workspaceRoot: string): string[] {
  return PRODUCTION_ROOTS
    .flatMap((root) => walk(path.join(workspaceRoot, root)));
}

function productionEdgesIn(workspaceRoot: string): ImportEdge[] {
  return productionFilesIn(workspaceRoot)
    .flatMap((file) => importsInFile(file, workspaceRoot));
}

function nonLiteralModuleLoadsInFile(
  absolutePath: string,
  workspaceRoot: string,
): string[] {
  const source = path.relative(workspaceRoot, absolutePath).replaceAll('\\', '/');
  const sourceFile = ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    absolutePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword
        ? 'import'
        : ts.isIdentifier(node.expression) && node.expression.text === 'require'
          ? 'require'
          : null;
      if (
        kind != null
        && (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]!))
      ) {
        violations.push(`${source} -> non-literal ${kind}() (Forgewing outbound import is not statically allowlisted)`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/**
 * Forgewing may describe evidence, but Commit 1 has no authorized production
 * consumer and no authority-producing dependency. Both directions are sealed so
 * future nested files cannot turn proposals into serving truth by import alone.
 */
function forgewingBoundaryViolations(workspaceRoot = ROOT): string[] {
  const violations: string[] = [];
  const importConsumers = new Set<string>();
  for (const edge of productionEdgesIn(workspaceRoot)) {
    const target = resolveImportTarget(edge);
    const sourceIsForgewing = isWithin(edge.source, FORGEWING_ROOT);
    const targetIsForgewing = isWithin(target, FORGEWING_ROOT);
    const sourceIsForgewingEvaluation = isWithin(edge.source, FORGEWING_EVALUATION_ROOT);
    const targetIsForgewingEvaluation = isWithin(target, FORGEWING_EVALUATION_ROOT);

    if (
      targetIsForgewing
      && !sourceIsForgewing
      && !sourceIsForgewingEvaluation
      && !FORGEWING_AUTHORIZED_CONSUMERS.has(edge.source)
    ) {
      importConsumers.add(edge.source);
      violations.push(`${edge.source} -> ${edge.specifier} (unauthorized Forgewing consumer)`);
    }
    if (
      sourceIsForgewing
      && !targetIsForgewing
      && !FORGEWING_ALLOWED_OUTBOUND_MODULES.has(edge.specifier)
    ) {
      violations.push(`${edge.source} -> ${edge.specifier} (Forgewing outbound import is not allowlisted)`);
    }
    if (targetIsForgewingEvaluation && !sourceIsForgewingEvaluation && !sourceIsForgewing) {
      importConsumers.add(edge.source);
      violations.push(`${edge.source} -> ${edge.specifier} (unauthorized Forgewing evaluation consumer)`);
    }
    if (sourceIsForgewingEvaluation && (
      isWithin(target, 'app')
      || isWithin(target, 'components')
      || isWithin(target, 'lib/server')
      || isWithin(target, 'lib/pipeline')
      || isWithin(target, 'lib/canonical')
      || isWithin(target, 'lib/validator')
      || isWithin(target, 'lib/contracts')
    )) {
      violations.push(`${edge.source} -> ${edge.specifier} (Forgewing evaluation imports serving or authority code)`);
    }
  }

  for (const file of walk(path.join(workspaceRoot, FORGEWING_ROOT))) {
    violations.push(...nonLiteralModuleLoadsInFile(file, workspaceRoot));
  }

  for (const file of productionFilesIn(workspaceRoot)) {
    const source = path.relative(workspaceRoot, file).replaceAll('\\', '/');
    if (
      isWithin(source, FORGEWING_ROOT)
      || isWithin(source, FORGEWING_EVALUATION_ROOT)
      || FORGEWING_AUTHORIZED_CONSUMERS.has(source)
    ) continue;
    if (importConsumers.has(source)) continue;
    if (FORGEWING_MENTION_PATTERN.test(readFileSync(file, 'utf8'))) {
      violations.push(`${source} -> references Forgewing outside its module boundary`);
    }
  }
  return violations.sort();
}

function forgewingProductionConsumers(workspaceRoot = ROOT): string[] {
  return [...new Set(productionEdgesIn(workspaceRoot).flatMap((edge) => {
    const target = resolveImportTarget(edge);
    return isWithin(target, FORGEWING_ROOT)
      && !isWithin(edge.source, FORGEWING_ROOT)
      && !isWithin(edge.source, FORGEWING_EVALUATION_ROOT)
      ? [edge.source]
      : [];
  }))].sort();
}

/**
 * The comparison layer may call authority orchestration; nothing in the
 * validation call graph may call comparison persistence.
 *
 * A production reader that imported the comparison artifact reader would turn an
 * audit record into an input to truth — the single failure this whole phase is
 * built to prevent. The rule is asserted from both directions: comparison must not
 * be imported by authority/validator/publisher/extraction/UI code, and comparison
 * itself must not import UI.
 */
function comparisonBoundaryViolations(workspaceRoot = ROOT): string[] {
  const violations: string[] = [];
  const comparisonModules = new Set(
    walk(path.join(workspaceRoot, COMPARISON_ROOT))
      .map((file) => path.relative(workspaceRoot, file).replaceAll('\\', '/')),
  );

  for (const edge of allEdges()) {
    const target = resolveImportTarget(edge);
    if (!isWithin(target, COMPARISON_ROOT)) continue;
    // The serving orchestrator is the single authorized production consumer.
    if (edge.source === 'lib/validator/triggerProjectValidation.ts') continue;
    if (edge.source.startsWith(`${COMPARISON_ROOT}/`)) continue;
    violations.push(`${edge.source} -> ${edge.specifier} (unauthorized comparison consumer)`);
  }

  // Nothing that produces truth may reach comparison, and comparison may not
  // reach the UI. Both directions are checked explicitly.
  for (const source of comparisonModules) {
    for (const edge of importsInFile(path.join(workspaceRoot, source), workspaceRoot)) {
      const target = resolveImportTarget(edge);
      if (isWithin(target, 'components') || isWithin(target, 'app')) {
        violations.push(`${source} -> ${edge.specifier} (comparison imports UI)`);
      }
      if (isWithin(target, 'lib/extraction')) {
        violations.push(`${source} -> ${edge.specifier} (comparison imports extraction)`);
      }
      if (target === 'lib/validator/persistValidationRun'
        || target === 'lib/validator/triggerProjectValidation') {
        violations.push(`${source} -> ${edge.specifier} (comparison imports serving persistence)`);
      }
    }
  }

  // The authority layer, the rule packs, the publisher, and extraction must not
  // mention comparison at all — not by import and not by identifier.
  const forbiddenMentionRoots = [
    'lib/canonical/authority',
    'lib/canonical/publication',
    'lib/canonical/project',
    'lib/validator/rulePacks',
    'lib/extraction',
  ];
  for (const root of forbiddenMentionRoots) {
    for (const file of walk(path.join(workspaceRoot, root))) {
      const source = path.relative(workspaceRoot, file).replaceAll('\\', '/');
      const text = readFileSync(file, 'utf8');
      if (/canonical[\\/]comparison[\\/]|AuthorityComparison|runProjectTruthAuthorityComparison/.test(text)) {
        violations.push(`${source} -> references the comparison layer`);
      }
    }
  }

  return violations.sort();
}

/**
 * A comparison outcome must not be able to become a serving validation result.
 *
 * Enforced structurally: the comparison orchestrator does not import
 * `ValidatorResult` and does not name it, so there is no type by which a
 * `ValidatorResult` could leave the module. The two in-memory results are local to
 * one private helper and are dropped when the comparison returns.
 */
function comparisonServingLeakViolations(workspaceRoot = ROOT): string[] {
  const orchestrator = path.join(
    workspaceRoot,
    COMPARISON_ROOT,
    'runProjectTruthAuthorityComparison.ts',
  );
  if (!existsSync(orchestrator)) return ['comparison orchestrator is missing'];
  const text = readFileSync(orchestrator, 'utf8');
  const violations: string[] = [];
  if (/\bValidatorResult\b/.test(text)) {
    violations.push('comparison orchestrator references ValidatorResult');
  }
  if (/persistValidationRun|scheduleCanonicalProjectTruthShadowPublication|logActivityEvent/.test(text)) {
    violations.push('comparison orchestrator reaches a serving side effect');
  }
  return violations.sort();
}

function comparisonSingletonModules(
  workspaceRoot: string,
  pattern: RegExp,
): string[] {
  const root = path.join(workspaceRoot, COMPARISON_ROOT);
  if (!existsSync(root)) return [];
  return walk(root)
    .filter((file) => !file.endsWith('.test.ts'))
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(workspaceRoot, file).replaceAll('\\', '/'))
    .sort();
}

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
      ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
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

  it('keeps the authority comparison layer out of every truth-producing path', () => {
    expect(comparisonBoundaryViolations()).toEqual([]);
  }, 30_000);

  it('keeps Forgewing non-authoritative with one shadow consumer and an isolated evaluator', () => {
    expect(forgewingBoundaryViolations()).toEqual([]);
    expect(forgewingProductionConsumers()).toEqual([
      'lib/extraction/persistence/complianceShadow.ts',
    ]);
  }, 30_000);

  it('prevents a comparison outcome from becoming a serving validation result', () => {
    expect(comparisonServingLeakViolations()).toEqual([]);
  });

  it('keeps exactly one comparison normalization module', () => {
    expect(comparisonSingletonModules(ROOT, /export function normalizeAuthorityRun\s*\(/))
      .toEqual(['lib/canonical/comparison/authorityRunNormalization.ts']);
  }, 30_000);

  it('keeps exactly one comparison orchestration entry point', () => {
    expect(comparisonSingletonModules(ROOT, /export async function runProjectTruthAuthorityComparison\s*\(/))
      .toEqual(['lib/canonical/comparison/runProjectTruthAuthorityComparison.ts']);
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

describe('Forgewing proposal authority seal', () => {
  const temporaryRoots: string[] = [];
  const fixtureRoot = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'eightforge-forgewing-guard-'));
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

  it('forbids extraction and canonical imports of Forgewing recursively', () => {
    const root = fixtureRoot();
    source(root, 'lib/extraction/nested/consumer.ts', "import { schema } from '@/lib/forgewing/proposal/schema';");
    source(root, 'lib/canonical/authority/nested/consumer.ts', "export { schema } from '../../../forgewing/proposal/schema';");
    expect(forgewingBoundaryViolations(root)).toEqual([
      'lib/canonical/authority/nested/consumer.ts -> ../../../forgewing/proposal/schema (unauthorized Forgewing consumer)',
      'lib/extraction/nested/consumer.ts -> @/lib/forgewing/proposal/schema (unauthorized Forgewing consumer)',
    ]);
  });

  it('forbids every production consumer including dynamic and require forms', () => {
    const root = fixtureRoot();
    source(root, 'lib/validator/consumer.ts', "import type { Proposal } from '@/lib/forgewing/proposal/schema';");
    source(root, 'lib/contracts/consumer.ts', "export { schema } from '../forgewing/proposal/schema';");
    source(root, 'app/dynamic.ts', "const schema = import('@/lib/forgewing/proposal/schema');");
    source(root, 'components/required.ts', "const schema = require('../lib/forgewing/proposal/schema');");
    expect(forgewingBoundaryViolations(root)).toEqual([
      'app/dynamic.ts -> @/lib/forgewing/proposal/schema (unauthorized Forgewing consumer)',
      'components/required.ts -> ../lib/forgewing/proposal/schema (unauthorized Forgewing consumer)',
      'lib/contracts/consumer.ts -> ../forgewing/proposal/schema (unauthorized Forgewing consumer)',
      'lib/validator/consumer.ts -> @/lib/forgewing/proposal/schema (unauthorized Forgewing consumer)',
    ]);
  });

  it('allows only the exact dependencies used by current Forgewing production files', () => {
    const root = fixtureRoot();
    source(root, 'lib/forgewing/proposal/allowed.ts', [
      "import { z } from 'zod';",
      "import { readFileSync } from 'node:fs';",
      "import { hashCanonical } from '@/lib/extraction/domain/hash';",
      "import { getClaudeClient } from '@/lib/server/ai/claudeClient';",
      "export { VERSION } from './version';",
      "const schema = import('@/lib/forgewing/proposal/schema');",
      "const guards = require('./guards');",
    ].join('\n'));
    expect(forgewingBoundaryViolations(root)).toEqual([]);
  });

  it('allows only complianceShadow to consume Forgewing in production', () => {
    const root = fixtureRoot();
    source(
      root,
      'lib/extraction/persistence/complianceShadow.ts',
      "import { runForgewingRegionClassification } from '@/lib/forgewing/tasks/regionClassification';",
    );
    source(
      root,
      'lib/extraction/persistence/secondConsumer.ts',
      "import { runForgewingRegionClassification } from '@/lib/forgewing/tasks/regionClassification';",
    );
    expect(forgewingBoundaryViolations(root)).toEqual([
      'lib/extraction/persistence/secondConsumer.ts -> @/lib/forgewing/tasks/regionClassification (unauthorized Forgewing consumer)',
    ]);
  });

  it('allows only the isolated evaluation subtree to measure Forgewing', () => {
    const root = fixtureRoot();
    source(
      root,
      'lib/evaluation/forgewing/measure.ts',
      "import type { ForgewingProposalBundle } from '@/lib/forgewing/proposal/schema';",
    );
    source(
      root,
      'lib/evaluation/otherMeasure.ts',
      "import type { ForgewingProposalBundle } from '@/lib/forgewing/proposal/schema';",
    );
    expect(forgewingBoundaryViolations(root)).toEqual([
      'lib/evaluation/otherMeasure.ts -> @/lib/forgewing/proposal/schema (unauthorized Forgewing consumer)',
    ]);
  });

  it('forbids Forgewing from importing evaluation and serving code from consuming evaluation', () => {
    const root = fixtureRoot();
    source(
      root,
      'lib/forgewing/tasks/contaminated.ts',
      "import { evaluate } from '@/lib/evaluation/forgewing/regionClassificationEvaluation';",
    );
    source(
      root,
      'lib/validator/evaluationReader.ts',
      "import { evaluate } from '@/lib/evaluation/forgewing/regionClassificationEvaluation';",
    );
    expect(forgewingBoundaryViolations(root)).toEqual([
      'lib/forgewing/tasks/contaminated.ts -> @/lib/evaluation/forgewing/regionClassificationEvaluation (Forgewing outbound import is not allowlisted)',
      'lib/validator/evaluationReader.ts -> @/lib/evaluation/forgewing/regionClassificationEvaluation (unauthorized Forgewing evaluation consumer)',
    ]);
  });

  it('forbids evaluation from reaching serving, authority, validator, and contract code', () => {
    const root = fixtureRoot();
    source(root, 'lib/evaluation/forgewing/leak.ts', [
      "import '@/lib/canonical/publication/publishProjectTruthShadow';",
      "import '@/lib/validator/projectValidator';",
      "import '@/lib/contracts/analyzeContractIntelligence';",
      "import '@/lib/server/documentExtraction';",
    ].join('\n'));
    expect(forgewingBoundaryViolations(root)).toEqual([
      'lib/evaluation/forgewing/leak.ts -> @/lib/canonical/publication/publishProjectTruthShadow (Forgewing evaluation imports serving or authority code)',
      'lib/evaluation/forgewing/leak.ts -> @/lib/contracts/analyzeContractIntelligence (Forgewing evaluation imports serving or authority code)',
      'lib/evaluation/forgewing/leak.ts -> @/lib/server/documentExtraction (Forgewing evaluation imports serving or authority code)',
      'lib/evaluation/forgewing/leak.ts -> @/lib/validator/projectValidator (Forgewing evaluation imports serving or authority code)',
    ]);
  });

  it('rejects truth, semantic, evaluation, pipeline, serving, and UI modules by default', () => {
    const root = fixtureRoot();
    const forbiddenSpecifiers = [
      '@/lib/projectFacts',
      '@/lib/truthQuery',
      '@/lib/effectiveFacts',
      '@/lib/ask/retrieval',
      '@/lib/interpretation/semanticColumnMapping',
      '@/lib/interpretation/step3ShadowBridge',
      '@/lib/evaluation/syntheticGeneralizationHarness',
      '@/lib/pipeline/documentPipeline',
      '@/lib/documentIntelligence',
      '@/lib/contracts/pricing',
      '@/lib/validator/projectValidator',
      '@/lib/canonical/authority/resolveProjectTruthAuthority',
      '@/lib/server/documentExtraction',
      '@/app/reader',
      '@/components/reader',
    ];
    source(root, 'lib/forgewing/proposal/outbound.ts', [
      `import '${forbiddenSpecifiers[0]}';`,
      `export { value } from '${forbiddenSpecifiers[1]}';`,
      `const effective = import('${forbiddenSpecifiers[2]}');`,
      `const retrieval = require('${forbiddenSpecifiers[3]}');`,
      ...forbiddenSpecifiers.slice(4).map((specifier) => `import '${specifier}';`),
    ].join('\n'));
    const violations = forgewingBoundaryViolations(root);
    expect(violations).toHaveLength(forbiddenSpecifiers.length);
    for (const specifier of forbiddenSpecifiers) {
      expect(violations.some((violation) => violation.includes(`-> ${specifier} (`))).toBe(true);
    }
  });

  it('rejects neutral-looking, arbitrary future, and unlisted external modules', () => {
    const root = fixtureRoot();
    const forbiddenSpecifiers = [
      '@/lib/extraction/domain/types',
      '@/lib/futureNeutralLookingModule',
      'zod/v4',
      'unreviewed-package',
    ];
    source(root, 'lib/forgewing/proposal/defaultDenied.ts', forbiddenSpecifiers
      .map((specifier) => `import '${specifier}';`)
      .join('\n'));
    const violations = forgewingBoundaryViolations(root);
    expect(violations).toHaveLength(forbiddenSpecifiers.length);
    for (const specifier of forbiddenSpecifiers) {
      expect(violations.some((violation) => violation.includes(`-> ${specifier} (`))).toBe(true);
    }
  });

  it('rejects type-position imports outside the Forgewing allowlist', () => {
    const root = fixtureRoot();
    source(
      root,
      'lib/forgewing/proposal/typeImport.ts',
      "type Facts = import('@/lib/projectFacts').ProjectFacts;",
    );
    expect(forgewingBoundaryViolations(root)).toEqual([
      'lib/forgewing/proposal/typeImport.ts -> @/lib/projectFacts (Forgewing outbound import is not allowlisted)',
    ]);
  });

  it('rejects non-literal dynamic module loading inside Forgewing', () => {
    const root = fixtureRoot();
    source(root, 'lib/forgewing/proposal/computed.ts', [
      "const target = '@/lib/projectFacts';",
      'const dynamic = import(target);',
      'const required = require(target);',
    ].join('\n'));
    expect(forgewingBoundaryViolations(root)).toEqual([
      'lib/forgewing/proposal/computed.ts -> non-literal import() (Forgewing outbound import is not statically allowlisted)',
      'lib/forgewing/proposal/computed.ts -> non-literal require() (Forgewing outbound import is not statically allowlisted)',
    ]);
  });

  it('forbids textual Forgewing backdoors across production modules', () => {
    const root = fixtureRoot();
    source(root, 'lib/extraction/mention.ts', "const moduleName = 'lib/forgewing/proposal/schema';");
    source(root, 'lib/contracts/mention.ts', 'type Candidate = ForgewingProposal;');
    source(root, 'lib/validator/mention.ts', 'type Bundle = ForgewingProposalBundle;');
    source(root, 'lib/canonical/mention.ts', 'type Result = ForgewingAbstention;');
    source(root, 'lib/projectFacts.ts', 'type Run = ForgewingRunIdentity;');
    source(root, 'lib/extraction/relativeMention.ts', [
      "const target = '../forgewing/proposal/schema';",
      'const dynamic = import(target);',
    ].join('\n'));
    source(root, 'lib/contracts/windowsMention.ts', "const target = '..\\forgewing\\proposal\\schema';");
    source(root, 'lib/validator/rawTaskDiscriminator.ts', "const taskType = 'table_continuation';");
    expect(forgewingBoundaryViolations(root)).toEqual([
      'lib/canonical/mention.ts -> references Forgewing outside its module boundary',
      'lib/contracts/mention.ts -> references Forgewing outside its module boundary',
      'lib/contracts/windowsMention.ts -> references Forgewing outside its module boundary',
      'lib/extraction/mention.ts -> references Forgewing outside its module boundary',
      'lib/extraction/relativeMention.ts -> references Forgewing outside its module boundary',
      'lib/projectFacts.ts -> references Forgewing outside its module boundary',
      'lib/validator/mention.ts -> references Forgewing outside its module boundary',
      'lib/validator/rawTaskDiscriminator.ts -> references Forgewing outside its module boundary',
    ]);
  });

  it('enumerates the exact production Forgewing consumer set', () => {
    const root = fixtureRoot();
    source(
      root,
      'lib/extraction/persistence/complianceShadow.ts',
      "import { runForgewingRegionClassification } from '@/lib/forgewing/tasks/regionClassification';",
    );
    source(
      root,
      'lib/extraction/persistence/secondConsumer.ts',
      "import { runForgewingRegionClassification } from '@/lib/forgewing/tasks/regionClassification';",
    );
    source(
      root,
      'lib/evaluation/forgewing/measure.ts',
      "import type { ForgewingProposalBundle } from '@/lib/forgewing/proposal/schema';",
    );
    expect(forgewingProductionConsumers(root)).toEqual([
      'lib/extraction/persistence/complianceShadow.ts',
      'lib/extraction/persistence/secondConsumer.ts',
    ]);
  });

  it('allows Forgewing-internal imports and test-only consumers', () => {
    const root = fixtureRoot();
    source(root, 'lib/forgewing/proposal/guards.ts', "import type { Proposal } from './schema';");
    source(root, 'lib/extraction/consumer.test.ts', [
      "import { schema } from '@/lib/forgewing/proposal/schema';",
      "const label = 'ForgewingProposalBundle';",
    ].join('\n'));
    expect(forgewingBoundaryViolations(root)).toEqual([]);
  });
});
