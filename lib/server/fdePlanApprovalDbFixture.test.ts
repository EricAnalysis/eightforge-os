import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { parseAssessmentSupportingFile } from '@/lib/extraction/assessmentSupportingFile';
import { buildFdeIntakePlan, type FdeIntakePlan } from '@/lib/projectIntelligence/fdeIntakePlan';
import {
  FDE_WAIVER_ACKNOWLEDGMENT_TEXT, FDE_WAIVER_ACKNOWLEDGMENT_VERSION, resolveFdePlan,
  type FdeEvidenceWaiver, type FdeNeedResolution,
} from '@/lib/projectIntelligence/fdeResolvedPlan';

/**
 * The Postgres hardening probes in scripts/sql/verify-fde-plan-approval.sql run
 * against frozen plans, parsed documents, and resolved plans produced by the
 * real builder, parser, and resolver. This test regenerates that fixture and
 * fails on drift. Regenerate with: FDE_PLAN_DB_FIXTURE_WRITE=1 npx vitest run <this file>
 */
const FIXTURE_PATH = join(process.cwd(), 'scripts', 'sql', 'fixtures', 'fde-plan-approval-hardening.sql');

const IDS = {
  org: 'fa000000-0000-4000-8000-000000000001',
  actor: 'fa100000-0000-4000-8000-000000000001',
  approveSubmission: 'fa200000-0000-4000-8000-000000000001',
  approveAssessment: 'fa300000-0000-4000-8000-000000000001',
  assessmentReview: 'fa400000-0000-4000-8000-000000000001',
  structuralSubmission: 'fa200000-0000-4000-8000-000000000002',
  structuralAssessment: 'fa300000-0000-4000-8000-000000000002',
  document: 'fa500000-0000-4000-8000-000000000001',
  uploadRequest: 'fa600000-0000-4000-8000-000000000001',
} as const;

const INTAKE = { workflowDescription: 'Reconcile haul tickets against the rate schedule', successOutcome: 'Reconciled haul rows' };
const EXTRACT_STEP = { stepId: 'extract', classification: 'EXTRACT', description: 'Read haul rows', proposedOutput: 'Rows',
  requiredInputs: [], unresolvedAssumptions: [], determinismGaps: [] };
const APPROVE_ASSESSMENT = { schemaVersion: 'workflow_assessment_v2', workflowSteps: [EXTRACT_STEP],
  documents: [{ documentId: 'rates', name: 'Rate schedule PDF', role: 'Pricing' }], limitations: [] };
const STRUCTURAL_ASSESSMENT = { schemaVersion: 'workflow_assessment_v2', workflowSteps: [EXTRACT_STEP,
  { stepId: 'approve', classification: 'HUMAN', description: 'Supervisor approves the reconciliation', proposedOutput: 'Approval',
    requiredInputs: [], unresolvedAssumptions: [], determinismGaps: [] }], documents: [], limitations: [] };
const REVIEW = { reviewId: IDS.assessmentReview, reviewVersion: 1, overallDisposition: 'accepted' };
const CSV_BYTES = new TextEncoder().encode('ticket,material,cyd\nT-100,Vegetative,12.5\nT-101,Vegetative,9\n');
const CSV_NAME = 'haul-log.csv';

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

function approvalPlan(supplemental: null | { file: Parameters<typeof buildFdeIntakePlan>[0]['suppliedFiles'][number];
  document: NonNullable<Parameters<typeof buildFdeIntakePlan>[0]['supplementalEvidence']>['documents'][number] }) {
  return buildFdeIntakePlan({
    assessmentId: IDS.approveAssessment, assessmentVersion: 1, sourceSubmissionId: IDS.approveSubmission,
    intake: INTAKE, assessment: APPROVE_ASSESSMENT, answers: [], existingReview: REVIEW,
    suppliedFiles: supplemental ? [supplemental.file] : [],
    supplementalEvidence: { evidenceRevision: supplemental ? 1 : 0, documents: supplemental ? [supplemental.document] : [] },
  })!;
}

function refs(plan: FdeIntakePlan) {
  const pins = plan.pinnedInputs;
  return {
    intake: { kind: 'intake' as const, id: pins.sourceSubmissionId, digest: hashCanonical(pins.intakeDigest) },
    attachment: (id: string) => ({ kind: 'attachment' as const, id, digest: hashCanonical(pins.suppliedFiles.find((file) => file.attachmentId === id)) }),
  };
}

function decision(plan: FdeIntakePlan, resolutions: readonly FdeNeedResolution[], waivers: readonly FdeEvidenceWaiver[]) {
  const result = resolveFdePlan(plan, resolutions, waivers);
  return { result, json: canonicalJson(result.resolvedPlan) };
}

async function buildFdePlanApprovalDbFixture(): Promise<string> {
  // 1. Approval scenario: a waivable described document, plus the supplied file and its
  //    parser-limitation need, both confirmable from the parsed CSV.
  const base = approvalPlan(null);
  const parsed = await parseAssessmentSupportingFile({ bytes: CSV_BYTES, attachmentId: IDS.document, originalFilename: CSV_NAME, mediaType: 'text/csv' });
  if (parsed.status !== 'processed') throw new Error('fixture CSV did not parse');
  const context = parsed.context;
  const contextDigest = hashCanonical({ truncated: context.truncated, limitations: context.limitations, sections: context.sections });
  const storagePath = `${IDS.org}/fde-plans/${IDS.approveSubmission}/${IDS.document}`;
  // Same row shape uploadFdeSupplementalDocument sends to record_fde_plan_supplemental_document.
  const uploadDocument = { id: IDS.document, originalFilename: CSV_NAME, mediaType: parsed.mediaType, byteSize: CSV_BYTES.byteLength,
    contentSha256: parsed.sourceSha256, representationDigestSha256: context.representationDigestSha256, contextDigestSha256: contextDigest,
    storagePath, storageVersion: 'fixture-version', status: 'processed', error: null, context,
    provenance: { parserVersion: parsed.parserVersion, sourceSha256: parsed.sourceSha256 } };
  const uploadDigest = hashCanonical({ actorId: IDS.actor, uploadRequestId: IDS.uploadRequest, filename: CSV_NAME, sourceSha: parsed.sourceSha256, needIds: [] });
  // Same projection currentPlan() in lib/server/fdePlanApproval.ts builds from the stored row.
  const plan = approvalPlan({
    file: { attachmentId: IDS.document, filename: CSV_NAME, sourceSha256: parsed.sourceSha256,
      representationDigestSha256: context.representationDigestSha256, contextDigest, associatedNeedIds: [],
      sectionLabels: context.sections.map((section) => section.label), truncated: context.truncated, limitations: context.limitations },
    document: { attachmentId: IDS.document, sourceSha256: parsed.sourceSha256, representationDigestSha256: context.representationDigestSha256,
      contextDigest, status: 'processed', associatedNeedIds: [] },
  });
  const kinds = plan.informationNeeds.map((need) => need.needKind).sort();
  if (canonicalJson(kinds) !== canonicalJson(['described_document', 'limited_file', 'unmatched_file'])) throw new Error(`unexpected approval needs: ${kinds.join(',')}`);
  const described = plan.informationNeeds.find((need) => need.needKind === 'described_document')!;
  const file = plan.informationNeeds.find((need) => need.needKind === 'unmatched_file')!;
  const limited = plan.informationNeeds.find((need) => need.needKind === 'limited_file')!;
  const ref = refs(plan);
  const waiver: FdeEvidenceWaiver = { needId: described.needId, requirement: described.description,
    customerStatement: 'The current rate schedule will be supplied before activation.', reason: 'Recommend under the stated uncertainty.',
    acknowledgmentText: FDE_WAIVER_ACKNOWLEDGMENT_TEXT, acknowledgmentVersion: FDE_WAIVER_ACKNOWLEDGMENT_VERSION, acknowledged: true,
    sourceRefs: [ref.intake] };
  const confirmed: FdeNeedResolution = { needId: file.needId, disposition: 'confirmed', conclusion: 'The log lists two vegetative haul tickets.',
    rationale: 'Read from the supplied CSV rows.', sourceRefs: [ref.attachment(IDS.document)] };
  const limitedConfirmed: FdeNeedResolution = { needId: limited.needId, disposition: 'confirmed',
    conclusion: 'The parser limitation does not affect the two haul rows.', rationale: 'Checked against the supplied CSV.',
    sourceRefs: [ref.attachment(IDS.document)] };
  const approval = decision(plan, [confirmed, limitedConfirmed], [waiver]);
  if (!approval.result.eligible) throw new Error(`fixture approval is not eligible: ${approval.result.blockers.join(',')}`);

  // 2. Structural scenario: a human decision step can never be confirmed.
  const structural = buildFdeIntakePlan({ assessmentId: IDS.structuralAssessment, assessmentVersion: 1, sourceSubmissionId: IDS.structuralSubmission,
    intake: INTAKE, assessment: STRUCTURAL_ASSESSMENT, answers: [], existingReview: null, suppliedFiles: [],
    supplementalEvidence: { evidenceRevision: 0, documents: [] } })!;
  const human = structural.informationNeeds.find((need) => need.needKind === 'human_step');
  if (!human) throw new Error('fixture structural plan has no human_step need');
  const intakeRef = refs(structural).intake;
  const humanConfirmed: FdeNeedResolution = { needId: human.needId, disposition: 'confirmed', conclusion: 'Supervisor approval assumed.',
    rationale: 'Reviewer interpretation.', sourceRefs: [intakeRef] };
  const humanUnresolved: FdeNeedResolution = { ...humanConfirmed, disposition: 'unresolved', conclusion: 'Supervisor approval is still open.' };
  const structuralConfirmed = decision(structural, [humanConfirmed], []);
  const structuralUnresolved = decision(structural, [humanUnresolved], []);

  const rows: [string, string][] = [
    ['base_plan', canonicalJson(base)],
    ['base_plan_digest', hashCanonical(base)],
    ['plan', canonicalJson(plan)],
    ['plan_digest', hashCanonical(plan)],
    ['upload_document', canonicalJson(uploadDocument)],
    ['upload_digest', uploadDigest],
    ['waiver', canonicalJson(waiver)],
    ['confirmed', canonicalJson(confirmed)],
    ['limited_confirmed', canonicalJson(limitedConfirmed)],
    ['described_need_id', described.needId],
    ['file_need_id', file.needId],
    ['limited_need_id', limited.needId],
    ['approval_resolved', approval.json],
    ['approval_resolved_digest', approval.result.digest],
    ['structural_plan', canonicalJson(structural)],
    ['structural_plan_digest', hashCanonical(structural)],
    ['human_confirmed', canonicalJson(humanConfirmed)],
    ['human_unresolved', canonicalJson(humanUnresolved)],
    ['structural_confirmed_resolved', structuralConfirmed.json],
    ['structural_confirmed_resolved_digest', structuralConfirmed.result.digest],
    ['structural_unresolved_resolved', structuralUnresolved.json],
    ['structural_unresolved_resolved_digest', structuralUnresolved.result.digest],
  ];
  return [
    '-- GENERATED by lib/server/fdePlanApprovalDbFixture.test.ts from real FDE builder,',
    '-- parser, and resolver output. Do not edit; regenerate with FDE_PLAN_DB_FIXTURE_WRITE=1.',
    'CREATE TEMP TABLE fde_hardening_fixture (key text PRIMARY KEY, value text NOT NULL) ON COMMIT DROP;',
    'GRANT SELECT ON fde_hardening_fixture TO service_role;',
    'INSERT INTO fde_hardening_fixture (key, value) VALUES',
    rows.map(([key, value]) => `  (${sqlText(key)}, ${sqlText(value)})`).join(',\n') + ';',
    '',
  ].join('\n');
}

describe('FDE plan approval Postgres fixture', () => {
  it('matches the real builder, parser, and resolver output', async () => {
    const generated = await buildFdePlanApprovalDbFixture();
    if (process.env.FDE_PLAN_DB_FIXTURE_WRITE === '1') writeFileSync(FIXTURE_PATH, generated, 'utf8');
    expect(readFileSync(FIXTURE_PATH, 'utf8').replaceAll('\r\n', '\n')).toBe(generated);
  });

  it('uses an approval the service resolver itself accepts and a structural need it never confirms', async () => {
    const fixture = await buildFdePlanApprovalDbFixture();
    const value = (key: string) => {
      const match = new RegExp(`\\('${key}', '((?:[^']|'')*)'\\)`).exec(fixture);
      if (!match) throw new Error(`missing ${key}`);
      return match[1]!.replaceAll("''", "'");
    };
    expect(JSON.parse(value('approval_resolved'))).toMatchObject({ eligible: true, blockers: [] });
    const structural = JSON.parse(value('structural_confirmed_resolved')) as { eligible: boolean; blockers: string[] };
    expect(structural.eligible).toBe(false);
    expect(structural.blockers).toContain(`unresolved_or_invalid_resolution:${JSON.parse(value('human_confirmed')).needId}`);
  });
});
