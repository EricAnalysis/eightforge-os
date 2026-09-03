import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CORE = 'lib/workflowImplementationPlan.ts';
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
    return path.posix.normalize(resolved).replace(EXTENSION, '') === CORE.replace(EXTENSION, '')
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

describe('workflow implementation plan has no runtime or authority integration', () => {
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

  it('has an empty production consumer set, including type imports and reexports', () => {
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
