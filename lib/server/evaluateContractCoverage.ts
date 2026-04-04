import type { EvidenceObject } from '@/lib/extraction/types';
import { COVERAGE_LIBRARY_V1 } from '@/lib/contracts/coverageLibrary.v1';
import type {
  ContractAnalysisResult,
  ContractCeilingType,
  ContractCoverageResult,
  ContractDocumentTypeProfile,
  ContractEvidenceDistribution,
  ContractExtractionQuality,
  ContractFieldAnalysis,
} from '@/lib/contracts/types';

type EvaluateContractCoverageInput = {
  documentTypeProfile: ContractDocumentTypeProfile | null;
  contractAnalysis: Omit<ContractAnalysisResult, 'coverage_status' | 'issues' | 'trace_summary'>;
  evidenceById: Map<string, EvidenceObject>;
  scopeCategoryEvidenceAnchors?: string[];
};

function flattenFields(
  contractAnalysis: EvaluateContractCoverageInput['contractAnalysis'],
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

function classifyEvidenceDistribution(
  evidenceIds: string[],
  evidenceById: Map<string, EvidenceObject>,
): ContractEvidenceDistribution {
  const evidence = evidenceIds
    .map((id) => evidenceById.get(id) ?? null)
    .filter((item): item is EvidenceObject => item != null);
  if (evidence.length === 0) return 'none';

  const pageSet = new Set(
    evidence
      .map((item) => item.location.page)
      .filter((page): page is number => typeof page === 'number'),
  );
  const exhibitLike = evidence.every((item) =>
    /exhibit|attachment|schedule/i.test(
      `${item.description} ${item.location.section ?? ''} ${item.location.label ?? ''}`,
    ),
  );
  const tableLike = evidence.every((item) =>
    item.kind === 'table'
      || item.kind === 'table_row'
      || item.kind === 'sheet_row'
      || item.kind === 'sheet_cell',
  );

  if (tableLike) return 'table_only';
  if (exhibitLike) return 'exhibit_only';
  if (pageSet.size <= 1) return 'same_page';
  return 'multi_page';
}

function qualityFromField(field: ContractFieldAnalysis | null): ContractExtractionQuality {
  if (!field) return 'missing';
  if (field.state === 'missing_critical') return 'missing';
  if (field.state === 'conflicted') return 'weak';
  if (field.state === 'derived' || field.state === 'conditional') return 'partial';
  if (field.evidence_anchors.length === 0) return 'partial';
  return 'strong';
}

function hasCoverageSignal(field: ContractFieldAnalysis | null): boolean {
  if (!field) return false;
  if (field.state === 'missing_critical') return false;
  if (Array.isArray(field.value)) return field.value.length > 0;
  return field.value != null || field.evidence_anchors.length > 0;
}

function maxQuality(
  left: ContractExtractionQuality,
  right: ContractExtractionQuality,
): ContractExtractionQuality {
  const ranks: Record<ContractExtractionQuality, number> = {
    missing: 0,
    weak: 1,
    partial: 2,
    strong: 3,
  };
  return ranks[left] >= ranks[right] ? left : right;
}

function needsOperatorReview(states: string[], result: ContractCoverageResult): boolean {
  if (result.expected_for_doc_type !== true) return false;
  if (result.criticality === 'P1' && result.extraction_quality !== 'strong') return true;
  return states.some((state) => result.operator_review_if.includes(state));
}

export function evaluateContractCoverage(
  input: EvaluateContractCoverageInput,
): ContractCoverageResult[] {
  if (!input.documentTypeProfile) return [];

  const definitions = COVERAGE_LIBRARY_V1[input.documentTypeProfile] ?? [];
  const fields = flattenFields(input.contractAnalysis);
  const patterns = new Map(
    input.contractAnalysis.clause_patterns_detected.map((pattern) => [pattern.pattern_id, pattern] as const),
  );

  return definitions.map((definition) => {
    let found = false;
    let extractionQuality: ContractExtractionQuality = 'missing';
    let evidenceAnchors: string[] = [];
    const states: string[] = [];

    const contractorField = fields.get('contractor_name') ?? null;
    const termField = fields.get('initial_term_length') ?? null;
    const expirationField = fields.get('expiration_date') ?? null;
    const activationField = fields.get('activation_trigger_type') ?? null;
    const pricingField = fields.get('pricing_applicability') ?? null;
    const rateField = fields.get('rate_schedule_present') ?? null;
    const docsField = fields.get('billing_documentation_required') ?? null;
    const monitoringField = fields.get('monitoring_required') ?? null;
    const femaField = fields.get('fema_eligibility_gate') ?? null;
    const ceilingField = fields.get('contract_ceiling') ?? null;
    const ceilingTypeField = fields.get('contract_ceiling_type') ?? null;

    switch (definition.coverage_id) {
      case 'term_trigger': {
        const executionPattern = patterns.get('execution_based_term') ?? null;
        found =
          hasCoverageSignal(termField)
          || hasCoverageSignal(expirationField)
          || executionPattern != null;
        extractionQuality = maxQuality(
          qualityFromField(termField),
          qualityFromField(expirationField),
        );
        evidenceAnchors = dedupe([
          ...(termField?.evidence_anchors ?? []),
          ...(expirationField?.evidence_anchors ?? []),
          ...(executionPattern?.evidence_anchors ?? []),
        ]);
        states.push(termField?.state ?? 'missing', expirationField?.state ?? 'missing');
        break;
      }
      case 'activation_trigger': {
        const activationPatterns = [
          patterns.get('ntp_activation'),
          patterns.get('task_order_activation'),
          patterns.get('disaster_triggered_activation'),
        ].filter(Boolean);
        found = hasCoverageSignal(activationField) || activationPatterns.length > 0;
        extractionQuality = qualityFromField(activationField);
        evidenceAnchors = dedupe([
          ...(activationField?.evidence_anchors ?? []),
          ...activationPatterns.flatMap((pattern) => pattern?.evidence_anchors ?? []),
        ]);
        states.push(activationField?.state ?? 'missing');
        break;
      }
      case 'pricing_schedule': {
        found = rateField?.value === true;
        extractionQuality = qualityFromField(rateField);
        evidenceAnchors = dedupe(rateField?.evidence_anchors ?? []);
        states.push(rateField?.state ?? 'missing');
        break;
      }
      case 'pricing_applicability': {
        found = hasCoverageSignal(pricingField);
        extractionQuality = qualityFromField(pricingField);
        evidenceAnchors = dedupe([
          ...(pricingField?.evidence_anchors ?? []),
          ...(patterns.get('unit_rate_schedule')?.evidence_anchors ?? []),
          ...(patterns.get('pass_through_disposal')?.evidence_anchors ?? []),
          ...(patterns.get('fema_eligibility_restriction')?.evidence_anchors ?? []),
        ]);
        states.push(pricingField?.state ?? 'missing');
        break;
      }
      case 'scope_categories': {
        evidenceAnchors = dedupe(input.scopeCategoryEvidenceAnchors ?? []);
        found = evidenceAnchors.length > 0;
        extractionQuality = found ? (evidenceAnchors.length >= 2 ? 'strong' : 'partial') : 'missing';
        states.push(found ? 'explicit' : 'missing');
        break;
      }
      case 'documentation_prerequisites': {
        found = hasCoverageSignal(docsField) || patterns.has('ticket_load_documentation');
        extractionQuality = qualityFromField(docsField);
        evidenceAnchors = dedupe([
          ...(docsField?.evidence_anchors ?? []),
          ...(patterns.get('ticket_load_documentation')?.evidence_anchors ?? []),
          ...(patterns.get('audit_record_retention')?.evidence_anchors ?? []),
        ]);
        states.push(docsField?.state ?? 'missing');
        break;
      }
      case 'monitoring_dependency': {
        found = hasCoverageSignal(monitoringField) || patterns.has('monitoring_dependency');
        extractionQuality = qualityFromField(monitoringField);
        evidenceAnchors = dedupe([
          ...(monitoringField?.evidence_anchors ?? []),
          ...(patterns.get('monitoring_dependency')?.evidence_anchors ?? []),
        ]);
        states.push(monitoringField?.state ?? 'missing');
        break;
      }
      case 'fema_eligibility': {
        found = hasCoverageSignal(femaField) || patterns.has('fema_eligibility_restriction');
        extractionQuality = qualityFromField(femaField);
        evidenceAnchors = dedupe([
          ...(femaField?.evidence_anchors ?? []),
          ...(patterns.get('fema_eligibility_restriction')?.evidence_anchors ?? []),
        ]);
        states.push(femaField?.state ?? 'missing');
        break;
      }
      case 'contract_ceiling': {
        const ceilingType =
          ceilingTypeField?.value === 'total'
          || ceilingTypeField?.value === 'rate_based'
          || ceilingTypeField?.value === 'none'
            ? (ceilingTypeField.value as ContractCeilingType)
            : ceilingField?.value != null
              ? 'total'
              : 'none';
        found = ceilingType === 'total' || ceilingType === 'rate_based';
        extractionQuality =
          ceilingType === 'total'
            ? qualityFromField(ceilingField)
            : ceilingType === 'rate_based'
              ? qualityFromField(ceilingTypeField)
              : 'missing';
        evidenceAnchors = dedupe([
          ...(ceilingTypeField?.evidence_anchors ?? []),
          ...(ceilingField?.evidence_anchors ?? []),
          ...(patterns.get('not_to_exceed')?.evidence_anchors ?? []),
        ]);
        states.push(
          ceilingType === 'rate_based'
            ? 'explicit'
            : ceilingTypeField?.state ?? ceilingField?.state ?? 'missing',
        );
        break;
      }
      case 'contractor_identity_consistency': {
        found = hasCoverageSignal(contractorField);
        extractionQuality = qualityFromField(contractorField);
        evidenceAnchors = dedupe(contractorField?.evidence_anchors ?? []);
        states.push(contractorField?.state ?? 'missing');
        break;
      }
      default:
        break;
    }

    const result: ContractCoverageResult = {
      ...definition,
      found,
      extraction_quality: found ? extractionQuality : 'missing',
      evidence_count: evidenceAnchors.length,
      evidence_distribution: classifyEvidenceDistribution(evidenceAnchors, input.evidenceById),
      operator_review_required: false,
      evidence_anchors: evidenceAnchors,
    };

    result.operator_review_required = needsOperatorReview(states, result);
    return result;
  });
}
