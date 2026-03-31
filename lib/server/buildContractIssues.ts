import type {
  ContractAnalysisResult,
  ContractSuppressedIssueTrace,
  ContractCoverageResult,
  ContractFieldAnalysis,
  ContractIssue,
} from '@/lib/contracts/types';

type BuildContractIssuesInput = {
  contractAnalysis: Omit<ContractAnalysisResult, 'issues' | 'trace_summary'> & {
    coverage_status: ContractCoverageResult[];
  };
};

type BuildContractIssuesOutput = {
  issues: ContractIssue[];
  suppressed: ContractSuppressedIssueTrace[];
};

function flattenFields(
  contractAnalysis: BuildContractIssuesInput['contractAnalysis'],
): Map<string, ContractFieldAnalysis> {
  const map = new Map<string, ContractFieldAnalysis>();
  for (const family of [
    contractAnalysis.contract_identity,
    contractAnalysis.term_model,
    contractAnalysis.activation_model,
    contractAnalysis.scope_model,
    contractAnalysis.pricing_model,
    contractAnalysis.documentation_model,
    contractAnalysis.compliance_model,
    contractAnalysis.payment_model,
  ]) {
    for (const field of Object.values(family)) {
      if (!field) continue;
      map.set(field.field_id, field);
    }
  }
  return map;
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim().length > 0))];
}

export function buildContractIssues(
  input: BuildContractIssuesInput,
): BuildContractIssuesOutput {
  const fields = flattenFields(input.contractAnalysis);
  const coverageById = new Map(
    input.contractAnalysis.coverage_status.map((coverage) => [coverage.coverage_id, coverage] as const),
  );
  const issues = new Map<string, ContractIssue>();
  const suppressed = new Map<string, ContractSuppressedIssueTrace>();

  const expirationField = fields.get('expiration_date') ?? null;
  const contractorField = fields.get('contractor_name') ?? null;
  const activationField = fields.get('activation_trigger_type') ?? null;
  const pricingField = fields.get('pricing_applicability') ?? null;
  const rateField = fields.get('rate_schedule_present') ?? null;
  const docsField = fields.get('billing_documentation_required') ?? null;
  const monitoringField = fields.get('monitoring_required') ?? null;
  const femaField = fields.get('fema_eligibility_gate') ?? null;
  const disposalField = fields.get('disposal_fee_treatment') ?? null;
  const activationPatternIds = dedupe([
    ...(activationField?.pattern_ids ?? []),
  ]);
  const hasActivationDependency = activationField?.state === 'conditional' && activationField.value != null;
  const hasPricingSpecificAmbiguity =
    disposalField?.value != null
    || femaField?.state === 'conditional';
  const hasDocumentationGate =
    docsField?.state === 'conditional'
    || monitoringField?.state === 'conditional';

  function suppress(issue_id: string, reason: string): void {
    suppressed.set(issue_id, { issue_id, reason });
  }

  if (expirationField?.state === 'derived') {
    issues.set('derived_expiration_confirmation', {
      issue_id: 'derived_expiration_confirmation',
      issue_type: 'derived_value_requires_confirmation',
      priority: 'P2',
      field_ids: ['executed_date', 'initial_term_length', 'expiration_date'],
      pattern_ids: expirationField.pattern_ids.includes('execution_based_term')
        ? expirationField.pattern_ids
        : ['execution_based_term'],
      reason:
        'Expiration appears to be derived from execution/effective-date term language. Keep it flagged for operator confirmation instead of treating it as directly stated.',
      evidence_anchors: dedupe(expirationField.evidence_anchors),
      resolution_effect: 'confirm_term_model',
    });
  }

  if (contractorField?.state === 'conflicted') {
    issues.set('contractor_identity_conflict', {
      issue_id: 'contractor_identity_conflict',
      issue_type: 'conflicting_evidence',
      priority: 'P1',
      field_ids: ['contractor_name'],
      pattern_ids: contractorField.pattern_ids,
      reason:
        'Competing contractor identity candidates were detected. The layer keeps this as a conflict instead of selecting a false definitive contractor.',
      evidence_anchors: dedupe(contractorField.evidence_anchors),
      resolution_effect: 'resolve_identity_conflict',
    });
  }

  if (hasActivationDependency) {
    issues.set('activation_trigger_status_unresolved', {
      issue_id: 'activation_trigger_status_unresolved',
      issue_type: 'conditional_without_trigger_status',
      priority: 'P1',
      field_ids: ['activation_trigger_type', 'authorization_required', 'performance_start_basis'],
      pattern_ids: activationField.pattern_ids,
      reason:
        'The contract separates contract effectiveness from work authorization, but the activation trigger status is not resolved in the document alone.',
      evidence_anchors: dedupe(activationField.evidence_anchors),
      resolution_effect: 'resolve_activation_gate',
    });
  }

  if (rateField?.value === true && pricingField?.state === 'conditional') {
    if (hasPricingSpecificAmbiguity) {
      issues.set('pricing_applicability_requires_context', {
        issue_id: 'pricing_applicability_requires_context',
        issue_type: 'pricing_applicability_unclear',
        priority: 'P1',
        field_ids: ['rate_schedule_present', 'pricing_applicability'],
        pattern_ids: pricingField.pattern_ids,
        reason:
          'A rate schedule is present, but disposal treatment, reimbursement, or other pricing gates still leave the applicable pricing basis unresolved.',
        evidence_anchors: dedupe([
          ...rateField.evidence_anchors,
          ...pricingField.evidence_anchors,
        ]),
        resolution_effect: 'clarify_pricing_applicability',
      });
    } else {
      suppress(
        'pricing_applicability_requires_context',
        'Suppressed because schedule presence alone is not a pricing issue when no separate pricing gate was evidenced.',
      );
    }
  }

  const documentationCoverage = coverageById.get('documentation_prerequisites') ?? null;
  const monitoringCoverage = coverageById.get('monitoring_dependency') ?? null;
  if (hasDocumentationGate) {
    issues.set('documentation_gate_unclear', {
      issue_id: 'documentation_gate_unclear',
      issue_type: 'documentation_prerequisite_unclear',
      priority: 'P1',
      field_ids: ['billing_documentation_required', 'monitoring_required'],
      pattern_ids: dedupe([
        ...(docsField?.pattern_ids ?? []),
        ...(monitoringField?.pattern_ids ?? []),
      ]),
      reason:
        'Payment, verification, or reimbursement appears to depend on tickets, manifests, monitoring records, or similar support, but the prerequisite set is not fully resolved.',
      evidence_anchors: dedupe([
        ...(documentationCoverage?.evidence_anchors ?? []),
        ...(monitoringCoverage?.evidence_anchors ?? []),
      ]),
      resolution_effect: 'clarify_documentation_gate',
    });
  } else if (
    documentationCoverage?.operator_review_required === true
    || monitoringCoverage?.operator_review_required === true
  ) {
    suppress(
      'documentation_gate_unclear',
      'Suppressed because documentation or monitoring terms were not strongly tied to payment, verification, or reimbursement prerequisites.',
    );
  }

  const femaCoverage = coverageById.get('fema_eligibility') ?? null;
  if (femaField?.state === 'conditional') {
    issues.set('fema_gate_ambiguous', {
      issue_id: 'fema_gate_ambiguous',
      issue_type: 'fema_gate_ambiguous',
      priority: 'P1',
      field_ids: ['fema_eligibility_gate', 'billing_documentation_required'],
      pattern_ids: femaField?.pattern_ids ?? ['fema_eligibility_restriction'],
      reason:
        'The contract language suggests FEMA eligibility, reimbursement, or ineligible-cost limitations, but the operational gate is not cleanly resolved.',
      evidence_anchors: dedupe([
        ...(femaCoverage?.evidence_anchors ?? []),
        ...(femaField?.evidence_anchors ?? []),
      ]),
      resolution_effect: 'clarify_fema_gate',
    });
  } else if (
    femaCoverage?.operator_review_required === true
    || femaField?.state === 'missing_critical'
  ) {
    suppress(
      'fema_gate_ambiguous',
      'Suppressed because the contract referenced FEMA or reimbursement context without a clear eligibility or payment gate.',
    );
  }

  const termCoverage = coverageById.get('term_trigger') ?? null;
  if (termCoverage && !termCoverage.found && termCoverage.operator_review_required === true) {
    suppress(
      'missing_required_clause:term_trigger',
      'Suppressed because the current pass only emits term issues when the term model was actually derived or conflicted, not merely absent.',
    );
  }

  const activationCoverage = coverageById.get('activation_trigger') ?? null;
  if (activationCoverage && !activationCoverage.found && activationCoverage.operator_review_required === true) {
    if (activationPatternIds.length > 0) {
      issues.set('missing_required_clause:activation_trigger', {
        issue_id: 'missing_required_clause:activation_trigger',
        issue_type: 'missing_required_clause',
        priority: activationCoverage.criticality,
        field_ids: ['activation_trigger_type', 'authorization_required', 'performance_start_basis'],
        pattern_ids: activationPatternIds,
        reason:
          'The contract evidences an activation dependency, but the trigger details remain too incomplete for safe work-authorization reasoning.',
        evidence_anchors: dedupe(activationCoverage.evidence_anchors),
        resolution_effect: 'resolve_activation_gate',
      });
    } else {
      suppress(
        'missing_required_clause:activation_trigger',
        'Suppressed because no notice-to-proceed, task-order, work-order, or disaster-trigger dependency was actually evidenced.',
      );
    }
  }

  return {
    issues: [...issues.values()],
    suppressed: [...suppressed.values()],
  };
}
