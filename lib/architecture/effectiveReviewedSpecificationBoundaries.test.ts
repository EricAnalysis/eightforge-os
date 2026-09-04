import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CORE = 'lib/workflowEffectiveReviewedSpecification.ts';
const READ = 'lib/server/workflowEffectiveReviewedSpecificationRead.ts';
const PLAN = 'lib/workflowImplementationPlan.ts';
const READ_CONSUMERS = new Set(['lib/server/workflowImplementationPlanRead.ts']);
const EXTENSION = /\.[cm]?[jt]sx?$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;

function source(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

// The repository's existing AST scanner is private to another test suite.
// Keep this extractor local: importing that suite would run unrelated tests.
function imports(text: string, file: string, runtimeOnly = false): string[] {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (runtimeOnly && ts.isImportDeclaration(node) && node.importClause
        && (node.importClause.isTypeOnly || (!node.importClause.name
          && node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
          && node.importClause.namedBindings.elements.length > 0
          && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)))) return;
      found.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) {
      if (runtimeOnly) return;
      found.push(node.argument.literal.text);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      found.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function target(file: string, specifier: string): string {
  const normalized = specifier.replaceAll('\\', '/');
  const resolved = normalized.startsWith('@/') ? normalized.slice(2)
    : normalized.startsWith('.') ? path.posix.join(path.posix.dirname(file), normalized)
      : normalized;
  return path.posix.normalize(resolved).replace(EXTENSION, '');
}

function consumerViolations(file: string, text: string): string[] {
  return imports(text, file).flatMap((specifier) => {
    const resolved = target(file, specifier);
    if (file === PLAN && resolved === CORE.replace(EXTENSION, '')
      && !imports(text, file, true).some((runtime) => target(file, runtime) === resolved)) return [];
    return (resolved === READ.replace(EXTENSION, '') && !READ_CONSUMERS.has(file))
      || (resolved === CORE.replace(EXTENSION, '') && file !== READ)
      ? [`${file} -> ${specifier}`] : [];
  });
}

function productionFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(absolute);
    return EXTENSION.test(entry.name) && !TEST.test(entry.name) ? [absolute] : [];
  });
}

function code(file: string): string {
  const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
  return ts.createPrinter({ removeComments: true }).printFile(ast);
}

describe('effective reviewed specification remains a read-only non-authority artifact', () => {
  it.each([
    [CORE, ['zod', '@/lib/workflowAssessmentProposalClosure',
      '@/lib/workflowReviewedSpecification', '@/lib/extraction/domain/hash']],
    [READ, ['@/lib/workflowEffectiveReviewedSpecification', '@/lib/server/supabaseAdmin',
      '@/lib/server/getActorContext', '@/lib/server/workflowPlatformReviewAccess']],
  ] as const)('%s retains its exact dependency boundary', (file, dependencies) => {
    expect(imports(source(file), file).sort()).toEqual([...dependencies].sort());
    // No computed imports can conceal dependencies from the literal AST list.
    expect(code(file)).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
  });

  it('has exactly the resolver read seam as core consumer and the plan read seam as read consumer', () => {
    expect([...READ_CONSUMERS]).toEqual(['lib/server/workflowImplementationPlanRead.ts']);
    const violations: string[] = [];
    const coreConsumers: string[] = [];
    const readConsumers: string[] = [];
    for (const absolute of ['app', 'components', 'lib', 'types', 'scripts']
      .flatMap((root) => productionFiles(path.join(ROOT, root)))) {
      const file = path.relative(ROOT, absolute).replaceAll('\\', '/');
      const text = readFileSync(absolute, 'utf8');
      // Avoid parsing thousands of unrelated modules. Every protected literal
      // import contains this basename; AST parsing still ignores comments.
      if (!text.includes('workflowEffectiveReviewedSpecification')
        && !/\\[ux]/.test(text)) continue;
      violations.push(...consumerViolations(file, text));
      if (imports(text, file, true).some((specifier) =>
        target(file, specifier) === CORE.replace(EXTENSION, ''))) coreConsumers.push(file);
      if (imports(text, file).some((specifier) =>
        target(file, specifier) === READ.replace(EXTENSION, ''))) readConsumers.push(file);
    }
    expect(violations).toEqual([]);
    expect(coreConsumers).toEqual([READ]);
    expect(readConsumers).toEqual(['lib/server/workflowImplementationPlanRead.ts']);
  });

  it('keeps hashing free of runtime state and preserves the narrow shared schema graph', () => {
    expect(code(CORE)).not.toMatch(/\bprocess\s*\.|\bDate\b|Math\.random|\bfetch\s*\(|\beval\s*\(|new\s+Function/);
    expect(imports(source('lib/workflowAssessmentProposalClosure.ts'), 'closure.ts'))
      .toEqual(['@/lib/workflowAssessmentSchema']);
    expect(imports(source('lib/workflowAssessmentSchema.ts'), 'schema.ts')).toEqual(['zod']);
    expect(imports(source('lib/extraction/domain/hash.ts'), 'hash.ts')).toEqual(['node:crypto']);
  });

  it('requires platform authorization and reads no intake or writable/runtime surface', () => {
    const text = code(READ);
    expect(text).toContain('getActorContext');
    expect(text).toContain('resolveWorkflowPlatformReviewAccess');
    expect(text).not.toMatch(/hasProjectAdminRole|resolveWorkflowReviewEligibility|isAllowedInternalOrchestratorOperator/);
    expect(text).not.toMatch(/workflow_intake_submissions|workflowIntakeRead|loadWorkflowIntakeSubmission/);
    expect(text).not.toMatch(/\.(?:insert|upsert|update|delete)\s*\(|\[['"](?:insert|upsert|update|delete)['"]\]\s*\(/);
    expect(text).not.toMatch(/workflow_tasks|lib\/forgewing|lib\/rules|lib\/canonical|lib\/validator|projectFacts|record_workflow|claim_workflow|finalize_workflow/);
    expect(text).not.toMatch(/\.rpc\s*\(/);
    expect([...text.matchAll(/\.from\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]))
      .toEqual(['workflow_assessments', 'workflow_assessment_reviews',
        'workflow_assessment_step_reviews']);
  });

  it('keeps accepted-as-proposed extraction aligned with the SQL projection source contract', () => {
    const tsText = code('lib/workflowAssessmentProposalClosure.ts');
    const migration = source('supabase/migrations/20260904000500_workflow_database_authority_closure.sql');
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.workflow_accepted_proposal_specification');
    const end = migration.indexOf('ALTER FUNCTION public.workflow_accepted_proposal_specification', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const sqlText = migration.slice(start, end);

    expect(tsText).toContain("RULE: ['deterministicRuleProposals', 'ruleId']");
    expect(tsText).toContain("VERIFY: ['verificationRuleProposals', 'ruleId']");
    expect(tsText).toContain("EXTRACT: ['extractionRequirements', 'requirementId']");
    expect(tsText).toContain("RECOVER: ['extractionRequirements', 'requirementId']");
    expect(tsText).toContain("HUMAN: ['humanDecisionPoints', 'decisionId']");
    expect(tsText).toContain("ADVISORY: ['advisorySteps', 'advisoryId']");
    expect(sqlText).toMatch(/WHEN 'RULE' THEN v_collection := 'deterministicRuleProposals'; v_id_key := 'ruleId';/);
    expect(sqlText).toMatch(/WHEN 'VERIFY' THEN v_collection := 'verificationRuleProposals'; v_id_key := 'ruleId';/);
    expect(sqlText).toMatch(/WHEN 'EXTRACT', 'RECOVER' THEN v_collection := 'extractionRequirements'; v_id_key := 'requirementId';/);
    expect(sqlText).toMatch(/WHEN 'HUMAN' THEN v_collection := 'humanDecisionPoints'; v_id_key := 'decisionId';/);
    expect(sqlText).toMatch(/WHEN 'ADVISORY' THEN v_collection := 'advisorySteps'; v_id_key := 'advisoryId';/);

    expect(tsText).toContain("if (step.classification === 'RECOVER')");
    expect(tsText).toContain('forgewingRecoveryTasks');
    expect(tsText).toContain('describedFact: detail.describedFact');
    expect(tsText).toContain('sourceDocument: detail.sourceDocument');
    expect(tsText).toContain('description: task.description');
    expect(tsText).toContain('deterministicShortfall: task.deterministicShortfall');
    expect(sqlText).toContain("FROM jsonb_array_elements(p_assessment -> 'forgewingRecoveryTasks') AS detail");
    expect(sqlText).toContain("'describedFact', v_detail -> 'describedFact'");
    expect(sqlText).toContain("'sourceDocument', v_detail -> 'sourceDocument'");
    expect(sqlText).toContain("'description', v_secondary -> 'description'");
    expect(sqlText).toContain("'deterministicShortfall', v_secondary -> 'deterministicShortfall'");
  });
});

describe('effective reviewed specification consumer guard recognizes import forms', () => {
  it.each([
    ['lib/validator/consumer.ts', "import { x } from '@/lib/workflowEffectiveReviewedSpecification';"],
    ['lib/canonical/consumer.ts', "export { x } from '../workflowEffectiveReviewedSpecification';"],
    ['lib/projectFacts.ts', "type X = import('./workflowEffectiveReviewedSpecification').X;"],
    ['lib/decisions/consumer.ts', "const x = require('../workflowEffectiveReviewedSpecification.js');"],
    ['lib/actions/consumer.ts', "const x = import('@/lib/x/../workflowEffectiveReviewedSpecification');"],
    ['lib/rules/consumer.ts', "import x = require('../workflowEffectiveReviewedSpecification');"],
    ['components/consumer.tsx', "import { x } from '../lib/server/workflowEffectiveReviewedSpecificationRead';"],
    ['app/api/consumer.ts', "export * from '@/lib/server/workflowEffectiveReviewedSpecificationRead.js';"],
    ['lib/validator/escaped.ts', "import { x } from '@/lib/\\u0077orkflowEffectiveReviewedSpecification';"],
  ])('rejects %s without a new authorized consumer decision', (file, text) => {
    expect(consumerViolations(file, text)).toHaveLength(1);
  });

  it('permits only the read seam importing the core and ignores comments', () => {
    expect(consumerViolations('lib/server/workflowImplementationPlanRead.ts',
      "import { readEffectiveReviewedSpecification } from '@/lib/server/workflowEffectiveReviewedSpecificationRead';")).toEqual([]);
    for (const file of ['lib/server/other.ts', 'lib/server/nested/other.ts',
      'app/api/internal/workflow-assessments/[assessmentId]/implementation-plan/route.ts']) {
      expect(consumerViolations(file,
        "import { readEffectiveReviewedSpecification } from '@/lib/server/workflowEffectiveReviewedSpecificationRead';")).toHaveLength(1);
    }
    expect(consumerViolations(READ,
      "import { x } from '@/lib/workflowEffectiveReviewedSpecification';")).toEqual([]);
    expect(consumerViolations('lib/validator/comment.ts',
      "// import { x } from '@/lib/workflowEffectiveReviewedSpecification';")).toEqual([]);
  });

  it('allows only erased resolver type imports in the implementation plan', () => {
    expect(consumerViolations(PLAN,
      "import type { EffectiveReviewedSpecificationArtifact } from '@/lib/workflowEffectiveReviewedSpecification';")).toEqual([]);
    for (const text of [
      "import { resolveEffectiveReviewedSpecification } from '@/lib/workflowEffectiveReviewedSpecification';",
      "import { type EffectiveReviewedSpecificationArtifact, resolveEffectiveReviewedSpecification } from '@/lib/workflowEffectiveReviewedSpecification';",
      "export * from '@/lib/workflowEffectiveReviewedSpecification';",
      "const x = import('@/lib/workflowEffectiveReviewedSpecification');",
      "const x = require('@/lib/workflowEffectiveReviewedSpecification');",
      "import type { X } from '@/lib/server/workflowEffectiveReviewedSpecificationRead';",
    ]) expect(consumerViolations(PLAN, text)).toHaveLength(1);
  });
});
