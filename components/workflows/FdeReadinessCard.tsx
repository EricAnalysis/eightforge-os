'use client';

import type { FdeDeploymentState, FdeLadderRung, FdeReadinessPlan } from '@/lib/projectIntelligence/fdeReadiness';

const RUNG_LABELS: Readonly<Record<FdeLadderRung, string>> = {
  existing_capability: 'Existing capability',
  customer_configuration: 'Customer configuration',
  mapping: 'Mapping',
  adapter: 'Adapter',
  reusable_deterministic_rule: 'Reusable rule',
  extraction_or_validator_improvement: 'Extraction or Validator improvement',
  broad_product_change: 'Broad product change',
};

const DEPLOYMENT_LABELS: Readonly<Record<FdeDeploymentState, string>> = {
  ready_existing_capability: 'Looks covered by what exists',
  ready_with_configuration: 'Looks covered, with configuration',
  needs_mapping: 'Needs mapping',
  needs_adapter: 'Needs an adapter',
  needs_deterministic_rule: 'Needs a reusable rule',
  needs_extraction_or_validator_improvement: 'Needs an extraction or Validator improvement',
  needs_product_change: 'Needs a product change',
  blocked_on_customer_information: 'Waiting on customer information',
  blocked_on_owner_decision: 'Waiting on an owner decision',
};

const READINESS_LABELS: Readonly<Record<FdeReadinessPlan['executionReadiness']['state'], string>> = {
  ready_for_implementation_review: 'Ready for implementation review',
  needs_follow_up: 'Needs follow-up',
  not_ready: 'Nothing here to automate yet',
};

const EVIDENCE_LABELS: Readonly<Record<FdeReadinessPlan['evidenceCompleteness']['state'], string>> = {
  supplied: 'All described sources supplied',
  partially_supplied: 'Some described sources supplied',
  not_supplied: 'Described sources not supplied',
  none_described: 'No sources described',
};

/** The readiness plan beside the review. Derived and read-only: it has no control and decides nothing. */
export function FdeReadinessCard({ plan }: { plan: FdeReadinessPlan }) {
  const rungs = FDE_RUNG_ORDER.flatMap((rung) => {
    const steps = plan.steps.filter((step) => step.startingRung === rung);
    return steps.length > 0 ? [{ rung, steps }] : [];
  });
  const matched = plan.steps.flatMap((step) => step.deployment?.capability ? [{ stepId: step.stepId, state: step.deployment.state, capability: step.deployment.capability }] : []);
  return (
    <section className="space-y-3 rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--ef-text-primary)]">Deployment readiness</h2>
        <p className="mt-1 text-xs text-[var(--ef-text-muted)]">
          Derived from this assessment for you to review. Each step starts on the lowest level that looks sufficient; rule out anything lower before accepting it.
        </p>
      </div>
      <dl className="grid gap-3 md:grid-cols-3">
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-[var(--ef-text-faint)]">Readiness</dt>
          <dd className="mt-1 text-xs text-[var(--ef-text-primary)]">{READINESS_LABELS[plan.executionReadiness.state]}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-[var(--ef-text-faint)]">Workflow</dt>
          <dd className="mt-1 text-xs text-[var(--ef-text-secondary)]">
            {plan.workflowUnderstood.state === 'understood' ? 'Understood' : 'Partly understood'}, {plan.workflowUnderstood.stepCount} steps
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-[var(--ef-text-faint)]">Evidence</dt>
          <dd className="mt-1 text-xs text-[var(--ef-text-secondary)]">{EVIDENCE_LABELS[plan.evidenceCompleteness.state]}</dd>
        </div>
      </dl>

      {plan.deploymentState ? (
        <p className="text-xs text-[var(--ef-text-secondary)]">
          <span className="font-medium text-[var(--ef-text-primary)]">Where this stands:</span> {DEPLOYMENT_LABELS[plan.deploymentState]}
        </p>
      ) : null}

      {matched.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold text-[var(--ef-text-primary)]">Possibly covered already</h3>
          <p className="mt-1 text-xs text-[var(--ef-text-muted)]">A match on the step&apos;s wording, for you to confirm. It does not prove the step is covered.</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-[var(--ef-text-secondary)]">
            {matched.map((entry) => (
              <li key={entry.stepId}>
                {entry.stepId}: {entry.capability.capabilityId.replaceAll('_', ' ')} ({DEPLOYMENT_LABELS[entry.state]})
                {[...entry.capability.configurationRequirements, ...entry.capability.knownLimitations].map((note) => ` ${note}`).join('')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rungs.length > 0 ? (
        <ul className="space-y-1 text-xs text-[var(--ef-text-secondary)]">
          {rungs.map(({ rung, steps }) => (
            <li key={rung}>
              <span className="font-medium text-[var(--ef-text-primary)]">{RUNG_LABELS[rung]}:</span>{' '}
              {steps.map((step) => step.stepId).join(', ')}
            </li>
          ))}
        </ul>
      ) : null}

      {plan.followUps.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold text-[var(--ef-text-primary)]">Still open</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-[var(--ef-text-secondary)]">
            {plan.followUps.map((entry) => (
              <li key={entry.question}>
                {entry.question}
                {entry.checkSuppliedFileFirst ? ` Check ${entry.checkSuppliedFileFirst} first.` : ''}
              </li>
            ))}
          </ul>
          {plan.followUpsNotShown > 0 ? (
            <p className="mt-1 text-xs text-[var(--ef-text-muted)]">{plan.followUpsNotShown} more on the steps below.</p>
          ) : null}
        </div>
      ) : null}

      {plan.unresolvedHumanDecisions.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold text-[var(--ef-text-primary)]">Stays with a person</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-[var(--ef-text-secondary)]">
            {plan.unresolvedHumanDecisions.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

const FDE_RUNG_ORDER = Object.keys(RUNG_LABELS) as FdeLadderRung[];
