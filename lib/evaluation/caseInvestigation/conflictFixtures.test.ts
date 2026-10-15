import { describe, expect, it } from 'vitest';

import { readInvestigationContext } from '@/lib/server/investigationContextRead';

import {
  buildConflictFixtureProject,
  CONFLICT_FIXTURE_PROJECTS,
  CONFLICT_RULES,
  FIXTURE_ORGANIZATION_ID,
} from './conflictFixtures';
import { memoryReadClient, ReadOnlyViolation, readOnlyClient } from './readClients';

const approveTextExcerpts = async (_admin: never, params: { contentClasses: readonly string[] }) =>
  ({ approved: params.contentClasses.every((contentClass) => contentClass === 'text_excerpts') }) as never;

describe('Case Investigation conflict fixtures (contract v2)', () => {
  const built = CONFLICT_FIXTURE_PROJECTS.map(buildConflictFixtureProject);
  const conflictFindings = built.flatMap((project) => project.findings
    .filter((finding) => (CONFLICT_RULES as readonly string[]).includes(finding.rule_id))
    .map((finding) => ({ project, finding })));

  it('the real canonical path yields at least 20 conflict findings across all three rules', () => {
    const byRule = new Map<string, number>();
    for (const { finding } of conflictFindings) byRule.set(finding.rule_id, (byRule.get(finding.rule_id) ?? 0) + 1);
    expect(Object.fromEntries(byRule)).toMatchInlineSnapshot(`
      {
        "CANONICAL_GOVERNING_RELATIONSHIP_CONFLICTING": 12,
        "CANONICAL_INVOICE_IDENTITY_CONFLICT": 7,
        "TRANSACTION_TICKET_GRAIN_CONFLICT": 11,
      }
    `);
    expect(conflictFindings.length).toBeGreaterThanOrEqual(20);
    for (const rule of CONFLICT_RULES) expect(byRule.get(rule) ?? 0).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const again = CONFLICT_FIXTURE_PROJECTS.map(buildConflictFixtureProject);
    expect(again.map((project) => project.findings.map((finding) => finding.id)))
      .toEqual(built.map((project) => project.findings.map((finding) => finding.id)));
  });

  it('every conflict case reaches the live context read with transmitted text', async () => {
    for (const { project, finding } of conflictFindings) {
      const result = await readInvestigationContext(
        { organizationId: FIXTURE_ORGANIZATION_ID, projectId: project.projectId, caseId: `finding:${finding.id}`,
          purpose: 'provider_investigation' },
        { admin: memoryReadClient(project.tables) as never, forgewingEnabled: true, resolveDataPolicy: approveTextExcerpts },
      );
      expect(result.status, finding.rule_id).toBe('ok');
      if (result.status !== 'ok') continue;
      expect(result.resolutionCase.kind).toBe('validator_finding');
      expect(result.context.slices.some((slice) => slice.kind === 'case_evidence' && slice.transmitted)).toBe(true);
    }
  });

  it('the read-only client never reaches a write or an RPC', () => {
    const client = readOnlyClient({ from: () => ({ select: () => 'ok', insert: () => 'wrote' }), rpc: () => 'called' } as never) as never as {
      from: (table: string) => Record<string, () => unknown>; rpc: () => unknown;
    };
    expect(client.from('documents').select()).toBe('ok');
    expect(() => client.from('documents').insert()).toThrow(ReadOnlyViolation);
    expect(() => client.rpc()).toThrow(ReadOnlyViolation);
    const memory = memoryReadClient({ documents: [] }) as never as { from: (table: string) => { select: () => Record<string, () => unknown> } };
    expect(() => memory.from('documents').select().upsert()).toThrow(ReadOnlyViolation);
  });
});
