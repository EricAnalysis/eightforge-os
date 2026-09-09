import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const ENTRY = 'scripts/workers/repository-plan-worker.ts';
const WORKER = 'lib/server/repositoryPlanGenerationWorker.ts';
const ROUTE = 'app/api/internal/repository-plan-runs/route.ts';
const READ_ROUTE = 'app/api/internal/repository-plan-runs/[jobId]/route.ts';
const SERVICE = 'lib/server/workflowRepositoryPlanRuns.ts';
const CURRENT_SNAPSHOT = 'lib/server/repositoryPlanCurrentSnapshot.ts';
const EXTENSION = /\.[cm]?[jt]sx?$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const strip = (value: string): string => value.replace(EXTENSION, '');

function productionFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? productionFiles(absolute)
      : EXTENSION.test(entry.name) && !TEST.test(entry.name) ? [absolute] : [];
  });
}

function dependencies(file: string, text: string): string[] {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const add = (node: ts.Node | undefined): void => {
    found.push(node && ts.isStringLiteralLike(node) ? node.text : '<computed>');
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node)) add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found.map((specifier) => strip(path.posix.normalize(specifier.startsWith('@/') ? specifier.slice(2)
    : specifier.startsWith('.') ? path.posix.join(path.posix.dirname(file), specifier) : specifier))).sort();
}

const expected = new Map<string, string[]>([
  [ENTRY, ['lib/server/repositoryPlanGenerationWorker', 'lib/server/repositoryPlanWorkerConfig']],
  [WORKER, [
    'lib/forgewing/tasks/repositoryPlanGuidance', 'lib/repositoryPlanFoundation', 'lib/repositoryPlanGuidance',
    'lib/server/forgewingEngineeringWorkerClient', 'lib/server/repositoryPlanContentCollector',
    'lib/server/repositoryPlanCurrentSnapshot', 'lib/server/repositoryPlanEvidenceCatalogLoader',
    'lib/server/repositoryPlanGenerationJobs', 'lib/server/workflowRepositoryPlanPersistence',
    'lib/workflowEffectiveReviewedSpecification', 'lib/workflowImplementationPlan',
  ]],
  [ROUTE, ['lib/repositoryPlanRunWire', 'lib/server/getActorContext',
    'lib/server/workflowPlatformReviewAccess', 'lib/server/workflowRepositoryPlanRuns']],
  [READ_ROUTE, ['lib/repositoryPlanRunWire', 'lib/server/getActorContext',
    'lib/server/workflowPlatformReviewAccess', 'lib/server/workflowRepositoryPlanRuns']],
  [SERVICE, ['lib/repositoryPlanRunWire', 'lib/server/repositoryPlanGenerationJobs', 'lib/server/supabaseAdmin',
    'lib/workflowEffectiveReviewedSpecification', 'lib/workflowImplementationPlan']],
  [CURRENT_SNAPSHOT, ['node:child_process', 'lib/server/repositoryPlanSnapshot']],
]);

describe('production repository reasoning boundaries', () => {
  it('pins the complete route, service, worker, and entry dependency graph', () => {
    for (const [file, allowed] of expected) {
      expect(dependencies(file, readFileSync(path.join(ROOT, file), 'utf8')), file)
        .toEqual([...allowed].sort());
    }
  });

  it('keeps repository, provider, persistence, and worker credentials out of control-plane routes', () => {
    for (const file of [ROUTE, READ_ROUTE, SERVICE]) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      expect(text, file).not.toMatch(/FORGEWING_REPOSITORY_ROOT|ANTHROPIC_API_KEY|SUPABASE_SERVICE_ROLE_KEY|collectCommittedContent|runForgewingRepositoryPlanGuidance|recordWorkflowRepositoryPlanV2|claimRepositoryPlanGenerationJob|Linear/i);
    }
  });

  it('keeps worker orchestration read-only and separated from review, Linear, deployment, and repository mutation', () => {
    const text = readFileSync(path.join(ROOT, WORKER), 'utf8');
    expect(text).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|linear|engineeringReview|approvedEngineeringRequest|deploy|migration/i);
    expect(text).not.toMatch(/\b(?:writeFile|appendFile|truncate|rename|unlink|mkdir|rm|rmdir)Sync?\b/);
    expect(text).not.toMatch(/\bgit\s+(?:add|commit|push|merge|checkout|reset|restore|clean|stash)\b/i);
    expect(text).not.toMatch(/from\s+['"](?:node:fs|fs)['"]/);
  });

  it('pins worker-owned HEAD derivation to one read-only no-shell Git invocation', () => {
    const text = readFileSync(path.join(ROOT, CURRENT_SNAPSHOT), 'utf8');
    expect(text.match(/execFileSync\(/g)).toHaveLength(1);
    expect(text).toContain("'rev-parse', '--verify', 'HEAD^{commit}'");
    expect(text).toContain("GIT_NO_REPLACE_OBJECTS: '1'");
    expect(text).toContain("GIT_NO_LAZY_FETCH: '1'");
    expect(text).toContain('shell: false');
    expect(text).not.toMatch(/['"](?:fetch|pull|clone|checkout|reset|restore|add|commit|push|merge|clean|stash)['"]/i);
  });

  it('allows the orchestration contract only from the exact worker entry', () => {
    const consumers = ['app', 'components', 'lib', 'types', 'scripts', 'pages', 'src']
      .flatMap((root) => productionFiles(path.join(ROOT, root))).flatMap((absolute) => {
        const file = path.relative(ROOT, absolute).replaceAll('\\', '/');
        return dependencies(file, readFileSync(absolute, 'utf8')).includes(strip(WORKER)) ? [file] : [];
      });
    expect(consumers).toEqual([ENTRY]);
  }, 30_000);

  it('rejects a temporary unauthorized production consumer by exact filename', () => {
    const fake = 'app/api/unauthorized-repository-plan/route.ts';
    const violations = dependencies(fake,
      "import { runOneRepositoryPlanGenerationJob } from '@/lib/server/repositoryPlanGenerationWorker';")
      .includes(strip(WORKER)) ? [fake] : [];
    expect(violations).toEqual([fake]);
    expect(violations).not.toEqual([]);
  });
});
