import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { canonicalJson, hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { runForgewingRepositoryPlanGuidance } from '@/lib/forgewing/tasks/repositoryPlanGuidance';
import {
  TRIAGE_CAPABILITY_SCOPES,
  TRIAGE_PLAN_CLASSIFICATIONS,
  TRIAGE_SEMANTICS_DEFECT_CLASSES,
} from '@/lib/improvementSignalTriageContract';
import { RepositoryAwareImplementationPlanV2Schema } from '@/lib/repositoryAwareImplementationPlan';
import { buildRepositoryPlanContent, type RepositoryPlanCollectedContentInput } from '@/lib/repositoryPlanContent';
import { buildRepositoryPlanFoundation, type RepositoryPlanFoundationInput } from '@/lib/repositoryPlanFoundation';
import {
  prepareRepositoryPlanGuidance,
  repositoryPlanRecommendationId,
  RepositoryPlanGuidanceInputSchema,
  type RepositoryPlanGuidanceInputArtifact,
} from '@/lib/repositoryPlanGuidance';
import { FRICTION_SIGNAL_KINDS, SIGNAL_RECORD_TYPES } from '@/lib/resolution/frictionSignalAllowlist';
import type { VerifiedRepositorySnapshot } from '@/lib/server/repositoryPlanSnapshot';
import { ORCHESTRATOR_ROOT_CAUSE_CATEGORIES } from '@/lib/shared/orchestratorTaxonomy';
import { buildTriagedSignalImplementationPlan } from '@/lib/triagedSignalImplementationPlan';
import {
  TRIAGED_SIGNAL_KINDS,
  TRIAGED_SIGNAL_READINESS,
  TRIAGED_SIGNAL_RECORD_TYPES,
  TRIAGED_SIGNAL_ROOT_CAUSES,
  TRIAGED_SIGNAL_STEP_ID,
  TriagedSignalImplementationPlanSchema,
  TriagedSignalSpecificationSchema,
  type TriagedSignalImplementationPlanArtifact,
} from '@/lib/triagedSignalPlanSchema';
import { RULE_CATALOGUE_FINGERPRINT_VERSION } from '@/lib/validator/ruleCatalogueFingerprint';

const SUBMISSION = 'b8d00000-0000-4000-8000-0000000000b1';
const TRIAGE = 'b8d00000-0000-4000-8000-0000000000c1';
const RATIONALE = 'PLATFORM-LOCAL RATIONALE: customer Acme said the override was for Fort Myers';
const EXEC_REF = 'execution_item:b8d00000-0000-4000-8000-0000000000e1';

/** The data policy: the exact provider-visible keys (owner decision, B8.3d). */
const PROVIDER_KEYS = [
  'signalKind', 'signalCode', 'catalogueFingerprint', 'counts', 'recordRefs', 'rootCauseCategory',
  'triageDisposition', 'capabilityScope', 'semanticsDefectClass', 'planClassification',
].sort();

function submissionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBMISSION, signal_kind: 'recurring_manual_correction', signal_code: 'invoice',
    payload: {
      schemaVersion: 'friction_signal_v1', signalKind: 'recurring_manual_correction', code: 'invoice',
      catalogueFingerprint: null, counts: { occurrences: 4, documents: 3, projects: 2 },
      recordRefs: [EXEC_REF], rootCauseCategory: 'extraction_issue', defectClass: null,
    },
    ...overrides,
  };
}
function triageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TRIAGE, submission_id: SUBMISSION, signal_kind: 'recurring_manual_correction', triage_version: 2,
    disposition: 'route_to_engineering', capability_scope: 'reusable_platform_capability',
    semantics_defect_class: null, plan_classification: 'RULE',
    ...overrides,
  };
}
function built(triage: Record<string, unknown> = {}, submission: Record<string, unknown> = {}): TriagedSignalImplementationPlanArtifact {
  const result = buildTriagedSignalImplementationPlan({ submissionRow: submissionRow(submission), triageRow: triageRow(triage) });
  if (!result.ok) throw new Error(result.code);
  return result.artifact;
}

describe('buildTriagedSignalImplementationPlan (B8.3d)', () => {
  it('pins the exact triage row and carries the human classification and allowlisted context only', () => {
    const plan = built();
    expect(plan.source.pin).toEqual({ sourceKind: 'triaged_improvement_signal', submissionId: SUBMISSION,
      triageReviewId: TRIAGE, triageVersion: 2 });
    expect(plan.plannedSteps).toHaveLength(1);
    const [step] = plan.plannedSteps;
    expect(step.stepId).toBe(TRIAGED_SIGNAL_STEP_ID);
    expect(step.effectiveClassification).toBe('RULE');
    expect(step.implementationReadiness).toEqual({ state: 'blocked_structural', blocker: 'rule_definition_is_code' });
    expect(Object.keys(step.specification).sort()).toEqual(PROVIDER_KEYS);
    expect(step.specification).toEqual({
      signalKind: 'recurring_manual_correction', signalCode: 'invoice', catalogueFingerprint: null,
      counts: { occurrences: 4, documents: 3, projects: 2 }, recordRefs: [EXEC_REF],
      rootCauseCategory: 'extraction_issue', triageDisposition: 'route_to_engineering',
      capabilityScope: 'reusable_platform_capability', semanticsDefectClass: null, planClassification: 'RULE',
    });
    expect(TriagedSignalImplementationPlanSchema.safeParse(plan).success).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('takes the classification from the human, never from the root cause or the signal kind', () => {
    // Same signal, same root cause (extraction_issue): the plan follows the triage decision.
    for (const classification of TRIAGE_PLAN_CLASSIFICATIONS) {
      const plan = built({ plan_classification: classification });
      expect(plan.plannedSteps[0].effectiveClassification).toBe(classification);
      expect(plan.plannedSteps[0].specification.rootCauseCategory).toBe('extraction_issue');
      expect(plan.plannedSteps[0].implementationReadiness).toEqual(TRIAGED_SIGNAL_READINESS[classification]);
    }
    expect(built({ plan_classification: 'VERIFY' }).digest.value).not.toBe(built({ plan_classification: 'EXTRACT' }).digest.value);
  });

  it('carries the semantics defect class for a routed rule semantics review', () => {
    const fingerprint = `${RULE_CATALOGUE_FINGERPRINT_VERSION}:sha256:${'f'.repeat(64)}`;
    const plan = built({ signal_kind: 'rule_semantics_review', semantics_defect_class: 'rule_logic_defect',
      plan_classification: 'VERIFY' }, {
      signal_kind: 'rule_semantics_review', signal_code: 'unrecognized_rule',
      payload: { schemaVersion: 'friction_signal_v1', signalKind: 'rule_semantics_review', code: 'unrecognized_rule',
        catalogueFingerprint: fingerprint, counts: { occurrences: 2, documents: 2, projects: 1 },
        recordRefs: [EXEC_REF], rootCauseCategory: 'validation_rule_issue', defectClass: 'undetermined' },
    });
    expect(plan.plannedSteps[0].specification).toMatchObject({ semanticsDefectClass: 'rule_logic_defect',
      catalogueFingerprint: fingerprint, planClassification: 'VERIFY' });
  });

  it('refuses evidence rows carrying anything beyond the allowlisted columns', () => {
    for (const extra of [{ rationale: RATIONALE }, { reviewer_actor_id: TRIAGE }, { organization_id: SUBMISSION }]) {
      expect(buildTriagedSignalImplementationPlan({ submissionRow: submissionRow(), triageRow: triageRow(extra) }))
        .toEqual({ ok: false, code: 'invalid_evidence' });
    }
    expect(buildTriagedSignalImplementationPlan({ submissionRow: submissionRow({ submitted_by: TRIAGE }), triageRow: triageRow() }))
      .toEqual({ ok: false, code: 'invalid_evidence' });
    // Customer text cannot ride inside the payload either: B8.3a re-validates it.
    const payload = { ...submissionRow().payload, overrideReason: RATIONALE };
    expect(buildTriagedSignalImplementationPlan({ submissionRow: submissionRow({ payload }), triageRow: triageRow() }))
      .toEqual({ ok: false, code: 'invalid_payload' });
  });

  it('refuses anything but a coherent route to engineering', () => {
    const run = (triage: Record<string, unknown>, submission: Record<string, unknown> = {}) =>
      buildTriagedSignalImplementationPlan({ submissionRow: submissionRow(submission), triageRow: triageRow(triage) });
    for (const disposition of ['customer_config_or_mapping', 'reject', 'defer']) {
      expect(run({ disposition })).toEqual({ ok: false, code: 'not_routed_to_engineering' });
    }
    expect(run({ plan_classification: null })).toEqual({ ok: false, code: 'invalid_triage' });
    expect(run({ plan_classification: 'BUILD' })).toEqual({ ok: false, code: 'invalid_triage' });
    expect(run({ capability_scope: null })).toEqual({ ok: false, code: 'invalid_triage' });
    expect(run({ semantics_defect_class: 'wording_defect' })).toEqual({ ok: false, code: 'invalid_triage' });
    expect(run({ submission_id: TRIAGE })).toEqual({ ok: false, code: 'source_mismatch' });
    expect(run({ signal_kind: 'forgewing_rejected' })).toEqual({ ok: false, code: 'source_mismatch' });
    expect(run({}, { signal_code: 'contract' })).toEqual({ ok: false, code: 'source_mismatch' });
  });
});

describe('triaged signal plan vocabularies (B8.3d)', () => {
  it('match their canonical sources', () => {
    expect([...TRIAGED_SIGNAL_KINDS].sort())
      .toEqual(FRICTION_SIGNAL_KINDS.filter((kind) => kind !== 'qualification_demand').sort());
    expect([...TRIAGED_SIGNAL_ROOT_CAUSES]).toEqual(ORCHESTRATOR_ROOT_CAUSE_CATEGORIES.map((category) => category.key));
    expect([...TRIAGED_SIGNAL_RECORD_TYPES]).toEqual([...SIGNAL_RECORD_TYPES]);
    expect(RULE_CATALOGUE_FINGERPRINT_VERSION).toBe('rule-explanation-v1');
    // Plan V1 readiness, unchanged: the same literal table.
    const v1 = readFileSync('lib/workflowImplementationPlan.ts', 'utf8');
    for (const [kind, readiness] of Object.entries(TRIAGED_SIGNAL_READINESS)) {
      const fields = Object.entries(readiness).map(([key, value]) => `${key}: '${value}'`).join(', ');
      expect(v1).toContain(`${kind}: { ${fields} },`);
    }
    expect([...TRIAGE_CAPABILITY_SCOPES]).toEqual(['client_specific', 'workflow_specific', 'reusable_platform_capability']);
    expect([...TRIAGE_SEMANTICS_DEFECT_CLASSES]).toEqual(['wording_defect', 'rule_logic_defect']);
  });

  it('enforce the plan classification invariant in the migration', () => {
    const sql = readFileSync('supabase/migrations/20261012060000_triaged_signal_plan_source.sql', 'utf8');
    expect(sql).toContain(`CHECK (plan_classification IS NULL OR plan_classification IN (${TRIAGE_PLAN_CLASSIFICATIONS.map((value) => `'${value}'`).join(',')}))`);
    expect(sql).toContain("CHECK ((plan_classification IS NOT NULL) = (disposition = 'route_to_engineering'))");
    // The worker's source read never selects the rationale or the reviewer.
    const signalSource = sql.slice(sql.indexOf('read_workflow_repository_plan_generation_signal_source('),
      sql.indexOf('-- Ownership and access'));
    expect(signalSource).not.toMatch(/rationale'|reviewer_actor_id|'organization_id'|submitted_by/u);
  });
});

// ---------------------------------------------------------------------------
// The provider boundary: the real foundation -> content -> guidance-input path.
// ---------------------------------------------------------------------------
const commitSha = 'a'.repeat(40);
const repositorySnapshot = { repositoryUrl: 'https://github.com/example/repository', objectFormat: 'sha1', commitSha,
  branchName: 'main', worktreeDirty: false, untrackedPolicy: 'excluded_from_trusted_manifest',
  submoduleStatus: { state: 'none' } } as VerifiedRepositorySnapshot;

function preparedFor(plan: TriagedSignalImplementationPlanArtifact): RepositoryPlanGuidanceInputArtifact {
  const classification = 'RULE' as const;
  const manifest = [
    { filePath: 'lib/rules/example.ts', commitSha, blobSha: 'b'.repeat(40), classification },
    { filePath: 'lib/rules/example.test.ts', commitSha, blobSha: 'c'.repeat(40), classification },
  ];
  const evidence = [{ filePath: 'lib/rules/example.ts', commitSha, classification, evidenceKind: 'authored_rule' as const,
    reason: 'Existing seam', relevantTestPath: 'lib/rules/example.test.ts' }];
  const foundation = buildRepositoryPlanFoundation({ trustedPlanV1: plan, repositorySnapshot, manifest, evidence } as RepositoryPlanFoundationInput);
  if (!foundation.ok) throw new Error(foundation.code);
  const collected = manifest.map((entry, index): RepositoryPlanCollectedContentInput => {
    const value = index === 0 ? 'export const value = 1;\n' : 'it("works", () => {});\n';
    return { evidenceId: `ev_${hashCanonical({ domain: 'eightforge.repository-content-evidence', schemaVersion: 1,
      commitSha, classification, filePath: entry.filePath, blobSha: entry.blobSha })}`,
    mode: '100644', contentEncoding: 'utf8', byteLength: new TextEncoder().encode(value).byteLength,
    contentSha256: sha256Hex(value), content: value };
  });
  const content = buildRepositoryPlanContent({ foundation: foundation.artifact, classification, collected });
  if (!content.ok) throw new Error(content.code);
  const prepared = prepareRepositoryPlanGuidance({ trustedPlanV1: plan, foundation: foundation.artifact, content: content.artifact });
  if (!prepared.ok) throw new Error(prepared.code);
  return prepared.artifact;
}

function modelOutput(input: RepositoryPlanGuidanceInputArtifact): string {
  const source = input.repositoryContent.files.find((file) => file.roles.includes('source'))!;
  return JSON.stringify({ classification: 'RULE', stepGuidance: [{ stepId: TRIAGED_SIGNAL_STEP_ID,
    recommendationKind: 'extend_existing_rule', capabilitySummary: 'Extend the existing rule',
    recommendationId: repositoryPlanRecommendationId(input.source.implementationPlanV1DigestSha256, 'RULE',
      TRIAGED_SIGNAL_STEP_ID, 'extend_existing_rule'),
    summary: 'Extend the bounded rule seam for the recurring correction.', evidenceRefs: [source.evidenceId],
    existingSeamEvaluation: 'existing_seam_cited', architectureRisks: [], regressionGates: [{ gate: 'typecheck' }],
    stopConditions: [], unresolvedQuestions: [] }],
  operatorDecisionSuggestions: [], unresolvedGlobalQuestions: [], insufficientEvidence: [] });
}

const config = { enabled: true, model: 'test-model', timeoutMs: 5_000, maxOutputTokens: 2_048 };

describe('triaged signal at the provider boundary (B8.3d)', () => {
  it('sends only the triage pin, the allowlisted context and repository content, and yields a Plan V2', async () => {
    const plan = built();
    const input = preparedFor(plan);
    expect(input.source.reviewPin).toEqual(plan.source.pin);
    expect(input.steps.map((step) => step.stepId)).toEqual([TRIAGED_SIGNAL_STEP_ID]);
    expect(Object.keys(input.steps[0].specification).sort()).toEqual(PROVIDER_KEYS);

    const provider = vi.fn(async (request: { inputJson: string }) => {
      expect(request.inputJson).toBe(canonicalJson(input));
      return modelOutput(input);
    });
    const result = await runForgewingRepositoryPlanGuidance(input, { config, provider });
    expect(provider).toHaveBeenCalledTimes(1);
    const sent = provider.mock.calls[0][0].inputJson;
    expect(sent).not.toContain('PLATFORM-LOCAL');
    expect(sent).not.toMatch(/rationale|reviewerActorId|organization|overrideReason|submittedBy/iu);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(RepositoryAwareImplementationPlanV2Schema.safeParse(result.planV2).success).toBe(true);
    expect(result.planV2.source.reviewPin).toEqual(plan.source.pin);
    expect(result.planV2.source.implementationPlanV1DigestSha256).toBe(plan.digest.value);
    expect(result.planV2.source.effectiveReviewedSpecificationDigestSha256)
      .toBe(plan.source.effectiveReviewedSpecificationDigestSha256);
  });

  it('fails closed before any provider call when anything else enters the signal context', async () => {
    const input = preparedFor(built());
    for (const extra of [{ rationale: RATIONALE }, { overrideReason: RATIONALE }, { customerName: 'Acme' }]) {
      const { digest: _digest, ...envelope } = input;
      const tampered = JSON.parse(canonicalJson({ ...envelope,
        steps: [{ ...input.steps[0], specification: { ...input.steps[0].specification, ...extra } }] }));
      const forged = { ...tampered, digest: { ...input.digest, value: hashCanonical(tampered) } };
      expect(RepositoryPlanGuidanceInputSchema.safeParse(forged).success).toBe(false);
      const provider = vi.fn();
      expect(await runForgewingRepositoryPlanGuidance(forged, { config, provider }))
        .toEqual({ status: 'skipped', reason: 'invalid_guidance_input' });
      expect(provider).not.toHaveBeenCalled();
    }
    // A second step cannot be smuggled beside the signal step either.
    const { digest: _digest, ...envelope } = input;
    const doubled = JSON.parse(canonicalJson({ ...envelope, steps: [...input.steps, { ...input.steps[0], stepId: 'extra' }],
      budget: { ...input.budget, selectedSteps: 2 } }));
    expect(RepositoryPlanGuidanceInputSchema.safeParse({ ...doubled,
      digest: { ...input.digest, value: hashCanonical(doubled) } }).success).toBe(false);
  });

  it('is a strict schema at every stage: plan, specification and guidance input', () => {
    const plan = built();
    expect(TriagedSignalSpecificationSchema.safeParse({ ...plan.plannedSteps[0].specification, note: 'x' }).success).toBe(false);
    const { digest: _digest, ...envelope } = plan;
    const widened = { ...envelope, plannedSteps: [{ ...plan.plannedSteps[0],
      specification: { ...plan.plannedSteps[0].specification, note: 'x' } }] };
    expect(TriagedSignalImplementationPlanSchema.safeParse({ ...widened,
      digest: { ...plan.digest, value: hashCanonical(widened) } }).success).toBe(false);
    // The human classification and the step classification cannot diverge.
    const relabelled = { ...envelope, plannedSteps: [{ ...plan.plannedSteps[0], effectiveClassification: 'EXTRACT' }] };
    expect(TriagedSignalImplementationPlanSchema.safeParse({ ...relabelled,
      digest: { ...plan.digest, value: hashCanonical(relabelled) } }).success).toBe(false);
  });
});
