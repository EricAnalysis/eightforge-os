import { z } from 'zod';

import type { FindingAssessment, NextStepKind, ProjectEvidenceAssessment } from '@/lib/projectIntelligence/evidenceAssessment';
import {
  authorityClaimIn,
  internalVocabularyIn,
  resolveEvidenceRefs,
  type OperatorRecommendation,
} from '@/lib/projectIntelligence/operatorRecommendation';
import { citableRecords, providerRequestContext, unsupportedNumbers } from '@/lib/server/caseInvestigationRunner';
import type { AssessmentConfidence } from '@/lib/projectIntelligence/evidenceAssessment';
import type { ProjectIntelligenceContext } from '@/lib/projectIntelligence/projectContext';

/**
 * Factual and authority validation of a model's operator guidance, kept apart
 * from any token or cost ceiling. An answer that fails is dropped whole and the
 * operator gets the deterministic recommendation instead: nothing is repaired,
 * and a failure is never shown as an answer.
 *
 * The citation refs and the invented-number check are the shared helpers, reused
 * unchanged, so every provider answer in EightForge is held to one standard. Those
 * two checks are why Case Investigation's failure modes cannot reach an operator
 * here: a number the context did not carry is refused, and the next step can only
 * be one the evidence reading already offered.
 */

const OutputSchema = z.object({
  answer: z.string().trim().min(1).max(4000),
  nextStepKind: z.string().min(1).max(64),
  nextStepInstruction: z.string().trim().min(1).max(1000),
  citations: z.array(z.string().min(1).max(8)).min(1).max(16),
  missingInformation: z.array(z.string().trim().min(1).max(500)).max(12),
  confidence: z.enum(['high', 'medium', 'low']),
}).strict();

export type GuidanceRejectionReason =
  | 'truncated'
  | 'refused'
  | 'output_not_json'
  | 'output_schema'
  | 'next_step_not_offered'
  | 'citation_unresolved'
  | 'unsupported_number'
  | 'internal_vocabulary'
  | 'authority_claim';

const CONFIDENCE_ORDER: readonly AssessmentConfidence[] = ['low', 'medium', 'high'];

/** The lower of the two: a model can lower confidence in a reading, never raise it. */
function cappedConfidence(model: AssessmentConfidence, floor: AssessmentConfidence): AssessmentConfidence {
  return CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.indexOf(model), CONFIDENCE_ORDER.indexOf(floor))]!;
}

function assessmentForModel(entry: FindingAssessment) {
  return {
    findingId: entry.findingId, title: entry.title, reading: entry.state, neededSource: entry.neededSource,
    candidateDocuments: entry.candidates.map((document) => ({
      id: document.id, title: document.title, read: document.read,
      linkedToGoverningContract: document.linkedToContract, authorityUnsettled: document.authorityUnsettled,
    })),
    governingContract: entry.governingContract,
    openDecisionAlreadyCoversThis: entry.linkedOpenDecisionId != null,
    stillUncertain: entry.uncertainties,
  };
}

/**
 * What the provider receives: the context's transmitted sections, plus the
 * deterministic reading as a section of its own, so its values count as sent.
 * Only sections the policy let through are here.
 */
export function guidanceTransmittedContext(context: ProjectIntelligenceContext, assessment: ProjectEvidenceAssessment) {
  const sections = [
    ...context.sections.filter((section) => section.transmitted),
    {
      kind: 'evidence_assessment',
      provenance: { source: 'evidence_assessment', projectId: context.projectId, recordIds: [] as string[] },
      payload: {
        projectState: assessment.projectState, openFindingCount: assessment.openFindingCount,
        primary: assessment.primary ? assessmentForModel(assessment.primary) : null,
        otherOpenFindings: assessment.others.slice(0, 8).map(assessmentForModel),
      },
    },
  ];
  return { sections, request: providerRequestContext(sections) };
}

/**
 * Text with the context's own record labels removed: a document may legitimately
 * be called `rate_schedule_final.pdf`, and quoting its title is not internal talk.
 */
function withoutRecordLabels(text: string, context: ProjectIntelligenceContext): string {
  const labels = context.sections.flatMap((section) => section.records.map((record) => record.label))
    .filter((label) => label.length > 0).sort((left, right) => right.length - left.length);
  return labels.reduce((rest, label) => rest.split(label).join(' '), text);
}

export function acceptModelRecommendation(params: Readonly<{
  raw: string;
  context: ProjectIntelligenceContext;
  assessment: ProjectEvidenceAssessment;
  floor: OperatorRecommendation;
  transmitted: ReturnType<typeof guidanceTransmittedContext>['sections'];
}>): Readonly<{ ok: true; recommendation: OperatorRecommendation }> | Readonly<{ ok: false; reason: GuidanceRejectionReason }> {
  let value: unknown;
  try {
    value = JSON.parse(params.raw);
  } catch {
    return { ok: false, reason: 'output_not_json' };
  }
  const parsed = OutputSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'output_schema' };
  const output = parsed.data;
  const offered: readonly string[] = params.assessment.primary?.nextSteps ?? [params.floor.recommendedNextStep.kind];
  if (!offered.includes(output.nextStepKind)) return { ok: false, reason: 'next_step_not_offered' };

  const byRef = new Map(citableRecords(params.transmitted).map((record) => [record.ref, record]));
  if (output.citations.some((ref) => !byRef.has(ref)) || new Set(output.citations).size !== output.citations.length) {
    return { ok: false, reason: 'citation_unresolved' };
  }
  const prose = [output.answer, output.nextStepInstruction, ...output.missingInformation].join(' ');
  if (unsupportedNumbers(prose, params.transmitted).length > 0) return { ok: false, reason: 'unsupported_number' };
  if (authorityClaimIn(prose)) return { ok: false, reason: 'authority_claim' };
  if (internalVocabularyIn(withoutRecordLabels(prose, params.context))) return { ok: false, reason: 'internal_vocabulary' };

  // A citation resolves to a record in this project's context, or the answer already failed above.
  const evidenceRefs = resolveEvidenceRefs(params.context, output.citations.map((ref) => byRef.get(ref)!.recordId));
  const kind = output.nextStepKind as NextStepKind;
  return {
    ok: true,
    recommendation: {
      ...params.floor,
      method: 'model_reasoned',
      answer: output.answer,
      recommendedNextStep: {
        kind,
        instruction: output.nextStepInstruction,
        // A link is shown only when the model stayed on the step the link belongs to.
        actionHref: kind === params.floor.recommendedNextStep.kind ? params.floor.recommendedNextStep.actionHref : null,
      },
      evidenceRefs,
      confidence: cappedConfidence(output.confidence, params.floor.confidence),
      // What the evidence reading could not establish is never dropped by a model.
      missingInformation: [...new Set([...params.floor.missingInformation, ...output.missingInformation])],
    },
  };
}
