import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  ASK_PROJECT_CLAUDE_SYSTEM_PROMPT,
  askOperatorGuidanceWithClaude,
  askProjectWithClaude,
  OPERATOR_GUIDANCE_REQUEST_CONTRACT,
  OPERATOR_GUIDANCE_SYSTEM_PROMPT,
} from '@/lib/server/ai/askProject';
import {
  acceptModelRecommendation,
  guidanceTransmittedContext,
  type GuidanceRejectionReason,
} from '@/lib/server/ai/operatorGuidance';
import { classifyOperatorIntent, planProjectContext } from '@/lib/projectIntelligence/contextPlan';
import { assessProjectEvidence } from '@/lib/projectIntelligence/evidenceAssessment';
import { deriveProductImprovementSignals } from '@/lib/projectIntelligence/improvementSignal';
import { deterministicRecommendation, type OperatorRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';
import { assembleProjectContext, LOCAL_ONLY_POLICY } from '@/lib/projectIntelligence/projectContext';
import { operatorGuidanceTelemetry, type GuidanceProviderStatus } from '@/lib/projectIntelligence/telemetry';
import { primaryFindingActionContext, readProjectIntelligenceSources } from '@/lib/server/projectIntelligenceRead';
import { recordGuidanceAnswer } from '@/lib/server/projectIntelligenceRecords';
import { recordForgewingProviderCallObservation } from '@/lib/server/forgewingProviderTelemetry';
import { isProjectAskGuidanceProviderEnabled, resolveProjectAskModel } from '@/lib/server/ai/askModel';
import { buildAskProjectContext } from '@/lib/server/ai/askProjectContext';
import { getActorContext } from '@/lib/server/getActorContext';
import {
  reserveForgewingProviderCall,
  resolveForgewingWorkflowEligibility,
} from '@/lib/server/forgewingGates';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const runtime = 'nodejs';

const MAX_QUESTION_LENGTH = 1200;
const AI_NOT_CONFIGURED_CODE = 'ai_not_configured';
const AI_NOT_CONFIGURED_MESSAGE = 'AI assistance is not configured.';
const AI_NOT_PERMITTED_CODE = 'forgewing_not_permitted';
const AI_BUDGET_EXHAUSTED_CODE = 'forgewing_budget_exhausted';
const AI_MODEL_UNQUALIFIED_CODE = 'ai_model_unqualified';

/** Ask sends project truth as text. Nothing else is transmitted. */
const ASK_CONTENT_CLASSES = ['text_excerpts'] as const;

type ProjectRow = {
  id: string;
  name: string;
  validation_status: string | null;
  validation_summary_json: unknown;
};

function normalizeQuestion(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const question = input.replace(/\s+/g, ' ').trim();
  return question.length > 0 ? question : null;
}

function safeServerErrorMessage(err: unknown): string {
  const fallback = 'Claude project ask failed';
  const message = err instanceof Error ? err.message : fallback;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && message.includes(apiKey)) {
    return fallback;
  }
  return message;
}

function isAiNotConfiguredError(): boolean {
  return !process.env.ANTHROPIC_API_KEY?.trim();
}

/**
 * Operator guidance: Project Ask's structured answer to "what am I missing?" and
 * its neighbours. Evidence first and always: the reading and the deterministic
 * recommendation need no provider, so a Core organization, a closed gate, a
 * spent budget or a rejected answer all still give the operator something true.
 * Only then, behind every Ask gate plus guidance's own switch, may a model explain
 * it. Read-only: the only writes on this path are the budget reservation and
 * content-free telemetry, the same as Ask.
 */
async function handleOperatorGuidance(params: {
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>;
  actor: { organizationId: string; actorId: string };
  project: ProjectRow;
  question: string;
  focusFindingId: string | null;
}): Promise<Response> {
  const { admin, actor, project, question, focusFindingId } = params;
  const classified = classifyOperatorIntent(question, { hasFocusFinding: focusFindingId != null });
  if (!classified) {
    return NextResponse.json({ error: 'This question is not one guidance can answer.', code: 'intent_not_supported' }, { status: 422 });
  }
  const plan = planProjectContext(classified.intent, { focusFindingId, question });
  const read = await readProjectIntelligenceSources({ admin, organizationId: actor.organizationId, project, question, plan });
  if (read.status === 'focus_finding_not_found') {
    return NextResponse.json({ error: 'That finding is not open on this project.' }, { status: 404 });
  }
  const assessment = assessProjectEvidence({ intent: plan.intent, focusFindingId, sources: read.sources });
  const assemble = (approved: boolean) => assembleProjectContext({
    organizationId: actor.organizationId, plan, sources: read.sources,
    policy: approved ? { approvedContentClasses: ASK_CONTENT_CLASSES } : LOCAL_ONLY_POLICY,
  });
  const localContext = assemble(false);
  const primaryFinding = primaryFindingActionContext(read.sources, assessment.primary?.findingId ?? null);
  let recommendation: OperatorRecommendation = deterministicRecommendation({ context: localContext, assessment, primaryFinding });
  let context = localContext;
  let providerStatus: GuidanceProviderStatus = 'not_attempted';
  let rejection: GuidanceRejectionReason | null = null;
  let observation: Awaited<ReturnType<typeof askOperatorGuidanceWithClaude>>['observation'] | null = null;
  let requestDigest: string | null = null;
  let reservationId: string | null = null;
  const askModel = resolveProjectAskModel();

  const switchOn = isProjectAskGuidanceProviderEnabled();
  const eligibility = switchOn ? await resolveForgewingWorkflowEligibility(admin, {
    organizationId: actor.organizationId, workflow: 'project_ask', contentClasses: ASK_CONTENT_CLASSES,
  }) : null;
  if (!eligibility) {
    providerStatus = 'switch_off';
  } else if (!eligibility.eligible) {
    providerStatus = 'gate_closed';
  } else if (isAiNotConfiguredError()) {
    providerStatus = 'not_configured';
  } else if (!askModel.qualified) {
    providerStatus = 'model_unqualified';
  } else {
    context = assemble(true);
    const transmitted = guidanceTransmittedContext(context, assessment, recommendation);
    requestDigest = createHash('sha256').update(JSON.stringify([
      OPERATOR_GUIDANCE_REQUEST_CONTRACT, askModel.model, OPERATOR_GUIDANCE_SYSTEM_PROMPT, question, plan, context.transmittedDigest, assessment,
    ])).digest('hex');
    const reservation = await reserveForgewingProviderCall(admin, {
      organizationId: actor.organizationId, requestDigestSha256: requestDigest, reservedBy: actor.actorId,
      dailyCap: eligibility.dailyCap, workflow: 'project_ask',
    });
    if (reservation.status !== 'reserved') {
      providerStatus = reservation.status === 'budget_exhausted' ? 'budget_exhausted' : 'reservation_failed';
    } else {
      reservationId = reservation.reservationId;
      const startedAt = performance.now();
      const telemetry = {
        workflow: 'project_ask' as const, organizationId: actor.organizationId, reservationId: reservation.reservationId,
        requestDigestSha256: requestDigest, model: askModel.model,
      };
      try {
        const answered = await askOperatorGuidanceWithClaude({
          question, intent: plan.intent, allowedNextSteps: assessment.primary?.nextSteps ?? [recommendation.recommendedNextStep.kind],
          context: transmitted.request, model: askModel.model,
        });
        observation = answered.observation;
        const accepted = answered.truncated ? { ok: false as const, reason: 'truncated' as const }
          : answered.refused ? { ok: false as const, reason: 'refused' as const }
          : acceptModelRecommendation({ raw: answered.raw, context, assessment, floor: recommendation, transmitted: transmitted.sections });
        if (accepted.ok) {
          recommendation = accepted.recommendation;
          providerStatus = 'accepted';
        } else {
          rejection = accepted.reason;
          providerStatus = 'rejected';
        }
        await recordForgewingProviderCallObservation(admin, {
          ...telemetry, ...answered.observation,
          outcome: accepted.ok ? 'succeeded' : accepted.reason === 'truncated' ? 'output_truncated'
            : accepted.reason === 'refused' ? 'provider_failed' : 'output_invalid',
        });
      } catch (providerError) {
        providerStatus = 'provider_failed';
        await recordForgewingProviderCallObservation(admin, {
          ...telemetry,
          outcome: providerError instanceof Error && /timed? ?out|abort/i.test(providerError.name + providerError.message)
            ? 'provider_timeout' : 'provider_failed',
          latencyMs: performance.now() - startedAt,
        });
        console.error('[projectAsk] guidance_provider_failed', {
          reservationId: reservation.reservationId,
          errorClass: providerError instanceof Error ? providerError.name : typeof providerError,
        });
      }
    }
  }

  // Content-free, and carrying no tenant identity: the durable provider ledger holds that.
  const signals = deriveProductImprovementSignals(assessment);
  const answerTelemetry = operatorGuidanceTelemetry({
    classified, context, recommendation, providerStatus, rejection, requestDigest,
    model: providerStatus === 'accepted' || providerStatus === 'rejected' ? askModel.model : null,
    observation, signalCategories: signals.map((signal) => signal.category),
  });
  console.info('[projectIntelligence] operator_guidance', answerTelemetry);
  // The durable, tenant-scoped record of the same facts. Best effort: the answer does not depend on it.
  await recordGuidanceAnswer(admin, {
    context, telemetry: answerTelemetry, signals, rejection, reservationId,
    requestContract: OPERATOR_GUIDANCE_REQUEST_CONTRACT,
  });

  // The operator's answer only. Product signals are read on the internal route.
  return NextResponse.json({
    recommendation,
    model: providerStatus === 'accepted' ? askModel.model : null,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  const body = await request.json().catch(() => ({}));
  const question = normalizeQuestion(body?.question);
  if (!question) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return NextResponse.json({ error: 'question is too long' }, { status: 400 });
  }

  const { id: projectId } = await params;
  if (!projectId) {
    return NextResponse.json({ error: 'project id is required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  }

  const { data, error } = await admin
    .from('projects')
    .select('id, name, validation_status, validation_summary_json')
    .eq('organization_id', actor.actor.organizationId)
    .eq('id', projectId)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const project = data as ProjectRow;
  if (project.id !== projectId) {
    return NextResponse.json({ error: 'Project context scope mismatch' }, { status: 500 });
  }

  if (body?.mode === 'operator_guidance') {
    const focusFindingId = typeof body?.findingId === 'string' && body.findingId.length > 0 && body.findingId.length <= 200
      ? body.findingId : null;
    try {
      return await handleOperatorGuidance({ admin, actor: actor.actor, project, question, focusFindingId });
    } catch (err) {
      console.error('[projectAsk] guidance_failed', { errorClass: err instanceof Error ? err.name : typeof err });
      return NextResponse.json({ error: 'Guidance could not be prepared right now.' }, { status: 500 });
    }
  }

  // Ask sends customer content to a provider, so it passes the same gates as
  // every Forgewing workflow before any context is built: kill switch, policy,
  // entitlement, data-processing authorization, daily cap.
  const eligibility = await resolveForgewingWorkflowEligibility(admin, {
    organizationId: actor.actor.organizationId,
    workflow: 'project_ask',
    contentClasses: ASK_CONTENT_CLASSES,
  });
  if (!eligibility.eligible) {
    return NextResponse.json(
      { error: 'AI assistance is not enabled for this organization.', code: AI_NOT_PERMITTED_CODE, reason: eligibility.reason },
      { status: 403 },
    );
  }

  // Never spend budget on a call that cannot be made.
  if (isAiNotConfiguredError()) {
    return NextResponse.json(
      { error: AI_NOT_CONFIGURED_MESSAGE, code: AI_NOT_CONFIGURED_CODE },
      { status: 500 },
    );
  }

  // Ask calls only a model qualified for its own request contract (D3): an
  // unqualified model is refused before any context, budget or provider call,
  // with no fallback to another model.
  const askModel = resolveProjectAskModel();
  if (!askModel.qualified) {
    console.error('[projectAsk] model_unqualified', { source: askModel.source });
    return NextResponse.json(
      { error: 'AI assistance is not available with the configured model.', code: AI_MODEL_UNQUALIFIED_CODE },
      { status: 503 },
    );
  }

  try {
    const context = await buildAskProjectContext({
      admin,
      projectId,
      orgId: actor.actor.organizationId,
      question,
      project,
    });

    if (context.project.id !== projectId || context.scope.projectId !== projectId) {
      return NextResponse.json({ error: 'Project context scope mismatch' }, { status: 500 });
    }

    // One slot of the organization's durable Ask budget, bound to the exact
    // request, immediately before the provider call.
    const requestDigestSha256 = createHash('sha256').update(JSON.stringify([
      'project_ask_v1', askModel.model, ASK_PROJECT_CLAUDE_SYSTEM_PROMPT, question, context,
    ])).digest('hex');
    const reservation = await reserveForgewingProviderCall(admin, {
      organizationId: actor.actor.organizationId,
      requestDigestSha256,
      reservedBy: actor.actor.actorId,
      dailyCap: eligibility.dailyCap,
      workflow: 'project_ask',
    });
    if (reservation.status === 'budget_exhausted') {
      return NextResponse.json(
        { error: 'The daily AI assistance budget for this organization is used up.', code: AI_BUDGET_EXHAUSTED_CODE },
        { status: 429 },
      );
    }
    if (reservation.status !== 'reserved') {
      return NextResponse.json({ error: 'AI assistance is temporarily unavailable.' }, { status: 503 });
    }

    let answer: Awaited<ReturnType<typeof askProjectWithClaude>>;
    const providerStartedAt = performance.now();
    const telemetry = {
      workflow: 'project_ask' as const,
      organizationId: actor.actor.organizationId,
      reservationId: reservation.reservationId,
      requestDigestSha256,
      model: askModel.model,
    };
    try {
      answer = await askProjectWithClaude({ question, context, model: askModel.model });
    } catch (providerError) {
      await recordForgewingProviderCallObservation(admin, {
        ...telemetry,
        outcome: providerError instanceof Error && /timed? ?out|abort/i.test(providerError.name + providerError.message)
          ? 'provider_timeout' : 'provider_failed',
        latencyMs: performance.now() - providerStartedAt,
      });
      // The reservation stays spent and auditable (append-only ledger). Record
      // which one failed and why, by class only: never the question, context
      // or provider text.
      console.error('[projectAsk] provider_failed', {
        reservationId: reservation.reservationId,
        organizationId: actor.actor.organizationId,
        errorClass: providerError instanceof Error ? providerError.name : typeof providerError,
      });
      if (isAiNotConfiguredError()) throw providerError;
      return NextResponse.json(
        { error: 'AI assistance is temporarily unavailable.', code: 'provider_failed' },
        { status: 503 },
      );
    }
    await recordForgewingProviderCallObservation(admin, {
      ...telemetry,
      ...(answer.observation ?? { latencyMs: performance.now() - providerStartedAt }),
      outcome: 'succeeded',
    });
    // The browser receives the answer and model only, never call metadata.
    return NextResponse.json({ answer: answer.answer, model: answer.model });
  } catch (err) {
    if (isAiNotConfiguredError()) {
      return NextResponse.json(
        { error: AI_NOT_CONFIGURED_MESSAGE, code: AI_NOT_CONFIGURED_CODE },
        { status: 500 },
      );
    }

    return NextResponse.json({ error: safeServerErrorMessage(err) }, { status: 500 });
  }
}
