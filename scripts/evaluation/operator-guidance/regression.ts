import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveEvidenceRefs } from '@/lib/projectIntelligence/operatorRecommendation';
import { citableRecords } from '@/lib/server/caseInvestigationRunner';
import { guidanceRejectionReasons } from '@/lib/server/ai/operatorGuidance';

import { GUIDANCE_QUALIFICATION_MODEL, GUIDANCE_V2_ARTIFACT_DIR, hardViolations, type CaseEvidence, type GuidanceRunRecord } from './contract';
import { V2_REGRESSION_CASES } from './corpus';
import { DECOY_MARKER, materializeCase, type MaterializedCase } from './harness';
import { V2_REGRESSION_LABELS } from './labels';

/**
 * v2's saved answers replayed through v3's context, validators and scorer. Zero calls, and
 * regression evidence only: these answers informed v3's corrections, and they answered a
 * context v3 no longer sends, so nothing here is a qualification result or a rate.
 */

export function caseEvidenceFor(item: MaterializedCase): CaseEvidence {
  return {
    transmitted: item.transmitted,
    recordIds: new Set(item.approvedContext.sections.filter((section) => section.transmitted).flatMap((section) => section.records.map((record) => record.recordId))),
    symbols: item.symbols,
    contextLabels: item.approvedContext.sections.flatMap((section) => section.records.map((record) => record.label)),
    decoyMarker: DECOY_MARKER,
  };
}

export type V2ReplayRow = Readonly<{
  caseId: string;
  v2Status: string;
  v2FirstRejection: string | null;
  /** Every check the production validator fails under v3. Empty means it would pass them. */
  validatorFailuresUnderV3: readonly string[];
  /** The scorer's hard bars, read as if the answer had been shown. */
  scorerHitsUnderV3: readonly string[];
  floorLinkInV2: string | null;
  floorLinkInV3: string | null;
}>;

export async function replayV2Answers(): Promise<readonly V2ReplayRow[]> {
  const { records } = JSON.parse(readFileSync(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'run/records.json'), 'utf8')) as { records: readonly GuidanceRunRecord[] };
  const rows: V2ReplayRow[] = [];
  for (const item of V2_REGRESSION_CASES) {
    const saved = records.find((record) => record.caseId === item.caseId)!;
    const label = V2_REGRESSION_LABELS.find((entry) => entry.caseId === item.caseId)!;
    const built = await materializeCase(item);
    const raw = JSON.parse(saved.rawOutput!) as { answer: string; nextStepKind: string; nextStepInstruction: string; citations: string[]; missingInformation: string[]; confidence: string };
    const byRef = new Map(citableRecords(built.transmitted).map((record) => [record.ref, record.recordId]));
    const asShown: GuidanceRunRecord = {
      ...saved, status: 'accepted', allowedNextSteps: built.request.allowedNextSteps, returnedModel: GUIDANCE_QUALIFICATION_MODEL, floor: built.floor,
      shown: {
        ...built.floor, method: 'model_reasoned', answer: raw.answer,
        recommendedNextStep: { kind: raw.nextStepKind as never, instruction: raw.nextStepInstruction, actionHref: null },
        evidenceRefs: resolveEvidenceRefs(built.approvedContext, raw.citations.flatMap((ref) => byRef.get(ref) ?? [])),
        missingInformation: [...new Set([...built.floor.missingInformation, ...raw.missingInformation])],
      },
    };
    rows.push({
      caseId: item.caseId, v2Status: saved.status, v2FirstRejection: saved.rejectionReason,
      validatorFailuresUnderV3: guidanceRejectionReasons({ raw: saved.rawOutput!, context: built.approvedContext, assessment: built.assessment, floor: built.floor, transmitted: built.transmitted }),
      scorerHitsUnderV3: hardViolations(asShown, label, caseEvidenceFor(built)),
      floorLinkInV2: saved.floor.recommendedNextStep.actionHref, floorLinkInV3: built.floor.recommendedNextStep.actionHref,
    });
  }
  return rows;
}
