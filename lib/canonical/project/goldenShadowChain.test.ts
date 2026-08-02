import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import ts from 'typescript';

type GoldenFixtureBoundaryViolation = {
  readonly rule: 'golden_validation_finding' | 'golden_exposure_proof' | 'manual_golden_full_chain';
  readonly file: string;
};

const EVALUATION_TEST_ROOT = 'lib/evaluation/';

function propertyName(node: ts.PropertyName): string | null {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
}

function goldenFixtureBoundaryViolations(file: string, source: string): GoldenFixtureBoundaryViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Set<string>();
  let hasGoldenIdentity = false;
  let hasKnownExposure = false;
  let constructsGoldenFinding = false;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text.replaceAll('\\', '/'));
    }
    if (ts.isStringLiteralLike(node) && /(?:\bGolden Project\b|\bgolden[-_:]project\b|\bgolden[-_:]full[-_:]chain\b)/i.test(node.text)) {
      hasGoldenIdentity = true;
    }
    if (ts.isNumericLiteral(node) && Number(node.text.replaceAll('_', '')) === 302868.6) {
      hasKnownExposure = true;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const projectId = node.properties.find((property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && propertyName(property.name) === 'project_id');
      if (projectId) {
        const initializer = projectId.initializer;
        constructsGoldenFinding ||= (
          ts.isStringLiteralLike(initializer) && /golden/i.test(initializer.text)
        ) || (
          ts.isPropertyAccessExpression(initializer)
          && ts.isIdentifier(initializer.expression)
          && /golden/i.test(initializer.expression.text)
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const importsBuilder = imports.has('@/lib/canonical/project/projectTruthBuilder');
  const importsCanonicalContract = [...imports].some((specifier) => specifier.startsWith('@/lib/canonical/contract/'));
  const importsCanonicalInvoice = [...imports].some((specifier) => specifier.startsWith('@/lib/canonical/invoice/'));
  const importsCanonicalTransaction = [...imports].some((specifier) => specifier.startsWith('@/lib/canonical/transaction/'));
  const importsValidationFinding = imports.has('@/types/validator');
  const violations: GoldenFixtureBoundaryViolation[] = [];

  if (importsValidationFinding && constructsGoldenFinding) {
    violations.push({ rule: 'golden_validation_finding', file });
  }
  if (hasGoldenIdentity && importsBuilder && hasKnownExposure) {
    violations.push({ rule: 'golden_exposure_proof', file });
  }
  if (
    hasGoldenIdentity
    && importsBuilder
    && importsCanonicalContract
    && importsCanonicalInvoice
    && importsCanonicalTransaction
  ) {
    violations.push({ rule: 'manual_golden_full_chain', file });
  }
  return violations;
}

function repositoryTestFiles(root: string): string[] {
  const scanRoots = ['app', 'components', 'lib', 'tests'];
  const visit = (directory: string): string[] => {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
    return readdirSync(directory).flatMap((entry) => {
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        return entry === 'node_modules' || entry === '.next' || entry === 'coverage' ? [] : visit(absolute);
      }
      return /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry) ? [absolute] : [];
    });
  };
  return scanRoots.flatMap((scanRoot) => visit(path.join(root, scanRoot)));
}

describe('Golden full-chain fixture boundary', () => {
  it('keeps real Golden full-chain proof in the evaluation boundary', () => {
    const root = process.cwd();
    const violations = repositoryTestFiles(root)
      .filter((file) => !path.relative(root, file).replaceAll('\\', '/').startsWith(EVALUATION_TEST_ROOT))
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        const candidate = /golden/i.test(source)
          && (/projectTruthBuilder/.test(source) || /project_id/.test(source));
        return candidate
          ? goldenFixtureBoundaryViolations(path.relative(root, file).replaceAll('\\', '/'), source)
          : [];
      });
    assert.deepEqual(violations, []);
  }, 30_000);

  it('detects Golden-linked findings, exposure proof, and manual full-chain assembly together', () => {
    const violations = goldenFixtureBoundaryViolations('lib/example.test.ts', `
      import { adaptAssembledPricingRow } from '@/lib/canonical/contract/pricingAdapter';
      import { adaptInvoiceExtraction } from '@/lib/canonical/invoice/invoiceAdapter';
      import { buildCanonicalProjectTruth } from '@/lib/canonical/project/projectTruthBuilder';
      import { adaptProjectTransactionRow } from '@/lib/canonical/transaction/transactionAdapter';
      import type { ValidationFinding } from '@/types/validator';
      const GOLDEN = { projectId: 'golden-project-fixture', exposure: 302_868.60 };
      const finding: ValidationFinding = { project_id: GOLDEN.projectId } as ValidationFinding;
      buildCanonicalProjectTruth({ projectId: 'Golden Project', finding });
      void adaptAssembledPricingRow; void adaptInvoiceExtraction; void adaptProjectTransactionRow;
    `);
    assert.deepEqual(violations.map(({ rule }) => rule), [
      'golden_validation_finding',
      'golden_exposure_proof',
      'manual_golden_full_chain',
    ]);
  });

  it('allows isolated unit values and generic non-Golden composition', () => {
    const violations = goldenFixtureBoundaryViolations('lib/example.test.ts', `
      import { buildCanonicalProjectTruth } from '@/lib/canonical/project/projectTruthBuilder';
      const isolatedParserValue = 302868.6;
      buildCanonicalProjectTruth({ projectId: 'generic-project', isolatedParserValue });
    `);
    assert.deepEqual(violations, []);
  });
});
