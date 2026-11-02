import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { classifyOperatorIntent, planProjectContext, questionConcernsTransactions } from '@/lib/projectIntelligence/contextPlan';

import { QUALIFICATION_CASES } from '@/scripts/evaluation/operator-guidance/corpus';
import { materializeCase } from '@/scripts/evaluation/operator-guidance/harness';

/**
 * The paid qualification runs from its frozen commit, and `main` has moved past
 * it. Its result only describes `main` while `main` still sends what was frozen.
 * This compares every request and floor with the sealed freeze, byte for byte.
 */

type FrozenRequest = { caseId: string; bodySha256: string; floorDigest: string; contextTransmittedDigest: string };

const frozen = JSON.parse(readFileSync('scripts/evaluation/artifacts/operator-guidance-v1/freeze.json', 'utf8')) as { requests: FrozenRequest[] };

describe('main still sends what the qualification froze', () => {
  it('covers every frozen case', () => {
    expect(frozen.requests.map((entry) => entry.caseId).sort()).toEqual(QUALIFICATION_CASES.map((item) => item.caseId).sort());
    expect(frozen.requests).toHaveLength(24);
  });

  it.each(QUALIFICATION_CASES.map((item) => [item.caseId, item] as const))('%s', async (caseId, item) => {
    const expected = frozen.requests.find((entry) => entry.caseId === caseId)!;
    const built = await materializeCase(item);
    expect(createHash('sha256').update(JSON.stringify(built.request)).digest('hex')).toBe(expected.bodySha256);
    expect(hashCanonical(built.floor)).toBe(expected.floorDigest);
    expect(built.approvedContext.transmittedDigest).toBe(expected.contextTransmittedDigest);
  });

  it.each(QUALIFICATION_CASES.map((item) => [item.question] as const))('never plans ticket data for %s', (question) => {
    expect(questionConcernsTransactions(question)).toBe(false);
    const classified = classifyOperatorIntent(question, { hasFocusFinding: true })!;
    expect(planProjectContext(classified.intent, { question }).sections).not.toContain('transaction_context');
  });
});
