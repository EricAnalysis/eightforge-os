import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ImplementationPlanResponseSchema } from '@/lib/workflowImplementationPlanWire';
import WorkflowImplementationPlanView from './WorkflowImplementationPlanView';
import WorkflowImplementationPlanClient, { createPlanRequestController, errorMessages, parsePlanPin, PlanStatus, requestImplementationPlan, visiblePlanState, type PlanSnapshot } from './WorkflowImplementationPlanClient';

const pin = { assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 1, reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 1 };
const query = 'assessmentVersion=1&reviewId=' + pin.reviewId + '&reviewVersion=1';
const provenance = { ...pin, sourceSubmissionId: '33333333-3333-4333-8333-333333333333', stepReviewId: '44444444-4444-4444-8444-444444444444', reviewerActorId: '55555555-5555-4555-8555-555555555555', reviewerNotes: '  exact notes\n ' };
function success() {
  return { ok: true, plan: { domain: 'eightforge.implementation-plan', schemaVersion: 1, authority: 'non_authoritative', executable: false, grantsExecutionAuthority: false,
    source: { pin: { ...pin }, effectiveReviewedSpecificationDigestSha256: 'a'.repeat(64) }, digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1', value: 'b'.repeat(64) },
    plannedSteps: [{ stepId: 'step-1', originalClassification: 'ADVISORY', effectiveClassification: 'ADVISORY', disposition: 'accepted', specification: { description: '  exact specification\n ' }, specificationSource: { mode: 'accepted_as_proposed', sourceField: 'workflow_assessments.assessment', details: [{ collection: 'advisorySteps', identityField: 'advisoryId', detailId: 'advisory-1' }] }, provenance: { ...provenance }, implementationReadiness: { state: 'specification_complete' } }],
    rejectedSteps: [{ stepId: 'step-2', originalClassification: 'HUMAN', disposition: 'rejected', effectiveClassification: null, effectiveSpecification: null, specificationSource: null, provenance: { ...provenance, stepReviewId: '66666666-6666-4666-8666-666666666666' } }],
  } };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetchResult = (body: unknown, status = 200) => vi.fn<typeof fetch>().mockResolvedValue(response(body, status));

describe('implementation plan request boundary', () => {
  it('requires the exact full URL pin without repairing values or unknown/duplicate queries', () => {
    expect(parsePlanPin(pin.assessmentId, query)).toEqual(pin);
    for (const value of ['', query + '&reviewVersion=1', query + '&latest=true', query.replace('assessmentVersion=1', 'assessmentVersion=01'), query.replace('reviewVersion=1', 'reviewVersion=2147483648'), query.replace('reviewVersion=1', 'reviewVersion=%201')]) expect(parsePlanPin(pin.assessmentId, value)).toBeNull();
  });
  it('sends GET identity only, with bearer authorization and no-store; retry retains the same pin', async () => {
    const fetcher = fetchResult(success());
    const controller = createPlanRequestController(() => {}, fetcher);
    await controller.run('pin', pin, 'token');
    await controller.run('pin', pin, 'token');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`/api/internal/workflow-assessments/${pin.assessmentId}/implementation-plan?${query}`, `/api/internal/workflow-assessments/${pin.assessmentId}/implementation-plan?${query}`]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer token' }, cache: 'no-store' });
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
  });
  it('renders only a validated exact matching success', async () => {
    const result = await requestImplementationPlan(pin, 'token', new AbortController().signal, fetchResult(success()));
    expect(result).toEqual({ kind: 'ready', plan: success().plan });
  });
  it.each(['assessmentId', 'assessmentVersion', 'reviewId', 'reviewVersion'] as const)('rejects a mismatch in %s', async (field) => {
    const wrong = structuredClone(pin);
    if (field === 'assessmentVersion' || field === 'reviewVersion') wrong[field] = 2;
    else wrong[field] = '99999999-9999-4999-8999-999999999999';
    expect(await requestImplementationPlan(wrong, 'token', new AbortController().signal, fetchResult(success()))).toEqual({ kind: 'error', category: 'incompatible' });
  });
  it.each([[401, 'unauthorized', 'unauthenticated'], [403, 'reviewer_not_eligible', 'forbidden'], [400, 'invalid_pin', 'invalid_pin'], [404, 'review_not_found', 'unavailable'], [422, 'invalid_evidence', 'historical'], [503, 'not_configured', 'server'], [500, 'read_failed', 'server']])('maps %s %s to a closed failure state', async (status, error, category) => {
    expect(await requestImplementationPlan(pin, 'token', new AbortController().signal, fetchResult({ ok: false, error }, Number(status)))).toEqual({ kind: 'error', category });
  });
  it('rejects malformed JSON, unknown failure and HTTP/envelope disagreement', async () => {
    for (const fetcher of [vi.fn<typeof fetch>().mockResolvedValue(new Response('{')), fetchResult({ ok: false, error: 'new_error' }, 500), fetchResult(success(), 500), fetchResult({ ok: false, error: 'unauthorized' }), fetchResult({ ok: false, error: 'unauthorized' }, 403)]) {
      expect(await requestImplementationPlan(pin, 'token', new AbortController().signal, fetcher)).toEqual({ kind: 'error', category: 'incompatible' });
    }
  });
  it('handles network failure', async () => {
    expect(await requestImplementationPlan(pin, 'token', new AbortController().signal, vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')))).toEqual({ kind: 'error', category: 'server' });
  });
  it('ignores A completing after B even if fetch ignores abort', async () => {
    const pending: Array<(value: Response) => void> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const snapshots: PlanSnapshot[] = [];
    const controller = createPlanRequestController((snapshot) => snapshots.push(snapshot), fetcher);
    const a = controller.run('A', pin, 'token');
    const nextPin = { ...pin, reviewVersion: 2 };
    const nextBody = success();
    nextBody.plan.source.pin.reviewVersion = 2;
    for (const step of [...nextBody.plan.plannedSteps, ...nextBody.plan.rejectedSteps]) step.provenance.reviewVersion = 2;
    const b = controller.run('B', nextPin, 'token');
    pending[1](response(nextBody)); await b;
    pending[0](response(success())); await a;
    expect(snapshots.map((item) => [item.key, item.state.kind])).toEqual([['A', 'loading'], ['B', 'loading'], ['B', 'ready']]);
  });
  it('cancellation prevents settled results after logout or unmount', async () => {
    let resolve!: (value: Response) => void;
    const snapshots: PlanSnapshot[] = [];
    const controller = createPlanRequestController((snapshot) => snapshots.push(snapshot), vi.fn<typeof fetch>().mockImplementation(() => new Promise((done) => { resolve = done; })));
    const request = controller.run('A', pin, 'token'); controller.cancel(); resolve(response(success())); await request;
    expect(snapshots.map((item) => item.state.kind)).toEqual(['loading']);
  });
  it('synchronously hides the previous plan on changed pin or token before effects execute', () => {
    const parsed = ImplementationPlanResponseSchema.parse(success()); if (!parsed.ok) throw new Error('fixture');
    const snapshot: PlanSnapshot = { key: 'A', token: 'token', state: { kind: 'ready', plan: parsed.plan } };
    expect(visiblePlanState(snapshot, 'B', 'token', pin)).toEqual({ kind: 'loading' });
    expect(visiblePlanState(snapshot, 'A', 'new-token', pin)).toEqual({ kind: 'loading' });
    expect(visiblePlanState(snapshot, 'A', null, pin)).toEqual({ kind: 'error', category: 'unauthenticated' });
    expect(visiblePlanState(snapshot, 'A', 'token', null)).toEqual({ kind: 'error', category: 'invalid_pin' });
  });
});

describe('implementation plan display', () => {
  it('renders loading and every failure state', () => {
    expect(renderToStaticMarkup(<PlanStatus state={{ kind: 'loading' }} retry={() => {}} />)).toContain('Loading implementation plan');
    for (const category of Object.keys(errorMessages) as Array<keyof typeof errorMessages>) {
      expect(renderToStaticMarkup(<PlanStatus state={{ kind: 'error', category }} retry={() => {}} />)).toContain(errorMessages[category]);
    }
  });
  it('keeps the non-authority notice present without a session and has no execution controls', () => {
    const html = renderToStaticMarkup(<WorkflowImplementationPlanClient assessmentId={pin.assessmentId} query={query} />);
    for (const text of ['Non-authoritative', 'Not executable', 'Does not grant execution authority', 'Specification complete does not authorize execution']) expect(html).toContain(text);
    expect(html).not.toMatch(/<(button|form|input|textarea|select)\b/);
  });
  it('renders mixed planned/rejected steps, exact specification, audit provenance and digest details', () => {
    const parsed = ImplementationPlanResponseSchema.parse(success()); if (!parsed.ok) throw new Error('fixture');
    const html = renderToStaticMarkup(<WorkflowImplementationPlanView plan={parsed.plan} />);
    for (const text of ['step-1', 'step-2', 'Rejected steps — excluded from this plan', '  exact specification\n ', '  exact notes\n ', provenance.reviewerActorId, 'advisory-1', 'a'.repeat(64), 'b'.repeat(64), 'sha256', 'recursive-key-sorted-json-v1']) expect(html).toContain(text);
    const rejected = html.split('id="rejected-steps"')[1].split('Identity digest details')[0];
    expect(rejected).not.toContain('Implementation readiness');
    expect(rejected).not.toContain('Effective specification');
    expect(html).not.toMatch(/<(button|form|input|textarea|select)\b/);
  });
  it('renders all-rejected and empty success without an aggregate readiness', () => {
    const body = success(); body.plan.plannedSteps = [];
    let parsed = ImplementationPlanResponseSchema.parse(body); if (!parsed.ok) throw new Error('fixture');
    expect(renderToStaticMarkup(<WorkflowImplementationPlanView plan={parsed.plan} />)).toContain('No steps included; all steps were rejected.');
    body.plan.rejectedSteps = []; parsed = ImplementationPlanResponseSchema.parse(body); if (!parsed.ok) throw new Error('fixture');
    expect(renderToStaticMarkup(<WorkflowImplementationPlanView plan={parsed.plan} />)).toContain('No plan steps.');
  });
  it('renders every received classification and readiness enum without deriving replacements', () => {
    const rule = { plainLanguageRule: 'rule', requiredFacts: ['second', 'first'], conditionType: 'comparison', expectedEvidence: [], expectedOutcome: '', userDescribedExceptions: [], unresolvedAssumptions: [] };
    const cases = [
      ['RULE', rule, { state: 'blocked_structural', blocker: 'rule_definition_is_code' }],
      ['VERIFY', rule, { state: 'specification_complete' }],
      ['EXTRACT', { describedFact: 'fact', sourceDocument: 'doc', deterministicExtractionPlausible: false }, { state: 'requires_operator_decision', decision: 'source_document_taxonomy' }],
      ['RECOVER', { describedFact: 'fact', sourceDocument: 'doc', description: 'recover', deterministicShortfall: 'shortfall' }, { state: 'requires_operator_decision', decision: 'recovery_vocabulary_unresolved' }],
      ['HUMAN', { description: 'human', whyHumanControlled: 'reason' }, { state: 'blocked_structural', blocker: 'no_organization_for_task' }],
      ['ADVISORY', { description: 'advice' }, { state: 'specification_complete' }],
      // The browser renders a structurally valid supplied state; it does not enforce a readiness mapping.
      ['RULE', rule, { state: 'specification_complete' }],
    ] as const;
    for (const [classification, specification, readiness] of cases) {
      const body = success();
      const parsed = ImplementationPlanResponseSchema.parse({ ...body, plan: { ...body.plan, plannedSteps: [{ ...body.plan.plannedSteps[0], originalClassification: classification, effectiveClassification: classification, specification, implementationReadiness: readiness }] } });
      if (!parsed.ok) throw new Error('fixture');
      const html = renderToStaticMarkup(<WorkflowImplementationPlanView plan={parsed.plan} />);
      expect(html).toContain(classification);
      expect(html).toContain(readiness.state);
      if ('blocker' in readiness) expect(html).toContain(readiness.blocker);
      if ('decision' in readiness) expect(html).toContain(readiness.decision);
      if (classification === 'RULE') expect(html.indexOf('second')).toBeLessThan(html.indexOf('first'));
    }
  });
});
