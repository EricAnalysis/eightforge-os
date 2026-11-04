import type { FdeIntakePlan } from '@/lib/projectIntelligence/fdeIntakePlan';

const humanize = (value: string) => value.replaceAll('_', ' ');

/** Read-only proposal. The assessment review on this page does not approve this plan. */
export function FdeIntakePlanCard({ plan }: { plan: FdeIntakePlan }) {
  const open = plan.informationNeeds.filter((need) => need.state !== 'confirmed');
  return (
    <section className="space-y-4 rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--ef-text-primary)]">FDE intake plan</h2>
        <p className="mt-1 text-xs text-[var(--ef-text-muted)]">
          Read-only proposal from assessment version {plan.pinnedInputs.assessmentVersion}. Plan review is pending; the assessment review does not approve a deployment recommendation.
        </p>
      </div>

      <div className="grid gap-3 text-xs text-[var(--ef-text-secondary)] md:grid-cols-2">
        <div>
          <h3 className="font-semibold text-[var(--ef-text-primary)]">Workflow understanding</h3>
          <p className="mt-1">Existing process: {plan.workflowUnderstanding.existingProcess ?? 'Not established'}</p>
          <p>Required inputs: {plan.workflowUnderstanding.requiredInputs.join(', ') || 'Not established'}</p>
          <p>Expected outputs: {plan.workflowUnderstanding.expectedOutputs.join(', ') || 'Not established'}</p>
        </div>
        <div>
          <h3 className="font-semibold text-[var(--ef-text-primary)]">Rules and human decisions</h3>
          <p className="mt-1">Proposed rules: {plan.workflowUnderstanding.proposedBusinessRules.join('; ') || 'None established'}</p>
          <p>Human decisions: {plan.workflowUnderstanding.humanDecisions.join('; ') || 'None described'}</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-[var(--ef-text-faint)]">Customer need</h3>
          <p className="mt-1 whitespace-pre-wrap text-xs text-[var(--ef-text-secondary)]">{plan.workflowUnderstanding.objective ?? 'Objective not supplied'}</p>
          {plan.workflowUnderstanding.expectedOutcome && <p className="mt-1 text-xs text-[var(--ef-text-muted)]">Outcome: {plan.workflowUnderstanding.expectedOutcome}</p>}
        </div>
        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-[var(--ef-text-faint)]">Deployment approach</h3>
          <p className="mt-1 text-xs text-[var(--ef-text-primary)]">{plan.deploymentApproach.rung ? humanize(plan.deploymentApproach.rung) : 'Undetermined'}</p>
          <p className="mt-1 text-xs text-[var(--ef-text-muted)]">{plan.deploymentApproach.rationale}</p>
        </div>
        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-[var(--ef-text-faint)]">Human review</h3>
          <p className="mt-1 text-xs text-[var(--ef-text-primary)]">Pending FDE plan review</p>
          <p className="mt-1 text-xs text-[var(--ef-text-muted)]">{plan.humanReview.requiredDecision}</p>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold text-[var(--ef-text-primary)]">Information to resolve ({open.length})</h3>
        {open.length ? (
          <ul className="mt-1 space-y-1 text-xs text-[var(--ef-text-secondary)]">
            {open.map((need, index) => (
              <li key={`${need.stepId ?? 'workflow'}:${need.description}:${index}`}>
                <span className="font-medium">{humanize(need.state)}</span>{need.stepId ? ` · ${need.stepId}` : ''}: {need.description}
                {need.sourceIds.length > 0 && <span className="text-[var(--ef-text-muted)]"> · Source {need.sourceIds.join(', ')}</span>}
              </li>
            ))}
          </ul>
        ) : <p className="mt-1 text-xs text-[var(--ef-text-muted)]">No information gaps identified in the stored sources. A reviewer must still confirm the plan.</p>}
      </div>

      <div>
        <h3 className="text-xs font-semibold text-[var(--ef-text-primary)]">Capability matches and engineering work</h3>
        <ul className="mt-1 space-y-2 text-xs text-[var(--ef-text-secondary)]">
          {plan.capabilityMatches.map((match) => {
            const approach = plan.deploymentApproach.steps.find((step) => step.stepId === match.stepId);
            return (
              <li key={match.stepId} className="rounded border border-[var(--ef-border-subtle)] p-2">
                <p className="font-medium text-[var(--ef-text-primary)]">{match.stepId}: {match.requirement || 'Requirement not described'}</p>
                <p className="mt-1">{match.capabilityId ? `Catalogue match: ${humanize(match.capabilityId)} (${humanize(match.status ?? 'unknown')})` : 'No established catalogue match'}</p>
                <p>Approach: {approach?.rung ? humanize(approach.rung) : 'Human decision or undetermined'}{approach?.basis ? ` · ${approach.basis}` : ''}</p>
                {approach && approach.lowerRungsToRuleOut.length > 0 && <p>Confirm lower rungs are insufficient: {approach.lowerRungsToRuleOut.map(humanize).join(', ')}</p>}
                {match.configurationRequirements.length > 0 && <p>Configuration: {match.configurationRequirements.join(' ')}</p>}
                {match.requiredEvidence.length > 0 && <p>Required evidence: {match.requiredEvidence.join(' ')}</p>}
                {match.knownLimitations.length > 0 && <p>Limits: {match.knownLimitations.join(' ')}</p>}
                {match.unresolvedQuestions.length > 0 && <p>Open: {match.unresolvedQuestions.join(' ')}</p>}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold text-[var(--ef-text-primary)]">Validation before implementation</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-[var(--ef-text-secondary)]">{plan.validationRequirements.map((item) => <li key={item}>{item}</li>)}</ul>
          <h3 className="mt-3 text-xs font-semibold text-[var(--ef-text-primary)]">Affected systems</h3>
          <p className="mt-1 text-xs text-[var(--ef-text-secondary)]">{plan.affectedSystems.length > 0 ? plan.affectedSystems.join(', ') : 'No existing component established by a catalogue match.'}</p>
        </div>
        <div>
          <h3 className="text-xs font-semibold text-[var(--ef-text-primary)]">Pinned evidence</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-[var(--ef-text-secondary)]">
            {plan.supportingEvidence.map((item) => <li key={`${item.kind}:${item.id}`}>{humanize(item.kind)}: {item.detail} · {item.id}</li>)}
          </ul>
        </div>
      </div>
    </section>
  );
}
