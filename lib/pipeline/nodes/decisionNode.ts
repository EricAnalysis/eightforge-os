import { contractSkill } from '@/lib/skills/contractSkill';
import { invoiceSkill } from '@/lib/skills/invoiceSkill';
import { paymentRecommendationSkill } from '@/lib/skills/paymentRecommendationSkill';
import { ticketSkill } from '@/lib/skills/ticketSkill';
import type {
  DecisionNodeOutput,
  DocumentFamilySkill,
  NormalizeNodeOutput,
  PipelineDecision,
} from '@/lib/pipeline/types';

const SKILLS: Partial<Record<NormalizeNodeOutput['primaryDocument']['family'], DocumentFamilySkill>> = {
  contract: contractSkill,
  invoice: invoiceSkill,
  payment_recommendation: paymentRecommendationSkill,
  ticket: ticketSkill,
};

export function finalizePipelineDecision(decision: PipelineDecision): PipelineDecision {
  const evidence_objects = decision.evidence_objects ?? [];
  const source_refs =
    decision.source_refs && decision.source_refs.length > 0
      ? decision.source_refs
      : evidence_objects.map((evidence) => evidence.id);

  if (decision.reason && decision.reason.trim().length > 0) {
    return { ...decision, source_refs };
  }

  const cite = source_refs.length > 0 ? source_refs.join(', ') : 'none';
  const gaps =
    (decision.missing_source_context ?? []).filter((line) => line.trim().length > 0).join('; ') || 'none';

  if (decision.family === 'confirmed') {
    return {
      ...decision,
      source_refs,
      reason: `${decision.detail} Sources cited: ${cite}.`,
    };
  }

  return {
    ...decision,
    source_refs,
    reason:
      `${decision.detail} Evidence ids: ${cite}. Open gaps: ${gaps}. `
      + `Rule ${decision.rule_id ?? decision.id}; confidence ${Math.round(decision.confidence * 100)}%.`,
  };
}

export function decisionNode(input: NormalizeNodeOutput): DecisionNodeOutput {
  const skill = SKILLS[input.primaryDocument.family] ?? null;
  if (!skill) {
    return {
      ...input,
      skill: null,
      decisions: [],
      actions: [],
      audit_notes: [
        {
          id: 'audit:no_skill',
          stage: 'decision',
          status: 'info',
          message: `No deterministic skill is registered for the ${input.primaryDocument.family} family yet.`,
        },
      ],
    };
  }

  const execution = skill.run({
    primaryDocument: input.primaryDocument,
    relatedDocuments: input.relatedDocuments,
    projectName: null,
    allEvidenceById: new Map(input.evidence.map((evidence) => [evidence.id, evidence])),
    contractAnalysis: input.contractAnalysis ?? null,
  });

  return {
    ...input,
    skill,
    decisions: execution.decisions.map(finalizePipelineDecision),
    actions: execution.actions,
    audit_notes: execution.audit_notes,
  };
}
