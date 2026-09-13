import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const ENTRY_POINTS = [
  'app/api/internal/document-diagnostics/route.ts',
  'components/documents/DiagnosticsPanel.tsx',
  'lib/server/documentDiagnosticsRead.ts',
];
const PROVIDER_TERMS = [
  '@anthropic-ai/sdk', '@/lib/forgewing/runtime/client', '@/lib/server/ai/claudeClient',
  'callClaudeFor', 'runRecoveryCandidateV2Recommendation',
  'runForgewingPricingRateClusterRecovery',
];

function source(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

function resolveLocalImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? path.join(ROOT, specifier.slice(2))
    : specifier.startsWith('.') ? path.resolve(path.dirname(path.join(ROOT, from)), specifier) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'),
    path.join(base, 'index.tsx')]) {
    if (existsSync(candidate)) return path.relative(ROOT, candidate).split(path.sep).join('/');
  }
  return null;
}

function importClosure(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length) {
    const relative = pending.pop()!;
    if (seen.has(relative) || !existsSync(path.join(ROOT, relative))) continue;
    seen.add(relative);
    const text = source(relative);
    for (const match of text.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
      const resolved = resolveLocalImport(relative, match[2]!);
      if (resolved && !seen.has(resolved)) pending.push(resolved);
    }
  }
  return [...seen].sort();
}

describe('diagnostics architecture boundaries', () => {
  it('keeps diagnostics routes and surfaces provider-free through transitive local imports', () => {
    const closure = importClosure(ENTRY_POINTS);
    const offenders = closure.flatMap((relative) => PROVIDER_TERMS.flatMap((term) =>
      source(relative).includes(term) ? [`${relative} -> ${term}`] : []));
    expect(offenders).toEqual([]);
  });

  it('keeps diagnostic projections outside canonical truth and validator approval semantics', () => {
    for (const relative of [
      'lib/diagnostics/failureDiagnostic.ts', 'lib/diagnostics/failureRegistry.ts',
      'lib/diagnostics/diagnosticIdentity.ts', 'lib/server/documentDiagnosticsRead.ts',
    ]) {
      const text = source(relative);
      expect(text, relative).not.toMatch(/from ['"]@\/lib\/(?:canonical|contracts|validator|projectFacts|truthQuery|effectiveFacts)/);
      expect(text, relative).not.toContain('findingSemantics');
      expect(text, relative).not.toContain('countApprovalBlockers');
      expect(text, relative).not.toContain('isApprovalBlocker');
    }
  });

  it('does not let diagnostics apply recovery or generate a proposal', () => {
    for (const relative of ENTRY_POINTS) {
      const text = source(relative);
      expect(text, relative).not.toContain('recordForgewingRecoveryProposalReview');
      expect(text, relative).not.toContain('persistForgewingRecoveryProposal');
      expect(text, relative).not.toContain('confirmedRecoveryCandidates');
      expect(text, relative).not.toContain('/api/documents/process');
    }
    const panel = source('components/documents/DiagnosticsPanel.tsx');
    expect(panel).not.toMatch(/Confirm and authorize|Reject|Defer|Reprocess document/);
    expect(panel).toContain('Open existing recovery review');
  });

  it('accepts only server-resolved document and diagnostic identity from the browser', () => {
    const route = source('app/api/internal/document-diagnostics/route.ts');
    const schema = route.match(/const querySchema = z\.object\(\{([\s\S]*?)\}\)\.strict\(\)/)?.[1] ?? '';
    expect(schema).toContain('documentId:');
    expect(schema).toContain('diagnosticId:');
    for (const forbidden of ['organizationId:', 'candidateId:', 'observationId:', 'boundingBox:',
      'pageRepresentationDigest:', 'severity:', 'recoverability:']) {
      expect(schema, forbidden).not.toContain(forbidden);
    }
    expect(route).toContain('.strict()');
  });

  it('reuses the Phase 14 viewer and sole geometry converter', () => {
    const panel = source('components/documents/DiagnosticsPanel.tsx');
    expect(panel).toContain("from '@/components/recovery/SourceEvidencePage'");
    expect(panel).not.toContain('toViewportRect');
    expect(source('components/recovery/SourceEvidencePage.tsx'))
      .toContain("from '@/lib/recovery/sourceGeometry'");
  });

  it('mounts beside the existing recovery review without duplicating its controls', () => {
    const page = source('app/platform/documents/[id]/page.tsx');
    expect(page).toMatch(/<RecoveryReviewPanel[^>]*\/>\s*<DiagnosticsPanel/);
  });
});
