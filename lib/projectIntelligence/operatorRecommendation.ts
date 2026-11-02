import type { OperatorIntent } from '@/lib/projectIntelligence/contextPlan';
import {
  NEXT_STEP_KINDS,
  type AssessmentConfidence,
  type AssessedDocument,
  type EvidenceState,
  type FindingAssessment,
  type NextStepKind,
  type ProjectEvidenceAssessment,
} from '@/lib/projectIntelligence/evidenceAssessment';
import { contextRecordIndex, type ProjectIntelligenceContext } from '@/lib/projectIntelligence/projectContext';
import { transactionContextNote, type TransactionContextPayload } from '@/lib/projectIntelligence/transactionContext';
import { resolveValidatorRuleActions } from '@/lib/validator/ruleActions';

/**
 * The operator recommendation contract. It keeps apart what was found, what to
 * do, what is still uncertain and what it rests on, in project language, whether
 * a person's question was answered by deterministic evidence alone or with a
 * model's reasoning. It carries no write path: a recommendation names a next
 * step, and the operator takes it on that step's own typed route.
 *
 * Internal diagnosis never appears here. See improvementSignal.ts.
 */

export { NEXT_STEP_KINDS, type NextStepKind };

export type OperatorEvidenceRef = Readonly<{
  recordId: string;
  sectionKind: string;
  label: string;
  documentId: string | null;
  page: number | null;
}>;

export type OperatorRecommendation = Readonly<{
  authority: 'non_authoritative';
  method: 'deterministic' | 'model_reasoned';
  intent: OperatorIntent;
  /** The reading it rests on. A view for this answer, not a truth state. */
  evidenceState: EvidenceState | 'no_open_findings' | 'validation_not_run';
  /** What was found. */
  answer: string;
  /** What to do, and where. */
  recommendedNextStep: Readonly<{ kind: NextStepKind; instruction: string; actionHref: string | null }>;
  /** What it rests on. Every entry resolves to a record in this project's context. */
  evidenceRefs: readonly OperatorEvidenceRef[];
  confidence: AssessmentConfidence;
  /** What is still uncertain. */
  missingInformation: readonly string[];
  needsHumanReview: boolean;
}>;

/**
 * Words that describe how EightForge works rather than the operator's project.
 * Fine in a product signal, never in an operator's answer.
 */
const INTERNAL_VOCABULARY = /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b|\b(?:traversal|canonical|rule pack|rule_id|code change|codebase|pull request|deterministic|extraction pipeline|parser|schema|migration|forgewing|orchestrator|document_precedence|project_validation_findings)\b/iu;

/** The internal term in this text, if any. */
export function internalVocabularyIn(text: string): string | null {
  return INTERNAL_VOCABULARY.exec(text)?.[0] ?? null;
}

/** A claim that something was done. A recommendation can only ever say what to do. */
const AUTHORITY_CLAIM = /\b(?:i|we|forgewing|eightforge)\s+(?:have\s+|has\s+|just\s+)?(?:approved|cleared|resolved|linked|updated|changed|corrected|overrode|overridden|applied|closed|set|marked|established|deleted|uploaded)\b|\b(?:has|have)\s+been\s+(?:approved|cleared|resolved|overridden)\s+by\s+(?:forgewing|eightforge|me|us)\b/iu;

export function authorityClaimIn(text: string): string | null {
  return AUTHORITY_CLAIM.exec(text)?.[0] ?? null;
}

function titled(documents: readonly AssessedDocument[]): string {
  const titles = documents.slice(0, 3).map((document) => `"${document.title}"`);
  return titles.join(titles.length === 2 ? ' and ' : ', ');
}

function linkInstruction(primary: FindingAssessment): string {
  const contract = primary.governingContract;
  return contract
    ? `Check whether ${titled(primary.candidates)} is linked to the governing contract, "${contract.title}", and link it if it applies.`
    : `Establish the governing contract, then check whether ${titled(primary.candidates)} should be linked to it.`;
}

function sourceGapText(primary: FindingAssessment): Readonly<{ answer: string; instruction: string }> {
  const source = primary.neededSource ?? 'source';
  switch (primary.state) {
    case 'source_missing':
      return {
        answer: `This project has no ${source}. It looks genuinely absent, not just unlinked.`,
        instruction: `Upload the ${source}, or request it from whoever holds it.`,
      };
    case 'source_present_unread':
      return {
        answer: `The ${source} appears to already be in this project as ${titled(primary.candidates)}, but it has not been read successfully. You probably do not need another document.`,
        instruction: `Open ${titled(primary.candidates)} and check that it processed, then reprocess it if it did not.`,
      };
    case 'source_present_relationship_unresolved':
      return {
        answer: `The ${source} appears to already exist in this project as ${titled(primary.candidates)}. No additional document appears necessary.`,
        instruction: linkInstruction(primary),
      };
    case 'source_present':
      return {
        answer: `The ${source} is in this project as ${titled(primary.candidates)}, and it was read after the latest validation. You probably do not need another document.`,
        instruction: 'Run validation again, then review whether this is still flagged.',
      };
    case 'likely_system_issue':
      return {
        answer: `The ${source} is in this project as ${titled(primary.candidates)}, and it has been read and linked, yet this is still flagged. This looks like an issue on the EightForge side rather than something missing from your project.`,
        instruction: `Check that ${titled(primary.candidates)} shows what you expect. If it does, report this to your EightForge contact.`,
      };
    default:
      return {
        answer: `Whether this project already has the ${source} could not be checked just now.`,
        instruction: 'Review the project documents directly, or ask again shortly.',
      };
  }
}

const NON_GAP_INSTRUCTIONS: Readonly<Partial<Record<NextStepKind, string>>> = Object.freeze({
  correct_source_data: 'Check the flagged line against its source, then correct it or its rate link.',
  review_ticket_or_transaction: 'Compare the flagged lines with their tickets or transactions.',
  operator_judgment_required: 'Review the cited records and decide on the finding through its own workflow.',
  review_existing_document: 'Open the cited evidence and check it against the document.',
});

function actionForStep(step: NextStepKind): 'upload_document' | 'open_linked_documents' | 'open_evidence_inspector' | null {
  if (step === 'upload_or_request_document') return 'upload_document';
  if (step === 'link_existing_document') return 'open_linked_documents';
  if (step === 'review_existing_document' || step === 'correct_source_data') return 'open_evidence_inspector';
  return null;
}

/**
 * The existing route for a step, resolved by the catalogue's own resolver. A
 * step the rule does not offer, or that does not apply to this finding, has no
 * link rather than an approximate one.
 */
export function nextStepActionHref(
  step: NextStepKind,
  primary: FindingAssessment | null,
  context: ProjectIntelligenceContext,
  finding: Readonly<{ subjectId: string | null; evidenceDocumentIds: readonly string[]; page: number | null }> | null,
): string | null {
  const wanted = actionForStep(step);
  if (!wanted || !primary?.ruleId || !finding) return null;
  const evidenceIds = [...finding.evidenceDocumentIds, ...primary.candidates.map((document) => document.id)];
  const resolved = resolveValidatorRuleActions({
    ruleId: primary.ruleId, projectId: context.projectId, findingId: primary.findingId, subjectId: finding.subjectId ?? '',
    evidence: evidenceIds.map((documentId, index) => ({ documentId, page: index === 0 ? finding.page : null })),
  }).find((action) => action.kind === wanted);
  return resolved && 'href' in resolved ? resolved.href : null;
}

export function resolveEvidenceRefs(context: ProjectIntelligenceContext, recordIds: readonly string[]): OperatorEvidenceRef[] {
  const index = contextRecordIndex(context);
  return [...new Set(recordIds)].flatMap((recordId) => {
    const record = index.get(recordId);
    return record ? [{ recordId, sectionKind: record.sectionKind, label: record.label,
      documentId: record.documentId, page: record.page }] : [];
  });
}

function intentAnswerSuffix(assessment: ProjectEvidenceAssessment): string {
  const others = assessment.openFindingCount - 1;
  if (others <= 0) return '';
  return ` ${others} other open ${others === 1 ? 'finding is' : 'findings are'} listed for this project as well.`;
}

/**
 * What a question about tickets adds to the answer: the aggregates on file and the
 * upload they came from. It changes neither the reading nor the next step, and a
 * plan that did not ask for ticket data gets the recommendation back untouched.
 */
function withTransactionContext(recommendation: OperatorRecommendation, context: ProjectIntelligenceContext): OperatorRecommendation {
  const omission = context.omissions.find((entry) => entry.kind === 'transaction_context')?.reason;
  if (omission === 'read_failed') {
    return { ...recommendation, missingInformation: [...recommendation.missingInformation, "This project's ticket data, which could not be read just now."] };
  }
  if (omission === 'not_available') {
    return { ...recommendation, answer: `${recommendation.answer} No ticket data has been read for this project.` };
  }
  const section = context.sections.find((entry) => entry.kind === 'transaction_context');
  if (!section) return recommendation;
  const payload = section.payload as TransactionContextPayload;
  const note = transactionContextNote(payload);
  const known = new Set(recommendation.evidenceRefs.map((ref) => ref.recordId));
  const uploads = payload.datasets.slice(0, 1).map((dataset) => dataset.id).filter((id) => !known.has(id));
  return {
    ...recommendation,
    answer: note ? `${recommendation.answer} ${note}` : recommendation.answer,
    evidenceRefs: [...recommendation.evidenceRefs, ...resolveEvidenceRefs(context, uploads)],
  };
}

/**
 * What to tell the operator from evidence alone. This is the floor: it needs no
 * provider, it is what a closed gate or a rejected model answer falls back to,
 * and it runs for a Core organization exactly as for an entitled one.
 */
export function deterministicRecommendation(params: Readonly<{
  context: ProjectIntelligenceContext;
  assessment: ProjectEvidenceAssessment;
  primaryFinding: Readonly<{ subjectId: string | null; evidenceDocumentIds: readonly string[]; page: number | null }> | null;
}>): OperatorRecommendation {
  return withTransactionContext(evidenceRecommendation(params), params.context);
}

function evidenceRecommendation(params: Readonly<{
  context: ProjectIntelligenceContext;
  assessment: ProjectEvidenceAssessment;
  primaryFinding: Readonly<{ subjectId: string | null; evidenceDocumentIds: readonly string[]; page: number | null }> | null;
}>): OperatorRecommendation {
  const { context, assessment } = params;
  const base = { authority: 'non_authoritative' as const, method: 'deterministic' as const, intent: assessment.intent };
  const identity = resolveEvidenceRefs(context, [context.projectId]);
  if (assessment.projectState === 'no_open_findings') {
    return { ...base, evidenceState: 'no_open_findings',
      answer: 'Validation has run and this project has no open findings, so nothing currently indicates a missing document or a required action.',
      recommendedNextStep: { kind: 'no_action_needed', instruction: 'Nothing is required right now.', actionHref: null },
      evidenceRefs: identity, confidence: 'high', missingInformation: [], needsHumanReview: false };
  }
  if (assessment.projectState === 'validation_not_run' || assessment.projectState === 'evidence_unavailable') {
    const unread = assessment.projectState === 'evidence_unavailable';
    return { ...base, evidenceState: unread ? 'evidence_unavailable' : 'validation_not_run',
      answer: unread
        ? "This project's findings could not be read just now, so nothing can be concluded about what it needs."
        : 'Validation has not finished for this project, so there is no reliable list of what it needs yet.',
      recommendedNextStep: { kind: 'operator_judgment_required',
        instruction: unread ? 'Ask again shortly.' : 'Run validation, then ask again.', actionHref: null },
      evidenceRefs: identity, confidence: 'low',
      missingInformation: [unread ? 'The current findings.' : 'A completed validation run.'], needsHumanReview: true };
  }
  const primary = assessment.primary!;
  const step = primary.nextSteps[0] ?? 'operator_judgment_required';
  const text = primary.neededSource != null ? sourceGapText(primary) : {
    answer: `This project is flagged for: ${primary.title}.`,
    instruction: NON_GAP_INSTRUCTIONS[step] ?? 'Review the cited records.',
  };
  const decisionNote = primary.linkedOpenDecisionId ? ' An open decision already covers this.' : '';
  return {
    ...base, evidenceState: primary.state,
    answer: `${text.answer}${decisionNote}${intentAnswerSuffix(assessment)}`,
    recommendedNextStep: { kind: step, instruction: text.instruction,
      actionHref: nextStepActionHref(step, primary, context, params.primaryFinding) },
    evidenceRefs: resolveEvidenceRefs(context, primary.evidenceRecordIds),
    confidence: primary.confidence,
    missingInformation: primary.uncertainties,
    needsHumanReview: true,
  };
}
