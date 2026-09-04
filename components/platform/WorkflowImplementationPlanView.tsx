import React from 'react';
import type { BrowserSafeImplementationPlan } from '@/lib/workflowImplementationPlanWire';

const panel = 'rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-4';
const explanations: Record<string, string> = {
  rule_definition_is_code: 'Rule implementation requires authored code',
  no_organization_for_task: 'No organization identity is available for deterministic task creation',
  source_document_taxonomy: 'Source document requires operator taxonomy decision',
  recovery_vocabulary_unresolved: 'Recovery implementation vocabulary is unresolved',
};

// Render the received structure verbatim. Empty strings, arrays, nulls and booleans
// remain distinguishable; no specification fields are inferred or suppressed.
function Value({ value }: { value: unknown }) {
  if (Array.isArray(value)) return value.length === 0 ? <code>[]</code> : (
    <ol className="list-decimal space-y-1 pl-5">{value.map((item, index) => <li key={index}><Value value={item} /></li>)}</ol>
  );
  if (value !== null && typeof value === 'object') return <Fields record={value as Record<string, unknown>} />;
  return <span className="whitespace-pre-wrap break-words">{value === '' ? '""' : String(value)}</span>;
}

function Fields({ record }: { record: Record<string, unknown> }) {
  return <dl className="space-y-2 text-sm">{Object.entries(record).map(([key, value]) => (
    <div key={key}><dt className="text-xs text-[var(--ef-text-muted)]">{key}</dt>
      <dd className="mt-1 min-w-0 text-[var(--ef-text-secondary)]"><Value value={value} /></dd></div>
  ))}</dl>;
}

export default function WorkflowImplementationPlanView({ plan }: { plan: BrowserSafeImplementationPlan }) {
  return <div className="min-w-0 space-y-6 break-words">
    <section className={panel} aria-labelledby="plan-identity"><h2 id="plan-identity" className="mb-3 font-semibold">Reviewed workflow identity</h2><Fields record={plan.source.pin} /></section>
    <section aria-labelledby="planned-steps"><h2 id="planned-steps" className="mb-3 font-semibold">Planned steps</h2>
      {plan.plannedSteps.length === 0 && <p className="text-sm text-[var(--ef-text-muted)]">{plan.rejectedSteps.length > 0 ? 'No steps included; all steps were rejected.' : 'No plan steps.'}</p>}
      <ol className="space-y-4">{plan.plannedSteps.map((step) => <li key={step.stepId} className={panel}>
        <h3 className="font-semibold">{step.stepId} · {step.effectiveClassification}</h3>
        <p className="mt-1 text-sm">Original classification: {step.originalClassification} · Disposition: {step.disposition}</p>
        <section className="mt-4"><h4 className="mb-2 font-medium">Implementation readiness</h4><Fields record={step.implementationReadiness} />
          {'blocker' in step.implementationReadiness && <p className="mt-2 text-sm">{explanations[step.implementationReadiness.blocker]}</p>}
          {'decision' in step.implementationReadiness && <p className="mt-2 text-sm">{explanations[step.implementationReadiness.decision]}</p>}
        </section>
        <section className="mt-4"><h4 className="mb-2 font-medium">Effective specification</h4><Fields record={step.specification} /></section>
        <section className="mt-4"><h4 className="mb-2 font-medium">Specification source</h4><Fields record={step.specificationSource} /></section>
        <details className="mt-4"><summary className="cursor-pointer font-medium">Audit provenance</summary><div className="mt-2"><Fields record={step.provenance} /></div></details>
      </li>)}</ol>
    </section>
    <section aria-labelledby="rejected-steps"><h2 id="rejected-steps" className="mb-3 font-semibold">Rejected steps — excluded from this plan</h2>
      {plan.rejectedSteps.length === 0 && <p className="text-sm text-[var(--ef-text-muted)]">No rejected steps.</p>}
      <ol className="space-y-4">{plan.rejectedSteps.map((step) => <li key={step.stepId} className={panel}>
        <h3 className="font-semibold">{step.stepId}</h3><p className="mt-1 text-sm">Original classification: {step.originalClassification} · Disposition: {step.disposition}</p>
        <div className="mt-3"><Fields record={{ reviewerNotes: step.provenance.reviewerNotes }} /></div>
        <details className="mt-3"><summary className="cursor-pointer font-medium">Audit provenance</summary><div className="mt-2"><Fields record={step.provenance} /></div></details>
      </li>)}</ol>
    </section>
    <details className={panel}><summary className="cursor-pointer font-medium">Identity digest details</summary>
      <p className="my-3 text-sm">Digests identify the artifacts only. They do not grant authorization and are not cryptographically verified by this browser.</p>
      <Fields record={{ domain: plan.domain, schemaVersion: plan.schemaVersion, authority: plan.authority, executable: plan.executable, grantsExecutionAuthority: plan.grantsExecutionAuthority, 'Plan identity digest': plan.digest.value, algorithm: plan.digest.algorithm, encoding: plan.digest.encoding, 'Source resolver identity digest': plan.source.effectiveReviewedSpecificationDigestSha256, sourcePin: plan.source.pin }} />
    </details>
  </div>;
}
