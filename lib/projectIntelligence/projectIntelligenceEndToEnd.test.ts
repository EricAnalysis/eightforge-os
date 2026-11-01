import { describe, expect, it } from 'vitest';

import {
  buildComparisonSourceSnapshot,
  CONTRACT_DOCUMENT_ID,
  goldenProfile,
  RATE_EXHIBIT_DOCUMENT_ID,
} from '@/lib/canonical/comparison/__fixtures__/authorityComparisonFixtures';
import { classifyOperatorIntent, planProjectContext } from '@/lib/projectIntelligence/contextPlan';
import { assessProjectEvidence } from '@/lib/projectIntelligence/evidenceAssessment';
import { deriveProductImprovementSignals } from '@/lib/projectIntelligence/improvementSignal';
import { deterministicRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';
import { assembleProjectContext, contextRecordIndex, LOCAL_ONLY_POLICY } from '@/lib/projectIntelligence/projectContext';
import { primaryFindingActionContext, readProjectIntelligenceSources } from '@/lib/server/projectIntelligenceRead';
import { buildValidatorInputFromSourceSnapshot, executeProjectValidation } from '@/lib/validator/projectValidator';
import { runRateBasedContractValidationRules } from '@/lib/validator/rulePacks/rateBasedContractValidation';
import type { ValidatorSourceSnapshot } from '@/lib/validator/projectValidator';

/**
 * The first slice end to end, on the repository's existing Validator fixtures:
 * the real Validator raises the finding, the real read seam loads it through Ask's
 * real loaders and the real precedence resolver, and the operator's answer comes
 * out. Only the database is a stand-in, serving those same rows. Nothing in the
 * pipeline knows a fixture, a rule outcome or a customer: the same code serves the
 * Golden profile below with a different answer.
 */

const ORG = 'fixture-org';
const AT = '2026-04-30T00:00:00.000Z';

function runValidator(snapshot: ValidatorSourceSnapshot) {
  return executeProjectValidation(buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode: 'legacy' })).result;
}

/** The real rule pack, on the fixture, for a rate-based contract whose facts carry no schedule. */
function scheduleRequiredFindings(snapshot: ValidatorSourceSnapshot) {
  const input = buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode: 'legacy' });
  return runRateBasedContractValidationRules({
    ...input,
    contractValidationContext: null,
    factLookups: { ...input.factLookups, contractCeilingType: 'rate_based', rateSchedulePresent: false, rateRowCount: 0 },
  }).filter((finding) => finding.rule_id === 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED').map((finding, index) => ({
    // As validation persists it.
    id: `finding-${index}`, run_id: 'run-1', rule_id: finding.rule_id, category: finding.category, severity: finding.severity,
    status: 'open', subject_type: finding.subject_type, subject_id: finding.subject_id, field: finding.field,
    expected: finding.expected, actual: finding.actual, blocked_reason: finding.blocked_reason,
    linked_decision_id: null, linked_action_id: null, created_at: AT, updated_at: AT,
  }));
}

/** A read-only database holding what validation persisted and the project's documents. Any write throws. */
function database(params: Readonly<{
  snapshot: ValidatorSourceSnapshot;
  findings: readonly { id: string; [key: string]: unknown }[];
  documents: readonly Record<string, unknown>[];
  relationships?: readonly Record<string, unknown>[];
}>) {
  const rows: Readonly<Record<string, readonly unknown[]>> = {
    project_validation_findings: params.findings,
    project_validation_evidence: [],
    project_validation_runs: [{ id: 'run-1', run_at: AT, completed_at: AT }],
    documents: params.documents,
    document_relationships: params.relationships ?? [],
  };
  return {
    from(table: string) {
      const result = { data: rows[table] ?? [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, in: () => chain, is: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      for (const write of ['insert', 'update', 'upsert', 'delete']) chain[write] = () => { throw new Error(`write to ${table}`); };
      return chain;
    },
  } as never;
}

async function ask(question: string, admin: never, project: ValidatorSourceSnapshot['project']) {
  const classified = classifyOperatorIntent(question)!;
  const plan = planProjectContext(classified.intent);
  const read = await readProjectIntelligenceSources({
    admin, organizationId: ORG,
    project: { id: project.id, name: project.name, validation_status: 'BLOCKED', validation_summary_json: null },
    question, plan,
  });
  if (read.status !== 'ok') throw new Error(read.status);
  const assessment = assessProjectEvidence({ intent: plan.intent, focusFindingId: null, sources: read.sources });
  const context = assembleProjectContext({ organizationId: ORG, plan, sources: read.sources, policy: LOCAL_ONLY_POLICY });
  const recommendation = deterministicRecommendation({ context, assessment,
    primaryFinding: primaryFindingActionContext(read.sources, assessment.primary?.findingId ?? null) });
  return { assessment, context, recommendation, signals: deriveProductImprovementSignals(assessment) };
}

function documentRows(snapshot: ValidatorSourceSnapshot, keep: (id: string) => boolean) {
  return snapshot.documents.filter((document) => keep(document.id)).map((document) => ({
    ...document,
    // The fixture's rate exhibit, uploaded on its own as a price sheet rather than attached to the contract.
    ...(document.id === RATE_EXHIBIT_DOCUMENT_ID ? { title: 'Rate Exhibit', document_type: 'price sheet' } : {}),
    ...(document.id === CONTRACT_DOCUMENT_ID ? { title: 'Debris Contract' } : {}),
    processing_status: 'decisioned',
  }));
}

describe('first vertical slice, on existing fixtures', () => {
  const snapshot = buildComparisonSourceSnapshot({ projectId: 'fixture-source-gap', legacyRateScheduleItems: [], assembledContractPricingRows: [] });
  const scheduleFindings = scheduleRequiredFindings(snapshot);

  it('the real Validator raises the finding this slice answers', () => {
    expect(scheduleFindings).toHaveLength(1);
  });

  it('"Do I need another document?": no, it is already here; check the link', async () => {
    const { assessment, context, recommendation, signals } = await ask('Do I need another document?',
      database({ snapshot, findings: scheduleFindings, documents: documentRows(snapshot, () => true) }), snapshot.project);

    expect(assessment.primary?.state).toBe('source_present_relationship_unresolved');
    expect(recommendation.answer).toContain('Rate Exhibit');
    expect(recommendation.answer).toMatch(/No additional document appears necessary/u);
    expect(recommendation.recommendedNextStep.kind).toBe('link_existing_document');
    expect(recommendation.recommendedNextStep.instruction).toMatch(/linked to the governing contract/u);
    expect(recommendation.needsHumanReview).toBe(true);

    const index = contextRecordIndex(context);
    expect(recommendation.evidenceRefs.length).toBeGreaterThan(0);
    for (const ref of recommendation.evidenceRefs) expect(index.get(ref.recordId)).toBeDefined();
    expect(recommendation.evidenceRefs.map((ref) => ref.recordId)).toContain(RATE_EXHIBIT_DOCUMENT_ID);

    expect(signals[0]).toMatchObject({ category: 'relationship_precedence', ruleId: 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED' });
    expect(JSON.stringify(signals)).not.toContain('Rate Exhibit');
  });

  it('"What am I missing?" over the same evidence reaches the same reading through a different plan', async () => {
    const { assessment, context } = await ask('What am I missing?',
      database({ snapshot, findings: scheduleFindings, documents: documentRows(snapshot, () => true) }), snapshot.project);
    expect(assessment.primary?.state).toBe('source_present_relationship_unresolved');
    expect(context.omissions).toContainEqual({ kind: 'canonical_facts', reason: 'not_in_plan' });
  });

  it('with the exhibit gone, the same finding means upload it', async () => {
    const { assessment, recommendation, signals } = await ask('Do I need another document?',
      database({ snapshot, findings: scheduleFindings, documents: documentRows(snapshot, (id) => id !== RATE_EXHIBIT_DOCUMENT_ID) }), snapshot.project);
    expect(assessment.primary?.state).toBe('source_missing');
    expect(recommendation.recommendedNextStep.kind).toBe('upload_or_request_document');
    expect(signals[0]?.category).toBe('missing_source');
  });

  it('with the exhibit linked and validation current, it points at EightForge, not the project', async () => {
    const { assessment, recommendation, signals } = await ask('Do I need another document?',
      database({ snapshot, findings: scheduleFindings, documents: documentRows(snapshot, () => true),
        relationships: [{ id: 'rel-1', project_id: snapshot.project.id, source_document_id: RATE_EXHIBIT_DOCUMENT_ID,
          target_document_id: CONTRACT_DOCUMENT_ID, relationship_type: 'attached_to', created_at: AT }] }), snapshot.project);
    expect(assessment.primary?.state).toBe('likely_system_issue');
    expect(recommendation.recommendedNextStep.kind).toBe('likely_system_issue');
    expect(signals[0]?.category).toBe('validator_logic');
  });

  it('the same pipeline serves a different project and finding, with no special case: Golden', async () => {
    const golden = goldenProfile();
    const findings = runValidator(golden).findings.filter((finding) => finding.status === 'open');
    expect(findings.length).toBeGreaterThan(0);
    const { assessment, recommendation } = await ask('Why is this flagged?',
      database({ snapshot: golden, findings, documents: documentRows(golden, () => true) }), golden.project);
    expect(assessment.projectState).toBe('findings_open');
    expect(assessment.primary?.state).toBe('not_a_source_gap');
    expect(recommendation.answer).toMatch(/flagged for/u);
    expect(recommendation.recommendedNextStep.kind).not.toBe('upload_or_request_document');
  });
});
