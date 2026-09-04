import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const FOUNDATION = 'lib/repositoryPlanFoundation.ts';
const SNAPSHOT = 'lib/repositoryPlanSnapshot.ts';
const EVIDENCE = 'lib/repositoryPlanEvidence.ts';
const VERIFIER = 'lib/server/repositoryPlanSnapshot.ts';
const WIRE = 'lib/workflowImplementationPlanWire.ts';
const HASH = 'lib/extraction/domain/hash.ts';
const V1 = 'lib/workflowImplementationPlan.ts';
const REVIEWED = 'lib/workflowReviewedSpecification.ts';
const EXTENSION = /\.[cm]?[jt]sx?$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const strip = (file: string): string => file.replace(EXTENSION, '');
type Dependency = { specifier: string; typeOnly: boolean };
const edge = (specifier: string, typeOnly = false): Dependency => ({ specifier, typeOnly });
// This is an exact module graph, including erased type edges. Zod is the schema
// leaf; the existing deterministic hash helper is the sole crypto leaf.
const GRAPH = new Map<string, Dependency[]>([
  [FOUNDATION, [edge('zod'), edge(V1, true), edge(WIRE), edge(HASH), edge(SNAPSHOT), edge(EVIDENCE), edge(VERIFIER, true), edge(REVIEWED)]],
  [SNAPSHOT, [edge('zod')]],
  [EVIDENCE, [edge('zod'), edge(SNAPSHOT)]],
  [VERIFIER, [edge('node:child_process'), edge(SNAPSHOT)]],
  [WIRE, [edge('zod')]],
  [REVIEWED, [edge('zod')]],
  [HASH, [edge('node:crypto')]],
]);
const B1 = new Set([FOUNDATION, SNAPSHOT, EVIDENCE, VERIFIER]);

function parse(text: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function dependencies(text: string, file: string): Dependency[] {
  const found: Dependency[] = [];
  const add = (node: ts.Node | undefined, typeOnly = false): void => {
    found.push(edge(node && ts.isStringLiteralLike(node) ? node.text : '<computed dependency>', typeOnly));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      add(node.moduleSpecifier, Boolean(clause && (clause.isTypeOnly || (!clause.name
        && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((item) => item.isTypeOnly)))));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, node.isTypeOnly);
    else if (ts.isImportTypeNode(node)) add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(parse(text, file));
  return found;
}
function target(file: string, specifier: string): string {
  const normalized = specifier.replaceAll('\\', '/');
  return strip(path.posix.normalize(normalized.startsWith('@/') ? normalized.slice(2)
    : normalized.startsWith('.') ? path.posix.join(path.posix.dirname(file), normalized) : normalized));
}
function normalized(file: string, deps: Dependency[]): Dependency[] {
  return deps.map(({ specifier, typeOnly }) => edge(target(file, specifier), typeOnly))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function graphViolations(file: string, text: string): string[] {
  const expected = normalized(file, GRAPH.get(file) ?? []);
  const actual = normalized(file, dependencies(text, file));
  return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [`${file}: dependency graph differs`];
}
function closureViolations(file: string, read: (file: string) => string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const text = read(file);
  const found = graphViolations(file, text);
  for (const dependency of dependencies(text, file)) {
    if (dependency.typeOnly) continue;
    const next = [...GRAPH.keys()].find((candidate) => strip(candidate) === target(file, dependency.specifier));
    if (next) found.push(...closureViolations(next, read, seen));
  }
  return found;
}
function consumerViolations(file: string, text: string): string[] {
  return dependencies(text, file).flatMap((dependency) => {
    const destination = [...B1].find((candidate) => strip(candidate) === target(file, dependency.specifier));
    if (!destination) return [];
    const permitted = GRAPH.get(file)?.some((candidate) => strip(candidate.specifier) === strip(destination)
      && candidate.typeOnly === dependency.typeOnly);
    return permitted ? [] : [`${file} -> ${dependency.specifier}`];
  });
}
function purityViolations(text: string, file: string): string[] {
  const forbidden = new Set(['Date', 'Math', 'fetch', 'process', 'globalThis', 'window', 'global',
    'eval', 'Function', 'require', 'setTimeout', 'setInterval', 'setImmediate', 'performance',
    'XMLHttpRequest', 'WebSocket', 'navigator', 'crypto', 'Worker', 'SharedWorker', 'Deno', 'Bun']);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && forbidden.has(node.text) || node.kind === ts.SyntaxKind.ImportKeyword) found.push(node.getText());
    ts.forEachChild(node, visit);
  };
  visit(parse(text, file));
  return found;
}
function productionFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? productionFiles(absolute)
      : EXTENSION.test(entry.name) && !TEST.test(entry.name) ? [absolute] : [];
  });
}
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

function verifierViolations(text: string): string[] {
  const found = graphViolations(VERIFIER, text);
  const ast = parse(text, VERIFIER);
  const commands = [
    ['rev-parse', '--is-inside-work-tree'], ['rev-parse', '--show-prefix'],
    ['rev-parse', '--show-object-format'], ['rev-parse', '--verify', 'HEAD^{commit}'],
    ['config', '--get-all', 'remote.origin.url'], ['ls-files', '--stage', '-z'],
    ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], ['ls-files', '-v', '-z'], ['ls-files', '-z'],
    ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none'],
    ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--'],
    ['hash-object', '--stdin-paths'], ['symbolic-ref', '--quiet', '--short', 'HEAD'],
  ].map((words) => JSON.stringify(words));
  const childProcess = ast.statements.filter(ts.isImportDeclaration)
    .filter((node) => ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text === 'node:child_process');
  if (childProcess.length !== 1 || childProcess[0].importClause?.name
    || !childProcess[0].importClause?.namedBindings
    || !ts.isNamedImports(childProcess[0].importClause.namedBindings)
    || childProcess[0].importClause.namedBindings.elements.length !== 1
    || childProcess[0].importClause.namedBindings.elements[0].getText(ast) !== 'execFileSync') found.push('unexpected process API');
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'process'
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
        && node.parent.name.text === 'env')) found.push('unexpected process global access');
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === 'git' || name === 'optionalConfig') {
        const args = node.arguments[0];
        // The optional-config helper forwards its private argument; all callers
        // must have literal read-only argument arrays.
        const forwarding = name === 'git' && args && ts.isIdentifier(args) && args.text === 'args';
        const attributeInspection = args?.getText(ast).replace(/\s+/g, '')
          === "['check-attr','-z',...(cached?['--cached']:[]),'--stdin','filter']";
        if (!forwarding && !attributeInspection && (!args || !ts.isArrayLiteralExpression(args)
          || args.elements.some((item) => !ts.isStringLiteralLike(item)))) found.push('computed git command');
        else if (!forwarding && !attributeInspection && args && ts.isArrayLiteralExpression(args)) {
          const words = args.elements.map((item) => (item as ts.StringLiteral).text);
          if (!commands.includes(JSON.stringify(words))) found.push('non-read-only git command');
        }
      }
      if (name === 'execFileSync') {
        const program = node.arguments[0];
        const options = node.arguments[2];
        if (!program || !ts.isStringLiteralLike(program) || program.text !== 'git'
          || node.arguments[1]?.getText(ast).replace(/\s+/g, '') !== "['--no-pager','-c','core.fsmonitor=false',...args]"
          || !options || !ts.isObjectLiteralExpression(options)
          || !options.properties.some((item) => ts.isPropertyAssignment(item)
            && item.name.getText(ast) === 'shell' && item.initializer.kind === ts.SyntaxKind.FalseKeyword)) found.push('unsafe process invocation');
      }
    }
    if (ts.isIdentifier(node) && ['fetch', 'globalThis', 'eval', 'Function', 'require', 'WebSocket'].includes(node.text)
      || node.kind === ts.SyntaxKind.ImportKeyword) found.push('ambient verifier integration');
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

describe('repository Plan V2 B1 remains a dormant deterministic foundation', () => {
  it('pins every internal dependency and the complete runtime helper closure', () => {
    for (const file of GRAPH.keys()) expect(graphViolations(file, read(file))).toEqual([]);
    expect(closureViolations(FOUNDATION, read)).toEqual([]);
    expect(closureViolations(VERIFIER, read)).toEqual([]);
    for (const file of [FOUNDATION, SNAPSHOT, EVIDENCE, WIRE, REVIEWED]) expect(purityViolations(read(file), file)).toEqual([]);
  });

  it('allows no production consumers outside the exact B1 internal graph', () => {
    const violations: string[] = [];
    for (const absolute of ['app', 'components', 'lib', 'types', 'scripts', 'pages', 'src']
      .flatMap((root) => productionFiles(path.join(ROOT, root)))) {
      const file = path.relative(ROOT, absolute).replaceAll('\\', '/');
      violations.push(...consumerViolations(file, readFileSync(absolute, 'utf8')));
    }
    expect(violations).toEqual([]);
  }, 30_000);

  it('restricts the verifier to its read-only Git subprocess surface', () => {
    const text = read(VERIFIER);
    expect(verifierViolations(text)).toEqual([]);
    for (const addition of ["git(['checkout', 'main']);", "git(['config', 'user.name', 'changed']);",
      "git(['hash-object', '-w', '--stdin-paths']);", "git(['hash-object', '--stdin-paths', '-w']);",
      "git(['hash-object', '--stdin']);", "git(['hash-object', '--stdin-paths', option]);",
      "git(['diff', '--output=written-file']);", "git(['symbolic-ref', '--short', 'HEAD', 'refs/heads/other']);",
      'git(command);', "execFileSync('sh', ['-c', command], { shell: true });",
      "import { spawn } from 'node:child_process';", 'fetch(url);', "process.getBuiltinModule('fs');"]) {
      expect(verifierViolations(text + '\n' + addition)).not.toEqual([]);
    }
  });

  it('detects provider and mutation dependencies even when introduced through a helper', () => {
    for (const bad of ["import { generateText } from 'ai';", "import { client } from '@/lib/supabase';",
      "import { writeFileSync } from 'node:fs';", "export * from '@/lib/server/execution';"] ) {
      for (const changed of [FOUNDATION, EVIDENCE, SNAPSHOT, WIRE, HASH, REVIEWED]) {
        expect(closureViolations(FOUNDATION, (file) => read(file) + (file === changed ? '\n' + bad : ''))).not.toEqual([]);
      }
    }
  });

  it.each([
    "import { x } from '@/lib/repositoryPlanFoundation';",
    "import type { X } from '@/lib/repositoryPlanFoundation';",
    "export * from '../repositoryPlanFoundation';",
    "export type { X } from '../repositoryPlanFoundation';",
    "type X = import('../repositoryPlanFoundation').X;",
    "const x = require('../repositoryPlanFoundation.js');",
    "const x = import('@/lib/x/../repositoryPlanFoundation');",
    "import x = require('../repositoryPlanFoundation');",
    "import { x } from '@/lib/\\u0072epositoryPlanFoundation';",
  ])('rejects fake Codex/provider consumers in every import form: %s', (text) => {
    expect(consumerViolations('lib/codex/consumer.ts', text)).toHaveLength(1);
  });

  it('rejects production integration with snapshot, verifier, and evidence as well as core', () => {
    for (const module of B1) for (const file of ['scripts/codex.ts', 'lib/server/provider.ts',
      'components/Plan.tsx', 'app/api/plan/route.ts']) {
      expect(consumerViolations(file, `import type { X } from '@/${strip(module)}';`)).toHaveLength(1);
    }
    expect(consumerViolations(FOUNDATION, "import { verify } from '@/lib/server/repositoryPlanSnapshot';")).toHaveLength(1);
  });

  it.each(['Date.now()', 'Math.random()', "Math['random']()", 'fetch(url)', 'process.env.X',
    'globalThis[name]()', 'new Function(code)', 'eval(code)', 'require(name)',
    "import('@/lib/' + name)", 'setTimeout(fn, 1)', 'performance.now()'])
  ('rejects ambient and computed runtime access: %s', (text) => {
    expect(purityViolations(text, FOUNDATION)).not.toEqual([]);
    if (/import|require/.test(text)) expect(graphViolations(FOUNDATION, read(FOUNDATION) + '\n' + text)).not.toEqual([]);
  });

  it('does not mistake comments or advisory prose for integration', () => {
    expect(purityViolations("// fetch(url)\nconst note = 'provider execution Date';", FOUNDATION)).toEqual([]);
    expect(consumerViolations('lib/codex/consumer.ts', "// import x from '@/lib/repositoryPlanFoundation';")).toEqual([]);
  });
});
