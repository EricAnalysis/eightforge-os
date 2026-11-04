import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { classifyOperatorIntent, planProjectContext, questionConcernsTransactions } from '@/lib/projectIntelligence/contextPlan';
import { BILLED_LINE_SUPPORT_UNCERTAINTY } from '@/lib/projectIntelligence/evidenceAssessment';
import type { OperatorRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';

import { GUIDANCE_CANDIDATE_FREEZE_FILE, GUIDANCE_V2_FLOORS_ALLOWED_TO_CHANGE } from '@/scripts/evaluation/operator-guidance/contract';
import { HELDOUT_CASES, V2_REGRESSION_CASES } from '@/scripts/evaluation/operator-guidance/corpus';
import { materializeCase } from '@/scripts/evaluation/operator-guidance/harness';

/**
 * A result only describes `main` while `main` still sends what was frozen. Before v3's
 * corrections, each of v1 and v2's requests is byte for byte what they froze, but for one
 * added uncertainty, and each floor is too, but for its action link. Each held-out request
 * and floor is what v3's freeze holds.
 */

type FrozenRequest = { caseId: string; bodySha256: string; floorDigest: string; contextTransmittedDigest: string };

const frozen = JSON.parse(readFileSync('scripts/evaluation/artifacts/operator-guidance-v1/freeze.json', 'utf8')) as { requests: FrozenRequest[] };
const frozenV2 = JSON.parse(readFileSync('scripts/evaluation/artifacts/operator-guidance-v2/freeze.json', 'utf8')) as { requests: FrozenRequest[] };
const frozenV3 = JSON.parse(readFileSync(GUIDANCE_CANDIDATE_FREEZE_FILE, 'utf8')) as { requests: FrozenRequest[] };
const withoutAddedUncertainty = (body: string) => body.split(`"stillUncertain":[${JSON.stringify(BILLED_LINE_SUPPORT_UNCERTAINTY)}]`).join('"stillUncertain":[]');
const { records } = JSON.parse(readFileSync('scripts/evaluation/artifacts/operator-guidance-v2/run/records.json', 'utf8')) as { records: { caseId: string; floor: OperatorRecommendation }[] };

describe('main still sends what the qualification froze', () => {
  it('v2 froze exactly what v1 froze', () => {
    expect(frozenV2.requests).toEqual(frozen.requests);
  });

  it('covers every frozen case', () => {
    expect(frozen.requests.map((entry) => entry.caseId).sort()).toEqual(V2_REGRESSION_CASES.map((item) => item.caseId).sort());
    expect(frozen.requests).toHaveLength(24);
  });

  it.each(V2_REGRESSION_CASES.map((item) => [item.caseId, item] as const))('%s, before the v3 corrections', async (caseId, item) => {
    const expected = frozen.requests.find((entry) => entry.caseId === caseId)!;
    const built = await materializeCase(item);
    expect(createHash('sha256').update(withoutAddedUncertainty(JSON.stringify(built.sourceRequest))).digest('hex')).toBe(expected.bodySha256);
    expect(built.approvedContext.transmittedDigest).toBe(expected.contextTransmittedDigest);
  });

  it.each(V2_REGRESSION_CASES.map((item) => [item.caseId, item] as const))('%s floor differs from v2 only where its action link is fixed', async (caseId, item) => {
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

  it('v3\'s freeze holds the 24 held-out cases and no others', () => {
    expect(frozenV3.requests.map((entry) => entry.caseId)).toEqual(HELDOUT_CASES.map((item) => item.caseId));
    const old = new Set(frozen.requests.map((entry) => entry.bodySha256));
    expect(frozenV3.requests.filter((entry) => old.has(entry.bodySha256))).toEqual([]);
  });

  it.each(HELDOUT_CASES.map((item) => [item.caseId, item] as const))('%s is what the v3 freeze holds', async (caseId, item) => {
    const expected = frozenV3.requests.find((entry) => entry.caseId === caseId)!;
    const built = await materializeCase(item);
    expect(createHash('sha256').update(JSON.stringify(built.request)).digest('hex')).toBe(expected.bodySha256);
    expect(hashCanonical(built.floor)).toBe(expected.floorDigest);
    expect(built.approvedContext.transmittedDigest).toBe(expected.contextTransmittedDigest);
  });

  it.each(['document-03', 'document-05'])('%s now opens the source it tells the operator to review', async (caseId) => {
    const built = await materializeCase(V2_REGRESSION_CASES.find((item) => item.caseId === caseId)!);
    expect(built.floor.recommendedNextStep.actionHref).toBe(`/platform/documents/${built.symbols['doc:sheet']}`);
  });

  it.each([...V2_REGRESSION_CASES, ...HELDOUT_CASES].map((item) => [item.question] as const))('never plans ticket data for %s', (question) => {
    expect(questionConcernsTransactions(question)).toBe(false);
    const classified = classifyOperatorIntent(question, { hasFocusFinding: true })!;
    expect(planProjectContext(classified.intent, { question }).sections).not.toContain('transaction_context');
  });
});
