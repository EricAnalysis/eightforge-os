import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CORE = 'lib/workflowImplementationPlan.ts';
const READ = 'lib/server/workflowImplementationPlanRead.ts';
const PLAN_CONSUMERS = new Set(['lib/server/workflowImplementationPlanRead.ts']);
const READ_CONSUMERS = new Set(['app/api/internal/workflow-assessments/[assessmentId]/implementation-plan/route.ts']);
const RESOLVER = '@/lib/workflowEffectiveReviewedSpecification';
const EXTENSION = /\.[cm]?[jt]sx?$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;

function parse(text: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function dependencies(text: string, file: string): { specifier: string; typeOnly: boolean }[] {
  const found: { specifier: string; typeOnly: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      const typeOnly = Boolean(clause && (clause.isTypeOnly || (!clause.name
        && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every((item) => item.isTypeOnly))));
      found.push({ specifier: node.moduleSpecifier.text, typeOnly });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) {
      found.push({ specifier: node.argument.literal.text, typeOnly: true });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression.text, typeOnly: false });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      found.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(text, file));
  return found;
}

function consumerViolations(file: string, text: string): string[] {
  return dependencies(text, file).flatMap(({ specifier }) => {
    const normalized = specifier.replaceAll('\\', '/');
    const resolved = normalized.startsWith('@/') ? normalized.slice(2)
      : normalized.startsWith('.') ? path.posix.join(path.posix.dirname(file), normalized) : normalized;
    const target = path.posix.normalize(resolved).replace(EXTENSION, '');
    return (target === CORE.replace(EXTENSION, '') && !PLAN_CONSUMERS.has(file))
      || (target === READ.replace(EXTENSION, '') && !READ_CONSUMERS.has(file))
      ? [`${file} -> ${specifier}`] : [];
  });
}

function purityViolations(text: string): string[] {
  const found: string[] = [];
  const forbidden = new Set(['Date', 'Math', 'fetch', 'process', 'globalThis', 'window', 'global',
    'eval', 'Function', 'require', 'setTimeout', 'setInterval', 'performance', 'XMLHttpRequest',
    'WebSocket', 'navigator', 'crypto']);
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) && forbidden.has(node.text))
      || node.kind === ts.SyntaxKind.ImportKeyword) found.push(node.getText());
    ts.forEachChild(node, visit);
  };
  visit(parse(text, CORE));
  return found;
}

function productionFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(absolute);
    return EXTENSION.test(entry.name) && !TEST.test(entry.name) ? [absolute] : [];
  });
}

// Deliberately constrain the small trusted seam's AST. Matching just a builder
// call would also accept a replaced or mutated `resolved.artifact` beforehand.
function directCompositionViolations(text: string): string[] {
  const ast = parse(text, READ);
  const functions = ast.statements.filter(ts.isFunctionDeclaration);
  const fn = functions.find((item) => item.name?.text === 'readWorkflowImplementationPlan');
  if (functions.length !== 1 || !fn?.body || fn.parameters.length !== 2
    || fn.parameters[0].name.getText(ast) !== 'request'
    || fn.parameters[1].name.getText(ast) !== 'pin') return ['unexpected seam function'];
  const outer = fn.body.statements;
  if (outer.length !== 1 || !ts.isTryStatement(outer[0]) || outer[0].finallyBlock) {
    return ['unexpected composition wrapper'];
  }
  const statements = outer[0].tryBlock.statements;
  const printed = (node: ts.Node): string => ts.createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Unspecified, node, ast).replace(/\s+/g, '');
  const withoutLogging = (block: ts.Block): ts.Statement[] => block.statements.filter((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return true;
    const call = statement.expression;
    return !(ts.isPropertyAccessExpression(call.expression)
      && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'console'
      && call.expression.name.text === 'error' && call.arguments.length === 1
      && ts.isStringLiteral(call.arguments[0]));
  });
  const catchStatements = outer[0].catchClause && withoutLogging(outer[0].catchClause.block);
  if (!catchStatements || catchStatements.length !== 1
    || printed(catchStatements[0]) !== "return{ok:false,code:'plan_not_composable'};") {
    return ['unexpected failure handling'];
  }
  const expected = [
    'const resolved = await readEffectiveReviewedSpecification(request, pin);',
    'if (!resolved.ok) return resolved;',
    'const planned = buildWorkflowImplementationPlan(resolved.artifact);',
    "if (!planned.ok) return { ok: false, code: 'plan_not_composable' };",
    'return planned;',
  ];
  const actual = statements.map((statement) => {
    if (ts.isIfStatement(statement) && ts.isBlock(statement.thenStatement)
      && withoutLogging(statement.thenStatement).length === 1 && !statement.elseStatement) {
      return printed(ts.factory.updateIfStatement(statement, statement.expression,
        withoutLogging(statement.thenStatement)[0], undefined));
    }
    return printed(statement);
  });
  const wanted = expected.map((statement) => ts.createPrinter({ removeComments: true })
    .printFile(parse(statement, READ)).replace(/\s+/g, ''));
  return actual.length === wanted.length && actual.every((statement, index) => statement === wanted[index])
    ? [] : ['resolver output is not composed directly and unchanged'];
}

describe('workflow implementation plan has no runtime or authority integration', () => {
  it('keeps the GET route restricted to identity parsing and the trusted seam', () => {
    const route = [...READ_CONSUMERS][0];
    const text = readFileSync(path.join(ROOT, route), 'utf8');
    expect(dependencies(text, route)).toEqual([
      { specifier: '@/lib/server/workflowImplementationPlanRead', typeOnly: false },
    ]);
    const ast = parse(text, route);
    const calls: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push(node.expression.getText(ast));
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(calls.filter((call) => ![
      'Response.json', '/^[1-9][0-9]*$/.test', 'Number', 'Number.isSafeInteger',
      'json', 'URL', 'Array.from', 'query.keys', 'Array.from(query.keys()).some',
      'QUERY_KEYS.includes', 'QUERY_KEYS.some', 'query.getAll', 'query.get',
      'version', 'readWorkflowImplementationPlan',
    ].includes(call))).toEqual([]);
    const exports = ast.statements.filter(ts.isFunctionDeclaration)
      .filter((fn) => fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      .map((fn) => fn.name?.text);
    expect(exports).toEqual(['GET']);
    expect(text).not.toMatch(/request\s*(?:\.\s*(?:json|text|formData|arrayBuffer|blob)|\[\s*['"](?:json|text|formData|arrayBuffer|blob)['"]\s*\])\s*\(/);
  });

  it('keeps the trusted seam dependency list exact with no IO or authority surfaces', () => {
    const text = readFileSync(path.join(ROOT, READ), 'utf8');
    expect(dependencies(text, READ).map(({ specifier }) => specifier).sort()).toEqual([
      '@/lib/server/workflowEffectiveReviewedSpecificationRead', '@/lib/workflowImplementationPlan',
    ].sort());
    const ast = parse(text, READ);
    const calls: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push(node.expression.getText(ast));
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(calls.filter((call) => !['readEffectiveReviewedSpecification',
      'buildWorkflowImplementationPlan', 'console.error'].includes(call))).toEqual([]);
    expect(directCompositionViolations(text)).toEqual([]);
  });

  it('rejects cloned, reconstructed, body-supplied, mutated, or reloaded artifacts', () => {
    const text = readFileSync(path.join(ROOT, READ), 'utf8');
    const original = 'buildWorkflowImplementationPlan(resolved.artifact)';
    expect(text).toContain(original);
    for (const replacement of [
      'buildWorkflowImplementationPlan({ ...resolved.artifact })',
      'buildWorkflowImplementationPlan(JSON.parse(JSON.stringify(resolved.artifact)))',
      'buildWorkflowImplementationPlan(await request.json())',
      'buildWorkflowImplementationPlan({ ...resolved.artifact, digest: pin.digest })',
      'buildWorkflowImplementationPlan(await reloadArtifact(pin))',
      'buildWorkflowImplementationPlan(pin)',
    ]) expect(directCompositionViolations(text.replace(original, replacement))).not.toEqual([]);
    expect(directCompositionViolations(text.replace('const planned =',
      "resolved.artifact = pin; const planned ="))).not.toEqual([]);
    expect(directCompositionViolations(text.replace('const planned =',
      "resolved.artifact.digest = pin.digest; const planned ="))).not.toEqual([]);
    expect(directCompositionViolations(text.replace('request, pin)', 'request, {})'))).not.toEqual([]);
  });

  it('keeps its exact pure dependency list and resolver types erased', () => {
    const text = readFileSync(path.join(ROOT, CORE), 'utf8');
    const imports = dependencies(text, CORE);
    expect(imports.map(({ specifier }) => specifier).sort()).toEqual([
      'zod', RESOLVER, '@/lib/workflowReviewedSpecification', '@/lib/extraction/domain/hash',
    ].sort());
    expect(imports.filter(({ specifier }) => specifier === RESOLVER))
      .toEqual([{ specifier: RESOLVER, typeOnly: true }]);
    expect(purityViolations(text)).toEqual([]);
    expect(dependencies(readFileSync(path.join(ROOT, 'lib/workflowReviewedSpecification.ts'), 'utf8'), 'schema.ts'))
      .toEqual([{ specifier: 'zod', typeOnly: false }]);
    expect(dependencies(readFileSync(path.join(ROOT, 'lib/extraction/domain/hash.ts'), 'utf8'), 'hash.ts'))
      .toEqual([{ specifier: 'node:crypto', typeOnly: false }]);
  });

  it('allows exactly the trusted seam and GET route, including type imports and reexports', () => {
    expect([...PLAN_CONSUMERS]).toEqual(['lib/server/workflowImplementationPlanRead.ts']);
    expect([...READ_CONSUMERS]).toEqual(['app/api/internal/workflow-assessments/[assessmentId]/implementation-plan/route.ts']);
    const violations: string[] = [];
    for (const absolute of ['app', 'components', 'lib', 'types', 'scripts']
      .flatMap((root) => productionFiles(path.join(ROOT, root)))) {
      const file = path.relative(ROOT, absolute).replaceAll('\\', '/');
      const text = readFileSync(absolute, 'utf8');
      if (!text.includes('workflowImplementationPlan') && !/\\[ux]/.test(text)) continue;
      violations.push(...consumerViolations(file, text));
    }
    expect(violations).toEqual([]);
  });

  it('rejects route-to-builder shortcuts and generic server consumers', () => {
    const planImport = "import { buildWorkflowImplementationPlan } from '@/lib/workflowImplementationPlan';";
    expect(consumerViolations(READ, planImport)).toEqual([]);
    for (const file of [...READ_CONSUMERS, 'lib/server/other.ts', 'lib/server/nested/other.ts']) {
      expect(consumerViolations(file, planImport)).toHaveLength(1);
    }
    const seamImport = "import { readWorkflowImplementationPlan } from '@/lib/server/workflowImplementationPlanRead';";
    expect(consumerViolations([...READ_CONSUMERS][0], seamImport)).toEqual([]);
    expect(consumerViolations('app/api/other/route.ts', seamImport)).toHaveLength(1);
    expect(consumerViolations('lib/server/other.ts', seamImport)).toHaveLength(1);
  });

  it.each([
    "import { x } from '@/lib/workflowImplementationPlan';",
    "import type { X } from '@/lib/workflowImplementationPlan';",
    "export * from '../workflowImplementationPlan';",
    "type X = import('../workflowImplementationPlan').X;",
    "const x = require('../workflowImplementationPlan.js');",
    "const x = import('@/lib/x/../workflowImplementationPlan');",
    "import x = require('../workflowImplementationPlan');",
    "import { x } from '@/lib/\\u0077orkflowImplementationPlan';",
  ])('rejects unauthorized import form: %s', (text) => {
    expect(consumerViolations('lib/validator/consumer.ts', text)).toHaveLength(1);
  });

  it.each([
    'Date.now()', 'fetch(url)', 'Math.random()', "Math['random']()", 'process.env.X',
    "import('@/lib/' + name)", 'require(name)', 'globalThis[key]()',
    'new Function(code)', 'eval(code)', 'setTimeout(fn, 1)', 'performance.now()',
  ])('rejects impure or computed runtime access: %s', (text) => {
    expect(purityViolations(text).length).toBeGreaterThan(0);
  });

  it('ignores commented imports and runtime names', () => {
    expect(consumerViolations('lib/consumer.ts', "// import x from '@/lib/workflowImplementationPlan';")).toEqual([]);
    expect(purityViolations('// Date.now(); fetch(url);')).toEqual([]);
  });
});
