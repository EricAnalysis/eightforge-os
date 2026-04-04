import {
  collectContractStructuredFieldRefs,
  collectStrictContractRateGroundingRefs,
  collectTextOnlyRateInferenceRef,
} from '@/lib/intelligence/groundingRefs';
import {
  classifyContractCeiling,
  contractCeilingDisplay,
  contractCeilingSummary,
} from '@/lib/contracts/contractCeiling';
import type { ContractAnalysisResult } from '@/lib/contracts/types';
import type { EvidenceObject } from '@/lib/extraction/types';
import type { DocumentFamilySkill, SkillExecutionOutput } from '@/lib/pipeline/types';
import {
  collectEvidenceByIds as collectEvidenceByIdsFromMap,
  evidenceForFact,
  getBooleanFact,
  getNumberFact,
  getStringFact,
  makeDecision,
  makeTask,
  primaryActionOnDocument,
} from '@/lib/skills/shared';

export const contractSkill: DocumentFamilySkill = {
  documentFamily: 'contract',
  requiredFacts: ['contractor_name', 'contract_ceiling', 'rate_schedule_present'],
  decisionRules: [
    'Confirm contractor identity only when a PDF or workbook cell cites the name.',
    'Require a cited rate schedule before matching invoice lines to contract prices.',
    'Treat rate-based not-to-exceed schedules as a ceiling model, not a missing ceiling.',
  ],
  actionGenerationRules: [
    'Use one imperative sentence per primary_action.description.',
    'Name the contract file in target_label; never use generic “review document”.',
  ],
  evidenceExpectations: [
    'Contractor name should map to an opening clause, signature block, or labeled form field.',
    'Ceiling evidence should map to either an explicit total NTE clause or a rate-based not-to-exceed schedule clause.',
    'Rate schedule should reference a page, section, or table context.',
  ],
  reviewTriggers: [
    'Missing contractor evidence',
    'Missing rate schedule evidence',
    'Missing contract ceiling',
  ],
  run(input): SkillExecutionOutput {
    const contractorFact = input.primaryDocument.fact_map.contractor_name ?? null;
    const ceilingFact = input.primaryDocument.fact_map.contract_ceiling ?? null;
    const rateFact = input.primaryDocument.fact_map.rate_schedule_present ?? null;

    const contractor = getStringFact(input.primaryDocument, 'contractor_name');
    const owner = getStringFact(input.primaryDocument, 'owner_name');
    const executedDate = getStringFact(input.primaryDocument, 'executed_date');
    const ceiling = getNumberFact(input.primaryDocument, 'contract_ceiling');
    const storedCeilingType = getStringFact(input.primaryDocument, 'contract_ceiling_type');
    const rateSchedulePresent = getBooleanFact(input.primaryDocument, 'rate_schedule_present');
    const ratePages = getStringFact(input.primaryDocument, 'rate_schedule_pages');

    const contractorEvidence = evidenceForFact(contractorFact, input.allEvidenceById);
    const ceilingEvidence = evidenceForFact(ceilingFact, input.allEvidenceById);
    const rateEvidence = evidenceForFact(rateFact, input.allEvidenceById);

    const structuredRefs = collectContractStructuredFieldRefs({
      contractorFromStructured: typeof input.primaryDocument.structured_fields.contractor_name === 'string',
      nteFromStructured: typeof input.primaryDocument.structured_fields.nte_amount === 'number',
    });
    const strictRateRefs = collectStrictContractRateGroundingRefs(input.primaryDocument.section_signals);
    const contractorCitation =
      contractorEvidence.length > 0 || structuredRefs.contractor.length > 0;
    const ceilingCitation =
      ceilingEvidence.length > 0 || structuredRefs.nte.length > 0;
    const rateCitation = rateEvidence.length > 0 || strictRateRefs.length > 0;
    const textRateHint =
      /rate schedule|unit price|compensation shall be based on|exhibit a\b/i.test(
        input.primaryDocument.text_preview,
      );
    const ceilingType = classifyContractCeiling({
      totalCeilingAmount: ceiling,
      machineClassification: ceilingFact?.machine_classification ?? null,
      text: input.primaryDocument.text_preview,
      rateSchedulePresent,
    });
    const ceilingDisplay = contractCeilingDisplay(
      storedCeilingType === 'total'
      || storedCeilingType === 'rate_based'
      || storedCeilingType === 'none'
        ? storedCeilingType
        : ceilingType,
    );
    const resolvedCeilingType =
      storedCeilingType === 'total'
      || storedCeilingType === 'rate_based'
      || storedCeilingType === 'none'
        ? storedCeilingType
        : ceilingType;
    const rateBasedCeilingResolved = resolvedCeilingType === 'rate_based';
    const rateBasedCeilingCitation =
      rateBasedCeilingResolved && (ceilingEvidence.length > 0 || rateCitation);

    const decisions: SkillExecutionOutput['decisions'] = [];
    const actions: SkillExecutionOutput['actions'] = [];
    const audit_notes: SkillExecutionOutput['audit_notes'] = [
      {
        id: 'audit:contract:evidence',
        stage: 'decision' as const,
        status: 'info' as const,
        message: (contractorCitation && rateCitation && (ceilingCitation || rateBasedCeilingCitation)
          ? 'Contract evidence includes contractor identity, ceiling, and rate schedule anchors.'
          : 'Contract evidence is incomplete for one or more required approval checks.') +
          ' [single-document scope]',
        evidence_refs: [
          ...contractorEvidence.map((evidence) => evidence.id),
          ...ceilingEvidence.map((evidence) => evidence.id),
          ...rateEvidence.map((evidence) => evidence.id),
        ],
      },
    ];

    if (contractor && contractorCitation) {
      decisions.push(makeDecision({
        id: 'contract:contractor_confirmed',
        family: 'confirmed',
        severity: 'info',
        title: 'Confirmed contractor identity',
        detail: `Contractor evidence resolves to ${contractor}.`,
        confidence: contractorFact?.confidence ?? 0.86,
        fact_refs: ['contractor_name'],
        evidence_objects: contractorEvidence,
        extra_source_refs: structuredRefs.contractor,
        missing_source_context: [],
        rule_id: 'contract_contractor_confirmed',
        field_key: 'contractor_name',
        reconciliation_scope: 'single_document',
      }));
    } else if (contractor && !contractorCitation) {
      const decisionId = 'contract:contractor_uncited';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'risk',
        severity: 'warning',
        title: 'Contractor name lacks cited source',
        detail:
          'A contractor value is present from typed fields, but no PDF/table cell or evidence_v1 structured contractor anchor was captured.',
        confidence: 0.55,
        fact_refs: ['contractor_name'],
        evidence_objects: contractorEvidence,
        extra_source_refs: [],
        missing_source_context: [
          'No labeled opening clause, signature block, or evidence_v1.structured_fields.contractor_name citation.',
        ],
        rule_id: 'contract_contractor_uncited',
        field_key: 'contractor_name',
        expected_location: 'opening clause or signature block',
        reconciliation_scope: 'single_document',
        primary_action: primaryActionOnDocument(input.primaryDocument, {
          id: 'action:contractor_citation',
          type: 'confirm',
          target_object_type: 'contract',
          description: 'Tag the contract page or field where the contractor legal name is printed.',
          expected_outcome: 'Contractor name is saved with a cited PDF page, form field, or structured evidence anchor.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:contractor_citation',
        title: 'Ground contractor name to a cited contract location',
        priority: 'medium',
        verb: 'confirm',
        entity_type: 'contract',
        flow_type: 'validation',
        expected_outcome: 'Contractor identity has page- or field-level evidence.',
        source_decision_ids: [decisionId],
      }));
    } else {
      const decisionId = 'contract:contractor_missing';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'missing',
        severity: 'warning',
        title: 'Missing contractor evidence',
        detail: 'Contractor identity could not be grounded to a labeled field, opening clause, or signature block.',
        confidence: 0.48,
        fact_refs: ['contractor_name'],
        evidence_objects: contractorEvidence,
        missing_source_context: ['No reliable contractor citation was found in the uploaded contract.'],
        rule_id: 'contract_contractor_missing',
        field_key: 'contractor_name',
        expected_location: 'opening clause or signature block',
        reconciliation_scope: 'single_document',
        primary_action: primaryActionOnDocument(input.primaryDocument, {
          id: 'action:contractor_identity',
          type: 'confirm',
          target_object_type: 'contract',
          description: 'Type the contractor legal name exactly as printed in the signature block.',
          expected_outcome: 'Contractor name is saved with a cited PDF page or sheet cell.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:contractor_identity',
        title: 'Confirm contractor identity from the contract record',
        priority: 'medium',
        verb: 'confirm',
        entity_type: 'contract',
        flow_type: 'validation',
        expected_outcome: 'Authoritative contractor identity is captured with contract evidence.',
        source_decision_ids: [decisionId],
      }));
    }

    if (textRateHint && !rateSchedulePresent) {
      decisions.push(makeDecision({
        id: 'contract:rate_schedule_inference_only',
        family: 'risk',
        severity: 'warning',
        title: 'Rate schedule language without exhibit or table grounding',
        detail:
          'Pricing language appears in text, but no evidence_v1 section signals or extracted pricing tables were grounded for this contract.',
        confidence: 0.72,
        fact_refs: ['rate_schedule_present'],
        evidence_objects: [],
        extra_source_refs: collectTextOnlyRateInferenceRef(true),
        missing_source_context: [
          'Attach Exhibit A pages, rate_section signals, or PDF table extractions before matching invoice lines to contract prices.',
        ],
        rule_id: 'contract_rate_schedule_inference_only',
        field_key: 'rate_schedule_present',
        reconciliation_scope: 'single_document',
      }));
    }

    if (rateSchedulePresent && rateCitation) {
      decisions.push(makeDecision({
        id: 'contract:rate_schedule_confirmed',
        family: 'confirmed',
        severity: 'info',
        title: 'Confirmed rate schedule evidence',
        detail: ratePages
          ? `Rate schedule evidence is present at ${ratePages}.`
          : 'Rate schedule evidence is present via extracted tables or section signals.',
        confidence: rateFact?.confidence ?? 0.82,
        fact_refs: ['rate_schedule_present'],
        evidence_objects: rateEvidence,
        extra_source_refs: strictRateRefs,
        missing_source_context: [],
        rule_id: 'contract_rate_schedule_confirmed',
        field_key: 'rate_schedule_present',
        reconciliation_scope: 'single_document',
      }));
    } else if (rateSchedulePresent && !rateCitation) {
      const decisionId = 'contract:rate_schedule_uncited';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'risk',
        severity: 'warning',
        title: 'Rate schedule flagged but lacks citations',
        detail:
          'Normalization detected a rate schedule, but no page-filtered evidence objects or strict section anchors were linked.',
        confidence: 0.58,
        fact_refs: ['rate_schedule_present'],
        evidence_objects: rateEvidence,
        extra_source_refs: strictRateRefs,
        missing_source_context: [
          'Link PDF table_row ids, form fields, or evidence_v1.section_signals for the pricing exhibit.',
        ],
        rule_id: 'contract_rate_schedule_uncited',
        field_key: 'rate_schedule_present',
        expected_location: 'rate schedule exhibit or pricing table',
        reconciliation_scope: 'single_document',
        primary_action: primaryActionOnDocument(input.primaryDocument, {
          id: 'action:rate_schedule_cite',
          type: 'attach',
          target_object_type: 'rate_schedule',
          description: 'Tag the PDF pages or tables that list unit prices for this contract.',
          expected_outcome: 'Rate schedule rows or section signals carry evidence ids.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:rate_schedule_cite',
        title: 'Ground rate schedule to cited pages or tables',
        priority: 'high',
        verb: 'attach',
        entity_type: 'rate_schedule',
        flow_type: 'documentation',
        expected_outcome: 'Contract rates are cited for cross-document matching.',
        source_decision_ids: [decisionId],
      }));
    } else if (!rateSchedulePresent && !textRateHint) {
      const decisionId = 'contract:rate_schedule_missing';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'missing',
        severity: 'warning',
        title: 'Missing rate schedule evidence',
        detail: 'The contract body is present, but no usable rate schedule evidence was grounded for downstream validation.',
        confidence: 0.52,
        fact_refs: ['rate_schedule_present'],
        evidence_objects: rateEvidence,
        missing_source_context: ['No table, exhibit, or section citation for contract rates was captured.'],
        rule_id: 'contract_rate_schedule_missing',
        field_key: 'rate_schedule_present',
        expected_location: 'rate schedule exhibit or pricing section',
        reconciliation_scope: 'single_document',
        primary_action: primaryActionOnDocument(input.primaryDocument, {
          id: 'action:rate_schedule',
          type: 'attach',
          target_object_type: 'rate_schedule',
          description: 'Tag the PDF pages or exhibit that list unit prices for this contract.',
          expected_outcome: 'Rate schedule pages are linked on the contract record.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:rate_schedule',
        title: 'Confirm contract rate schedule evidence',
        priority: 'high',
        verb: 'attach',
        entity_type: 'rate_schedule',
        flow_type: 'documentation',
        expected_outcome: 'A usable contract rate schedule is linked to the review record.',
        source_decision_ids: [decisionId],
      }));
    }

    if (ceiling != null && ceilingCitation) {
      decisions.push(makeDecision({
        id: 'contract:ceiling_confirmed',
        family: 'confirmed',
        severity: 'info',
        title: 'Confirmed contract ceiling',
        detail: `Contract ceiling evidence resolves to $${ceiling.toLocaleString('en-US', { maximumFractionDigits: 2 })}.`,
        confidence: ceilingFact?.confidence ?? 0.84,
        fact_refs: ['contract_ceiling'],
        evidence_objects: ceilingEvidence,
        extra_source_refs: structuredRefs.nte,
        missing_source_context: [],
        rule_id: 'contract_ceiling_confirmed',
        field_key: 'contract_ceiling',
        reconciliation_scope: 'single_document',
      }));
    } else if (rateBasedCeilingResolved && rateBasedCeilingCitation) {
      decisions.push(makeDecision({
        id: 'contract:ceiling_rate_based_confirmed',
        family: 'confirmed',
        severity: 'info',
        title: 'Confirmed rate-based ceiling model',
        detail: `${ceilingDisplay}: ${contractCeilingSummary('rate_based')}.`,
        confidence: ceilingFact?.confidence ?? 0.8,
        fact_refs: ['contract_ceiling', 'contract_ceiling_type'],
        evidence_objects: ceilingEvidence.length > 0 ? ceilingEvidence : rateEvidence,
        extra_source_refs:
          strictRateRefs.length > 0
            ? strictRateRefs
            : collectTextOnlyRateInferenceRef(true),
        missing_source_context: [],
        rule_id: 'contract_ceiling_rate_based_confirmed',
        field_key: 'contract_ceiling',
        reconciliation_scope: 'single_document',
      }));
    } else if (ceiling != null && !ceilingCitation) {
      const decisionId = 'contract:ceiling_uncited';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'risk',
        severity: 'critical',
        title: 'Contract ceiling value without clause citation',
        detail:
          'A not-to-exceed amount is present from typed fields, but no regex-matched NTE clause or structured evidence_v1.nte_amount anchor was captured.',
        confidence: 0.62,
        fact_refs: ['contract_ceiling'],
        evidence_objects: ceilingEvidence,
        extra_source_refs: [],
        missing_source_context: ['Ground the ceiling to a not-to-exceed clause or evidence_v1 structured NTE field.'],
        rule_id: 'contract_ceiling_uncited',
        field_key: 'contract_ceiling',
        expected_location: 'not-to-exceed or compensation clause',
        reconciliation_scope: 'single_document',
        primary_action: primaryActionOnDocument(input.primaryDocument, {
          id: 'action:ceiling_citation',
          type: 'confirm',
          target_object_type: 'contract',
          description: 'Tag the contract clause or table cell that states the not-to-exceed amount.',
          expected_outcome: 'Ceiling is stored with a cited source location.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:ceiling_citation',
        title: 'Ground contract ceiling to a cited clause',
        priority: 'high',
        verb: 'confirm',
        entity_type: 'contract',
        flow_type: 'validation',
        expected_outcome: 'NTE amount links to PDF or structured evidence.',
        source_decision_ids: [decisionId],
      }));
    } else {
      const decisionId = 'contract:ceiling_missing';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'risk',
        severity: 'critical',
        title: 'Missing contract ceiling',
        detail: 'No explicit contract ceiling or not-to-exceed amount was grounded from the uploaded contract package.',
        confidence: 0.58,
        fact_refs: ['contract_ceiling', 'contract_ceiling_type'],
        evidence_objects: ceilingEvidence,
        missing_source_context: ['No cited not-to-exceed clause was found.'],
        rule_id: 'contract_ceiling_missing',
        field_key: 'contract_ceiling',
        impact: 'payment approvals and recommendation checks remain unbounded until the ceiling is resolved',
        reconciliation_scope: 'single_document',
        primary_action: primaryActionOnDocument(input.primaryDocument, {
          id: 'action:contract_ceiling',
          type: 'escalate',
          target_object_type: 'contract',
          description: 'Enter the not-to-exceed dollar amount from the contract compensation clause.',
          expected_outcome: 'Contract ceiling is stored with a cited clause or table.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:contract_ceiling',
        title: 'Resolve missing contract ceiling',
        priority: 'high',
        verb: 'escalate',
        entity_type: 'contract',
        flow_type: 'escalation',
        expected_outcome: 'Contract ceiling is documented before payment decisions proceed.',
        source_decision_ids: [decisionId],
      }));
    }

    const intelligenceIssueOutput = buildContractIssueOutput({
      analysis: input.contractAnalysis ?? null,
      document: input.primaryDocument,
      allEvidenceById: input.allEvidenceById,
    });
    decisions.push(...intelligenceIssueOutput.decisions);
    actions.push(...intelligenceIssueOutput.actions);

    if (owner || executedDate) {
      audit_notes.push({
        id: 'audit:contract:key_terms',
        stage: 'audit',
        status: 'info',
        message:
          `[single-document scope] Key terms extracted${owner ? `; client: ${owner}` : ''}${executedDate ? `; executed: ${executedDate}` : ''}.`,
        fact_refs: ['owner_name', 'executed_date'],
      });
    }

    return {
      decisions,
      actions,
      audit_notes,
    };
  },
};

function buildContractIssueOutput(params: {
  analysis: ContractAnalysisResult | null | undefined;
  document: Parameters<typeof primaryActionOnDocument>[0];
  allEvidenceById: Map<string, EvidenceObject>;
}): Pick<SkillExecutionOutput, 'decisions' | 'actions'> {
  if (!params.analysis) {
    return { decisions: [], actions: [] };
  }

  const decisions: SkillExecutionOutput['decisions'] = [];
  const actions: SkillExecutionOutput['actions'] = [];

  for (const issue of params.analysis.issues) {
    const evidenceObjects = collectEvidenceByIdsFromMap(issue.evidence_anchors, params.allEvidenceById);
    const baseId = `contract:intelligence:${issue.issue_id}`;
    const severity =
      issue.priority === 'P1' ? 'critical' :
      issue.priority === 'P2' ? 'warning' :
      'info';
    const family =
      issue.issue_type === 'conflicting_evidence' ? 'mismatch' :
      issue.issue_type === 'missing_required_clause' ? 'missing' :
      'risk';
    const title =
      issue.issue_type === 'derived_value_requires_confirmation'
        ? 'Derived term value requires confirmation'
        : issue.issue_type === 'conflicting_evidence'
          ? 'Conflicting contractor identity evidence'
          : issue.issue_type === 'conditional_without_trigger_status'
            ? 'Activation trigger detected but status unresolved'
            : issue.issue_type === 'pricing_applicability_unclear'
              ? 'Pricing schedule present, applicability unresolved'
              : issue.issue_type === 'documentation_prerequisite_unclear'
                ? 'Documentation prerequisites remain unclear'
                : issue.issue_type === 'fema_gate_ambiguous'
                  ? 'FEMA eligibility gate is ambiguous'
                  : 'Missing required contract clause';

    const primaryAction =
      issue.issue_type === 'pricing_applicability_unclear'
        ? primaryActionOnDocument(params.document, {
            id: `${baseId}:action`,
            type: 'confirm',
            target_object_type: 'rate_schedule',
            description: 'Confirm which contract rate lines actually govern the authorized work.',
            expected_outcome: 'Pricing applicability is resolved before billing or reimbursement logic uses the schedule.',
          })
        : issue.issue_type === 'conditional_without_trigger_status' || issue.issue_type === 'missing_required_clause'
          ? primaryActionOnDocument(params.document, {
              id: `${baseId}:action`,
              type: 'escalate',
              target_object_type: 'contract',
              description: 'Confirm the activation basis before treating the contract as work-authorizing.',
              expected_outcome: 'Activation dependency is resolved for downstream operations and billing.',
            })
          : issue.issue_type === 'fema_gate_ambiguous'
            ? primaryActionOnDocument(params.document, {
                id: `${baseId}:action`,
                type: 'document',
                target_object_type: 'contract',
                description: 'Document the FEMA eligibility restrictions and the supporting evidence for reimbursement review.',
                expected_outcome: 'FEMA gate handling is explicit before reimbursement logic depends on it.',
              })
            : primaryActionOnDocument(params.document, {
                id: `${baseId}:action`,
                type: 'confirm',
                target_object_type: 'contract',
                description: 'Review and confirm the contract meaning at the cited source locations.',
                expected_outcome: 'The contract issue is resolved with cited evidence.',
              });

    decisions.push(makeDecision({
      id: baseId,
      family,
      severity,
      title,
      detail: issue.reason,
      confidence: issue.priority === 'P1' ? 0.82 : 0.7,
      fact_refs: issue.field_ids,
      evidence_objects: evidenceObjects,
      missing_source_context: evidenceObjects.length === 0
        ? ['No direct evidence anchor was carried into the contract intelligence issue.']
        : [],
      rule_id: `contract_intelligence:${issue.issue_type}`,
      field_key: issue.field_ids[0],
      reason: issue.reason,
      primary_action: primaryAction,
      reconciliation_scope: 'single_document',
    }));

    actions.push(makeTask({
      id: `${baseId}:task`,
      title,
      priority:
        issue.priority === 'P1' ? 'high' :
        issue.priority === 'P2' ? 'medium' :
        'low',
      verb:
        issue.issue_type === 'fema_gate_ambiguous' ? 'confirm' :
        issue.issue_type === 'conditional_without_trigger_status'
          || issue.issue_type === 'missing_required_clause'
          ? 'escalate'
          : 'confirm',
      entity_type:
        issue.issue_type === 'pricing_applicability_unclear' ? 'rate_schedule' : 'contract',
      flow_type:
        issue.issue_type === 'fema_gate_ambiguous'
          ? 'documentation'
          : issue.issue_type === 'conditional_without_trigger_status'
            || issue.issue_type === 'missing_required_clause'
            ? 'escalation'
            : 'validation',
      expected_outcome: issue.resolution_effect,
      source_decision_ids: [baseId],
    }));
  }

  return { decisions, actions };
}
