import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { classifyOperatorIntent, planProjectContext, questionConcernsTransactions } from '@/lib/projectIntelligence/contextPlan';
import type { OperatorRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';

import { GUIDANCE_V2_FLOORS_ALLOWED_TO_CHANGE } from '@/scripts/evaluation/operator-guidance/contract';
import { GUIDANCE_RUN_CASES, QUALIFICATION_CASES } from '@/scripts/evaluation/operator-guidance/corpus';
import { materializeCase } from '@/scripts/evaluation/operator-guidance/harness';

/**
 * v3 corrects defects, and everything else must stay what was frozen. This compares every
 * request and floor with the sealed v1 and v2 freezes: before v3's corrections each request
 * is byte for byte what they froze, and each floor is too, but for the one link v3 fixes.
 */

type FrozenRequest = { caseId: string; bodySha256: string; floorDigest: string; contextTransmittedDigest: string };

const frozen = JSON.parse(readFileSync('scripts/evaluation/artifacts/operator-guidance-v1/freeze.json', 'utf8')) as { requests: FrozenRequest[] };
const frozenV2 = JSON.parse(readFileSync('scripts/evaluation/artifacts/operator-guidance-v2/freeze.json', 'utf8')) as { requests: FrozenRequest[] };
const { records } = JSON.parse(readFileSync('scripts/evaluation/artifacts/operator-guidance-v2/run/records.json', 'utf8')) as { records: { caseId: string; floor: OperatorRecommendation }[] };

describe('main still sends what the qualification froze', () => {
  it('v2 froze exactly what v1 froze', () => {
    expect(frozenV2.requests).toEqual(frozen.requests);
  });

  it('covers every frozen case', () => {
    expect(frozen.requests.map((entry) => entry.caseId).sort()).toEqual(QUALIFICATION_CASES.map((item) => item.caseId).sort());
    expect(frozen.requests).toHaveLength(24);
  });

  it.each(QUALIFICATION_CASES.map((item) => [item.caseId, item] as const))('%s, before the v3 corrections', async (caseId, item) => {
    const expected = frozen.requests.find((entry) => entry.caseId === caseId)!;
    const built = await materializeCase(item);
    expect(createHash('sha256').update(JSON.stringify(built.sourceRequest)).digest('hex')).toBe(expected.bodySha256);
    expect(built.approvedContext.transmittedDigest).toBe(expected.contextTransmittedDigest);
  });

  it.each(QUALIFICATION_CASES.map((item) => [item.caseId, item] as const))('%s floor differs from v2 only where v3 fixes its link', async (caseId, item) => {
    const expected = frozen.requests.find((entry) => entry.caseId === caseId)!;
    const built = await materializeCase(item);
    const v2Floor = records.find((record) => record.caseId === caseId)!.floor;
    expect(hashCanonical(v2Floor)).toBe(expected.floorDigest);
    if (GUIDANCE_V2_FLOORS_ALLOWED_TO_CHANGE.includes(caseId)) {
      expect(built.floor.recommendedNextStep.actionHref).not.toBe(v2Floor.recommendedNextStep.actionHref);
      expect({ ...built.floor, recommendedNextStep: { ...built.floor.recommendedNextStep, actionHref: v2Floor.recommendedNextStep.actionHref } }).toEqual(v2Floor);
    } else {
      expect(built.floor).toEqual(v2Floor);
    }
  });

  it.each(['document-03', 'document-05'])('%s now opens the source it tells the operator to review', async (caseId) => {
    const built = await materializeCase(QUALIFICATION_CASES.find((item) => item.caseId === caseId)!);
    expect(built.floor.recommendedNextStep.actionHref).toBe(`/platform/documents/${built.symbols['doc:sheet']}`);
  });

  it.each(GUIDANCE_RUN_CASES.map((item) => [item.question] as const))('never plans ticket data for %s', (question) => {
    expect(questionConcernsTransactions(question)).toBe(false);
    const classified = classifyOperatorIntent(question, { hasFocusFinding: true })!;
    expect(planProjectContext(classified.intent, { question }).sections).not.toContain('transaction_context');
  });
});
