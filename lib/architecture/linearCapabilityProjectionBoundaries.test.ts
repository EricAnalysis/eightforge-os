import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CONTRACT = 'lib/linearCapabilityProjection.ts';
const EXTENSION = /\.[cm]?[jt]sx?$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function parse(text: string, file = CONTRACT): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function dependencies(text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) {
      found.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(text));
  return found;
}

function purityViolations(text: string): string[] {
  const forbidden = new Set(['Date', 'Math', 'fetch', 'process', 'globalThis', 'window', 'document',
    'navigator', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval', 'performance', 'eval',
    'Function', 'require']);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) && forbidden.has(node.text))
      || node.kind === ts.SyntaxKind.ImportKeyword) found.push(node.getText());
    ts.forEachChild(node, visit);
  };
  visit(parse(text));
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

describe('Linear projection remains a pure one-way contract with no consumers', () => {
  const source = readFileSync(path.join(ROOT, CONTRACT), 'utf8');

  it('has only the exact approved-request, path, canonical hash, and schema dependencies', () => {
    expect(dependencies(source).sort()).toEqual([
      'zod', '@/lib/approvedEngineeringRequest', '@/lib/extraction/domain/hash',
      '@/lib/repositoryPlanEvidence',
    ].sort());
    expect(purityViolations(source)).toEqual([]);
  });

  it('has no Linear runtime, persistence, provider, Git, intake, execution, or inbound authority surface', () => {
    expect(source).not.toMatch(/@linear|LinearClient|fetch\s*\(|process\.env|supabase|\.rpc\s*\(|\.from\s*\(/);
    expect(source).not.toMatch(/workflowIntake|sourceSubmissionId|rawProvider|rawOutput|operatorDecisionSuggestion/);
    expect(source).not.toMatch(/updateIssue|getStatus|readComments|readDescription|readLabels|webhook|syncIssue/);
    expect(source).not.toMatch(/child_process|execFile|spawn\s*\(|gitHub|openCodex|codeExecution/);
    expect(source).toContain("linearAuthority: z.literal('none')");
    expect(source).toContain("projectionDirection: z.literal('eightforge_to_linear_only')");
  });

  it('allows only the separately reviewed B4-L2 delivery runtime to consume the contract', () => {
    const consumers = ['app', 'components', 'lib', 'types', 'scripts']
      .flatMap((root) => productionFiles(path.join(ROOT, root)))
      .flatMap((absolute) => {
        const relative = path.relative(ROOT, absolute).replaceAll('\\', '/');
        if (relative === CONTRACT) return [];
        return dependencies(readFileSync(absolute, 'utf8')).some((specifier) =>
          specifier.replaceAll('\\', '/').replace(/^@\//, '')
            .replace(EXTENSION, '') === 'lib/linearCapabilityProjection') ? [relative] : [];
      });
    expect(consumers).toEqual([
      'lib/server/linearClient.ts',
      'lib/server/linearProjectionDelivery.ts',
    ]);
  }, 30_000);

  it.each([
    'Date.now()', 'Math.random()', 'fetch(url)', 'process.env.LINEAR_API_KEY',
    "import('@linear/sdk')", "require('@/lib/server/supabaseAdmin')", 'window.location.href',
  ])('detects an impure runtime escape: %s', (probe) => {
    expect(purityViolations(`${source}\n${probe}`)).not.toEqual([]);
  });
});
