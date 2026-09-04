import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const WIRE = 'lib/workflowImplementationPlanWire.ts';
const PAGE = 'app/platform/workflows/reviews/[assessmentId]/implementation-plan/page.tsx';
const CLIENT = 'components/platform/WorkflowImplementationPlanClient.tsx';
const VIEW = 'components/platform/WorkflowImplementationPlanView.tsx';
const SESSION = 'components/platform/PlatformSessionContext.tsx';
const UI = [PAGE, CLIENT, VIEW];
const WIRE_CONSUMERS = new Set([...UI, 'lib/repositoryPlanFoundation.ts']);
const EXTENSION = /\.[cm]?[jt]sx?$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const withoutExtension = (file: string): string => file.replace(EXTENSION, '');
const allowed = new Map<string, Set<string>>([
  [WIRE, new Set(['zod'])],
  [PAGE, new Set(['react', withoutExtension(CLIENT)])],
  [CLIENT, new Set(['react', 'next/navigation', 'next/link', withoutExtension(WIRE), withoutExtension(VIEW), withoutExtension(SESSION)])],
  [VIEW, new Set(['react', 'next/link', withoutExtension(WIRE)])],
  [SESSION, new Set(['react'])],
]);

function parse(text: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function dependencies(text: string, file: string): string[] {
  const found: string[] = [];
  const add = (node: ts.Node | undefined): void => {
    found.push(node && ts.isStringLiteralLike(node) ? node.text : '<computed dependency>');
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node)) add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
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
  return withoutExtension(path.posix.normalize(normalized.startsWith('@/') ? normalized.slice(2)
    : normalized.startsWith('.') ? path.posix.join(path.posix.dirname(file), normalized) : normalized));
}

function importViolations(file: string, text: string): string[] {
  return dependencies(text, file).filter((dependency) => !allowed.get(file)?.has(target(file, dependency)))
    .map((dependency) => `${file} -> ${dependency}`);
}

function closureViolations(file: string, read: (file: string) => string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const text = read(file);
  const violations = importViolations(file, text);
  for (const dependency of dependencies(text, file)) {
    const next = [...allowed.keys()].find((candidate) => withoutExtension(candidate) === target(file, dependency));
    if (next) violations.push(...closureViolations(next, read, seen));
  }
  return violations;
}

function productionFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? productionFiles(absolute)
      : EXTENSION.test(entry.name) && !TEST.test(entry.name) ? [absolute] : [];
  });
}

const READINESS = new Set(['specification_complete', 'blocked_structural', 'requires_operator_decision']);
const CLASSIFICATIONS = new Set(['RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY']);

// These are AST checks, not a prose blacklist: explanatory notices may contain
// words such as execution, task, digest, and authority without adding behavior.
function behaviorViolations(text: string, file: string): string[] {
  const ast = parse(text, file);
  const violations: string[] = [];
  const tainted = new Set(['classification', 'effectiveClassification', 'originalClassification']);
  const contains = (node: ts.Node, predicate: (node: ts.Node) => boolean): boolean => {
    if (predicate(node)) return true;
    return ts.forEachChild(node, (child) => contains(child, predicate) || undefined) === true;
  };
  const classification = (node: ts.Node): boolean => contains(node, (child) =>
    (ts.isIdentifier(child) && tainted.has(child.text))
    || (ts.isStringLiteralLike(child) && /^(effective|original)Classification$/.test(child.text)));
  // Follow local aliases, including destructuring, before inspecting control flow.
  let changed = true;
  while (changed) {
    changed = false;
    const alias = (node: ts.Node): void => {
      if (ts.isBindingElement(node) && node.propertyName && classification(node.propertyName)
        && ts.isIdentifier(node.name) && !tainted.has(node.name.text)) {
        tainted.add(node.name.text); changed = true;
      }
      if (ts.isVariableDeclaration(node) && node.initializer && classification(node.initializer)) {
        const names: string[] = [];
        const collect = (name: ts.Node): void => {
          if (ts.isIdentifier(name)) names.push(name.text);
          else ts.forEachChild(name, collect);
        };
        collect(node.name);
        for (const name of names) if (!tainted.has(name)) { tainted.add(name); changed = true; }
      }
      ts.forEachChild(node, alias);
    };
    alias(ast);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && new Set(['crypto', 'localStorage', 'sessionStorage', 'indexedDB',
      'XMLHttpRequest', 'WebSocket', 'eval', 'Function', 'process', 'globalThis', 'window', 'document', 'navigator']).has(node.text)) {
      violations.push(`forbidden runtime ${node.text}`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /^(trim|transform|preprocess|default|catch|passthrough|strip)$/.test(node.expression.name.text)
      && file === WIRE) violations.push(`transforming wire schema ${node.expression.name.text}`);
    if (file === WIRE && ts.isPropertyAccessExpression(node) && node.name.text === 'coerce') violations.push('wire coercion');
    if (ts.isCallExpression(node) && /(?:createHash|canonicalize|buildWorkflowImplementationPlan|resolveEffectiveReviewedSpecification|readWorkflowReviewPacket|computeReadiness|deriveReadiness)/i.test(node.expression.getText(ast))) {
      violations.push('business logic or reconstruction call');
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /^(insert|upsert|update|delete|rpc|mutate|sendBeacon|setItem|removeItem|digest)$/.test(node.expression.name.text)) violations.push('mutation or digest call');
    if (ts.isPropertyAssignment(node) && node.name.getText(ast).replace(/['"]/g, '') === 'method'
      && (!ts.isStringLiteralLike(node.initializer) || node.initializer.text !== 'GET')) violations.push('non-GET method');
    if (file === WIRE && ts.isIdentifier(node) && ['fetch', 'window', 'document', 'Date', 'Math', 'navigator'].includes(node.text)) violations.push('wire IO');
    if (UI.includes(file)) {
      const condition = ts.isIfStatement(node) ? node.expression : ts.isConditionalExpression(node) ? node.condition
        : ts.isSwitchStatement(node) ? node.expression : undefined;
      if (condition && classification(condition)) violations.push('classification-derived control flow');
      if (ts.isElementAccessExpression(node) && classification(node.argumentExpression)) violations.push('classification-derived lookup');
      if (ts.isObjectLiteralExpression(node) && node.properties.some((property) => ts.isPropertyAssignment(property)
        && ['implementationReadiness', 'effectiveSpecification', 'plannedSteps', 'rejectedSteps'].includes(property.name.getText(ast).replace(/['"]/g, '')))) {
        violations.push('artifact or readiness construction');
      }
      if (ts.isObjectLiteralExpression(node) && node.properties.some((property) => ts.isPropertyAssignment(property)
        && property.name.getText(ast).replace(/['"]/g, '') === 'state'
        && ts.isStringLiteralLike(property.initializer) && READINESS.has(property.initializer.text))) violations.push('readiness construction');
      if (ts.isObjectLiteralExpression(node) && node.properties.some((property) => property.name && CLASSIFICATIONS.has(property.name.getText(ast).replace(/['"]/g, '')))
        && contains(node, (child) => ts.isStringLiteralLike(child) && READINESS.has(child.text))) violations.push('classification readiness mapping');
      if (ts.isJsxElement(node) && /^(button|a|Button|Link)$/.test(node.openingElement.tagName.getText(ast))) {
        const label = node.children.filter(ts.isJsxText).map((child) => child.text).join(' ').trim();
        if (/^(Run|Execute|Deploy|Activate|Publish|Generate Codex Prompt|Create Rule|Create Task|Apply|Implement)(\s|$)/i.test(label)) violations.push('execution control');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
}

describe('implementation plan browser wire and display-only boundaries', () => {
  it('keeps the wire dependency exactly zod and the complete named UI closure safe', () => {
    const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');
    expect(dependencies(read(WIRE), WIRE)).toEqual(['zod']);
    for (const file of [WIRE, ...UI, SESSION]) {
      expect(closureViolations(file, read), file).toEqual([]);
      expect(behaviorViolations(read(file), file), file).toEqual([]);
    }
  });

  it('allows wire imports only from exact named display and pure foundation consumers', () => {
    const violations: string[] = [];
    for (const absolute of ['app', 'components', 'lib', 'types', 'scripts'].flatMap((root) => productionFiles(path.join(ROOT, root)))) {
      const file = path.relative(ROOT, absolute).replaceAll('\\', '/');
      const text = readFileSync(absolute, 'utf8');
      for (const dependency of dependencies(text, file)) {
        if (target(file, dependency) === withoutExtension(WIRE) && !WIRE_CONSUMERS.has(file)) violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  }, 30_000);

  it('does not expand the pure foundation exception to sibling or server consumers', () => {
    expect([...WIRE_CONSUMERS]).toEqual([...UI, 'lib/repositoryPlanFoundation.ts']);
    for (const file of ['lib/repositoryPlanFoundationOther.ts', 'lib/server/repositoryPlanFoundation.ts',
      'app/api/repository-plan/route.ts']) expect(WIRE_CONSUMERS.has(file)).toBe(false);
  });

  it.each([
    "import { x } from '@/lib/workflowImplementationPlan';",
    "import type { X } from '@/lib/workflowEffectiveReviewedSpecification';",
    "export * from '../../lib/server/workflowImplementationPlanRead';",
    "type X = import('@/lib/server/workflowEffectiveReviewedSpecificationRead').X;",
    "const x = require('@/lib/extraction/domain/hash');",
    "const x = import('@/lib/x/../workflowImplementationPlan');",
    "import x = require('@supabase/supabase-js');",
    "import { x } from '@/lib/\\u0077orkflowImplementationPlan';",
    "import '@/lib/providers/test';",
    "import(name);",
    "require(name);",
  ])('rejects forbidden dependencies including bypass forms: %s', (source) => {
    expect(importViolations(CLIENT, source)).not.toEqual([]);
  });

  it('rejects indirect dependency escape through an otherwise permitted local module', () => {
    const sources: Record<string, string> = {
      [CLIENT]: "import View from './WorkflowImplementationPlanView';",
      [VIEW]: "export * from '@/lib/workflowImplementationPlan';",
    };
    expect(closureViolations(CLIENT, (file) => sources[file])).not.toEqual([]);
  });

  it.each([
    "const readiness = step.effectiveClassification === 'RULE' ? 'blocked_structural' : 'specification_complete';",
    "const kind = step.effectiveClassification; const state = states[kind];",
    "const { effectiveClassification: kind } = step; const state = states[kind];",
    "switch (step.effectiveClassification) { case 'RULE': return 'blocked_structural'; }",
    "const states = { RULE: 'blocked_structural', VERIFY: 'specification_complete' };",
    "const readiness = { state: 'specification_complete' };",
    "const plan = { ...source, plannedSteps: [] };",
    "crypto.subtle.digest('SHA-256', input);",
    "fetch(url, { method: 'POST' });",
    "localStorage.setItem('plan', value);",
    '<button onClick={run}>Run</button>',
  ])('rejects browser business logic and side effects: %s', (source) => {
    expect(behaviorViolations(source, CLIENT)).not.toEqual([]);
  });

  it.each(['z.object({}).passthrough()', 'z.string().trim()', 'z.coerce.number()', 'z.object({}).strip()',
    'z.string().transform(fn)', 'z.string().default("")', 'fetch(url)'])('rejects transforming or impure wire code: %s', (source) => {
    expect(behaviorViolations(source, WIRE)).not.toEqual([]);
  });

  it('permits literal display of received readiness and explanatory non-authority prose', () => {
    expect(behaviorViolations('const view = <p>Not executable. Does not grant execution authority. Specification complete does not authorize execution.</p>; const state = step.implementationReadiness.state;', VIEW)).toEqual([]);
    expect(importViolations(CLIENT, '// import x from "@/lib/workflowImplementationPlan";')).toEqual([]);
  });
});
