import type { ClassifiedOperatorIntent } from '@/lib/projectIntelligence/contextPlan';
import type { ProductSignalCategory } from '@/lib/projectIntelligence/improvementSignal';
import type { OperatorRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';
import type { ProjectIntelligenceContext } from '@/lib/projectIntelligence/projectContext';

/**
 * Content-free telemetry for one guidance answer: closed vocabularies, counts and
 * measurements only. Never a question, an answer, a title, a project or an
 * organization. The durable record adds tenant scope and is built from this:
 * lib/server/projectIntelligenceRecords.ts.
 */

export type GuidanceProviderStatus =
  | 'not_attempted'
  | 'switch_off'
  | 'gate_closed'
  | 'not_configured'
  | 'model_unqualified'
  | 'budget_exhausted'
  | 'reservation_failed'
  | 'provider_failed'
  | 'rejected'
  | 'accepted';

export function operatorGuidanceTelemetry(params: Readonly<{
  classified: ClassifiedOperatorIntent;
  context: ProjectIntelligenceContext;
  recommendation: OperatorRecommendation;
  providerStatus: GuidanceProviderStatus;
  /** A fixed code from the validator, or null. */
  rejection: string | null;
  requestDigest: string | null;
  model: string | null;
  observation: Readonly<{ inputTokens: number | null; outputTokens: number | null; latencyMs: number; stopReason: string | null }> | null;
  signalCategories: readonly ProductSignalCategory[];
}>) {
  const { classified, context, recommendation, observation } = params;
  return {
    intent: classified.intent,
    intentBasis: classified.basis,
    method: recommendation.method,
    evidenceState: recommendation.evidenceState,
    nextStep: recommendation.recommendedNextStep.kind,
    confidence: recommendation.confidence,
    sectionsUsed: context.sections.map((section) => section.kind),
    sectionsTransmitted: context.sections.filter((section) => section.transmitted).map((section) => section.kind),
    sectionsOmitted: context.omissions.filter((entry) => entry.reason !== 'not_in_plan').map((entry) => `${entry.kind}:${entry.reason}`),
    retrievalCount: context.sections.reduce((sum, section) => sum + section.records.length, 0),
    citationCount: recommendation.evidenceRefs.length,
    providerStatus: params.providerStatus,
    validationStatus: params.rejection ?? (params.providerStatus === 'accepted' ? 'passed' : 'not_applicable'),
    model: params.model,
    requestDigest: params.requestDigest,
    inputTokens: observation?.inputTokens ?? null,
    outputTokens: observation?.outputTokens ?? null,
    latencyMs: observation ? Math.round(observation.latencyMs) : null,
    stopReason: observation?.stopReason ?? null,
    signalCategories: [...new Set(params.signalCategories)],
  };
}
