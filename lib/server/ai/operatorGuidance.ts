import { z } from 'zod';

import type { FindingAssessment, NextStepKind, ProjectEvidenceAssessment } from '@/lib/projectIntelligence/evidenceAssessment';
import {
  authorityClaimIn,
  internalVocabularyIn,
  resolveEvidenceRefs,
  type OperatorRecommendation,
} from '@/lib/projectIntelligence/operatorRecommendation';
import { citableRecords, numericTokens, providerRequestContext } from '@/lib/server/caseInvestigationRunner';
import type { AssessmentConfidence } from '@/lib/projectIntelligence/evidenceAssessment';
import type { ProjectIntelligenceContext } from '@/lib/projectIntelligence/projectContext';

/**
 * Factual and authority validation of a model's operator guidance, kept apart
 * from any token or cost ceiling. An answer that fails is dropped whole and the
 * operator gets the deterministic recommendation instead: nothing is repaired,
 * and a failure is never shown as an answer.
 *
 * The citation refs are the shared helpers, reused unchanged. The number check is
 * this path's own (guidanceUnsupportedNumbers), and the shared one stays as it is so
 * Case Investigation's parked records keep their meaning. These checks are why its
 * failure modes cannot reach an operator here: a number the context did not carry is
 * refused, and the next step can only be one the evidence reading already offered.
 */

const OutputSchema = z.object({
  answer: z.string().trim().min(1).max(4000),
  nextStepKind: z.string().min(1).max(64),
  nextStepInstruction: z.string().trim().min(1).max(1000),
  citations: z.array(z.string().min(1).max(8)).min(1).max(16),
  missingInformation: z.array(z.string().trim().min(1).max(500)).max(12),
  confidence: z.enum(['high', 'medium', 'low']),
}).strict();

export type GuidanceRejectionReason =
  | 'truncated'
  | 'refused'
  | 'output_not_json'
  | 'output_schema'
  | 'next_step_not_offered'
  | 'citation_unresolved'
  | 'unsupported_number'
  | 'internal_vocabulary'
  | 'authority_claim';

const CONFIDENCE_ORDER: readonly AssessmentConfidence[] = ['low', 'medium', 'high'];

/** The lower of the two: a model can lower confidence in a reading, never raise it. */
function cappedConfidence(model: AssessmentConfidence, floor: AssessmentConfidence): AssessmentConfidence {
  return CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.indexOf(model), CONFIDENCE_ORDER.indexOf(floor))]!;
}

function assessmentForModel(entry: FindingAssessment) {
  return {
    findingId: entry.findingId, title: entry.title, reading: entry.state, neededSource: entry.neededSource,
    candidateDocuments: entry.candidates.map((document) => ({
      id: document.id, title: document.title, read: document.read,
      linkedToGoverningContract: document.linkedToContract, authorityUnsettled: document.authorityUnsettled,
    })),
    governingContract: entry.governingContract,
    openDecisionAlreadyCoversThis: entry.linkedOpenDecisionId != null,
    stillUncertain: entry.uncertainties,
  };
}

/**
 * The context's transmitted sections, plus the deterministic reading as a section of
 * its own, before any wording is changed for the operator. Only sections the policy let
 * through are here.
 */
export function guidanceSourceContext(context: ProjectIntelligenceContext, assessment: ProjectEvidenceAssessment) {
  const sections = [
    ...context.sections.filter((section) => section.transmitted),
    {
      kind: 'evidence_assessment',
      provenance: { source: 'evidence_assessment', projectId: context.projectId, recordIds: [] as string[] },
      payload: {
        projectState: assessment.projectState, openFindingCount: assessment.openFindingCount,
        primary: assessment.primary ? assessmentForModel(assessment.primary) : null,
        otherOpenFindings: assessment.others.slice(0, 8).map(assessmentForModel),
      },
    },
  ];
  return { sections, request: providerRequestContext(sections) };
}

/** Values that are only ever system enums. Underscores become spaces. */
const ENUM_VALUE_KEYS: ReadonlySet<string> = new Set(['field', 'fieldKey', 'type', 'family', 'subtype', 'reason', 'reading', 'projectState', 'authorityStatus', 'sourceKind', 'validationStatus']);
/** Text the system wrote, not a person or a source document. Only the closed list below changes in it. */
const SYSTEM_TEXT_KEYS: ReadonlySet<string> = new Set(['description', 'expected', 'actual', 'snippet', 'whatItChecks', 'requiredAction']);
const OPERATOR_TERMS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze(([
  ['extended_cost', 'extended cost'],
  ['transaction_quantity', 'transaction quantity'],
  ['mobile_tickets', 'mobile tickets'],
  ['load_tickets', 'load tickets'],
  ['transaction_data', 'transaction data'],
  ['requires_activation_scope_or_eligibility_resolution', 'scope or eligibility not yet decided'],
] as const).map(([term, words]) => [new RegExp(`\\b${term}\\b`, 'gu'), words] as const));

const withoutInternalWord = (text: string) => text.replace(/\bcanonical\b\s*/giu, '').trim();

function presentedValue(value: unknown, key: string | null): unknown {
  if (Array.isArray(value)) return value.map((entry) => presentedValue(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, presentedValue(entry, entryKey)]));
  }
  if (typeof value !== 'string' || key == null) return value;
  if (ENUM_VALUE_KEYS.has(key)) return withoutInternalWord(value.replace(/_/gu, ' '));
  if (SYSTEM_TEXT_KEYS.has(key)) return withoutInternalWord(OPERATOR_TERMS.reduce((text, [term, words]) => text.replace(term, words), value));
  return value;
}

/**
 * What the provider receives. The reading gains what the floor already worked out, so
 * the model need not calculate counts or guess the step: the full open list's counts, not
 * the bounded one's, and the floor's own next step. System identifiers are put in operator
 * terms in this copy alone, and validation stays as strict as ever: an identifier this
 * does not cover stays raw, so an answer repeating it falls back. Stored records,
 * citations and the floor are untouched. Ids, titles, names, numbers and dates are never
 * rewritten, because a value like `TKT_001` could be real data.
 */
export function guidanceTransmittedContext(context: ProjectIntelligenceContext, assessment: ProjectEvidenceAssessment, floor: OperatorRecommendation) {
  const findingsBySeverity: Record<string, number> = {};
  for (const finding of [...(assessment.primary ? [assessment.primary] : []), ...assessment.others]) {
    findingsBySeverity[finding.severity] = (findingsBySeverity[finding.severity] ?? 0) + 1;
  }
  const sections = guidanceSourceContext(context, assessment).sections.map((section) => ({
    ...section,
    payload: presentedValue(section.kind === 'evidence_assessment' ? {
      ...section.payload as object,
      findingsBySeverity,
      otherOpenFindingCount: Math.max(assessment.openFindingCount - 1, 0),
      deterministicNextStep: { kind: floor.recommendedNextStep.kind, instruction: floor.recommendedNextStep.instruction },
    } : section.payload, null),
  }));
  return { sections, request: providerRequestContext(sections) };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?\b/gu;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LONG_DATE = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2}),\\s+(\\d{4})\\b`, 'gu');
const LIST_MARKER = /^[ \t>*_#-]*(\d{1,2})[.)](?=[\s*_])/gmu;
const FINDING_ORDINAL = /\bfinding\s+(\d{1,2})\b/giu;

/** A list marker is not a quantity, but only as part of a run 1, 2, 3 in order of appearance. */
function withoutListMarkers(text: string): string {
  let next = 1;
  return text.replace(LIST_MARKER, (marker, digits: string) => {
    if (Number(digits) !== next) return marker;
    next += 1;
    return marker.replace(digits, ' ');
  });
}

/**
 * What the answer writes that the transmitted context never carried. A number counts as
 * sent only when it stands in a payload as a value: digits inside a UUID or a timestamp
 * are not a number anyone sent. A UUID must have been sent whole, and a date must equal a
 * sent date. Three things are not quantities and are ignored: a sequential list marker,
 * `Finding N` up to the open finding count, and a matching date. Everything else must be
 * in the context, so a calculated number stays rejected.
 */
export function guidanceUnsupportedNumbers(
  texts: readonly string[],
  transmitted: readonly Readonly<{ kind: string; provenance: unknown; payload: unknown }>[],
): string[] {
  const payloads = JSON.stringify(transmitted.map((slice) => slice.payload));
  const sentIdentifiers = JSON.stringify(transmitted.map((slice) => [slice.provenance, slice.payload])).toLowerCase();
  const sentDates = new Set([...payloads.matchAll(ISO_DATE)].map((match) => `${match[1]}-${match[2]}-${match[3]}`));
  const sentNumbers = new Set(numericTokens(payloads.replace(UUID, ' ').replace(ISO_DATE, ' ')));
  const assessment = transmitted.find((slice) => slice.kind === 'evidence_assessment')?.payload as { openFindingCount?: number } | undefined;
  const openFindingCount = assessment?.openFindingCount ?? 0;
  return texts.flatMap((text) => {
    const undated = text.replace(UUID, ' ')
      .replace(ISO_DATE, (date, year: string, month: string, day: string) => (sentDates.has(`${year}-${month}-${day}`) ? ' ' : date))
      .replace(LONG_DATE, (date, month: string, day: string, year: string) => (
        sentDates.has(`${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}`) ? ' ' : date
      ));
    const quantities = withoutListMarkers(undated).replace(FINDING_ORDINAL, (ordinal, digits: string) => (
      Number(digits) >= 1 && Number(digits) <= openFindingCount ? 'finding' : ordinal
    ));
    return [
      ...[...text.matchAll(UUID)].map((match) => match[0].toLowerCase()).filter((id) => !sentIdentifiers.includes(id)),
      ...numericTokens(quantities).filter((token) => !sentNumbers.has(token)),
    ];
  });
}

/**
 * Text with the context's own record labels removed: a document may legitimately
 * be called `rate_schedule_final.pdf`, and quoting its title is not internal talk.
 */
function withoutRecordLabels(text: string, context: ProjectIntelligenceContext): string {
  const labels = context.sections.flatMap((section) => section.records.map((record) => record.label))
    .filter((label) => label.length > 0).sort((left, right) => right.length - left.length);
  return labels.reduce((rest, label) => rest.split(label).join(' '), text);
}

type GuidanceAcceptanceParams = Readonly<{
  raw: string;
  context: ProjectIntelligenceContext;
  assessment: ProjectEvidenceAssessment;
  floor: OperatorRecommendation;
  transmitted: ReturnType<typeof guidanceTransmittedContext>['sections'];
}>;

type GuidanceOutput = z.infer<typeof OutputSchema>;

function parseOutput(raw: string): Readonly<{ output: GuidanceOutput }> | Readonly<{ reason: GuidanceRejectionReason }> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { reason: 'output_not_json' };
  }
  const parsed = OutputSchema.safeParse(value);
  return parsed.success ? { output: parsed.data } : { reason: 'output_schema' };
}

/** Every check this output fails, in the order they are decided. */
function failedChecks(output: GuidanceOutput, params: GuidanceAcceptanceParams): GuidanceRejectionReason[] {
  const failed: GuidanceRejectionReason[] = [];
  const offered: readonly string[] = params.assessment.primary?.nextSteps ?? [params.floor.recommendedNextStep.kind];
  if (!offered.includes(output.nextStepKind)) failed.push('next_step_not_offered');
  const refs = new Set(citableRecords(params.transmitted).map((record) => record.ref));
  if (output.citations.some((ref) => !refs.has(ref)) || new Set(output.citations).size !== output.citations.length) {
    failed.push('citation_unresolved');
  }
  const texts = [output.answer, output.nextStepInstruction, ...output.missingInformation];
  const prose = texts.join(' ');
  if (guidanceUnsupportedNumbers(texts, params.transmitted).length > 0) failed.push('unsupported_number');
  if (authorityClaimIn(prose)) failed.push('authority_claim');
  if (internalVocabularyIn(withoutRecordLabels(prose, params.context))) failed.push('internal_vocabulary');
  return failed;
}

/** All the reasons an answer fails, for measurement. Acceptance stops at the first of these. */
export function guidanceRejectionReasons(params: GuidanceAcceptanceParams): readonly GuidanceRejectionReason[] {
  const parsed = parseOutput(params.raw);
  return 'reason' in parsed ? [parsed.reason] : failedChecks(parsed.output, params);
}

export function acceptModelRecommendation(params: GuidanceAcceptanceParams): Readonly<{ ok: true; recommendation: OperatorRecommendation }> | Readonly<{ ok: false; reason: GuidanceRejectionReason }> {
  const parsed = parseOutput(params.raw);
  if ('reason' in parsed) return { ok: false, reason: parsed.reason };
  const output = parsed.output;
  const [firstFailure] = failedChecks(output, params);
  if (firstFailure) return { ok: false, reason: firstFailure };

  // A citation resolves to a record in this project's context, or the answer already failed above.
  const byRef = new Map(citableRecords(params.transmitted).map((record) => [record.ref, record]));
  const evidenceRefs = resolveEvidenceRefs(params.context, output.citations.map((ref) => byRef.get(ref)!.recordId));
  const kind = output.nextStepKind as NextStepKind;
  return {
    ok: true,
    recommendation: {
      ...params.floor,
      method: 'model_reasoned',
      answer: output.answer,
      recommendedNextStep: {
        kind,
        instruction: output.nextStepInstruction,
        // A link is shown only when the model stayed on the step the link belongs to.
        actionHref: kind === params.floor.recommendedNextStep.kind ? params.floor.recommendedNextStep.actionHref : null,
      },
      evidenceRefs,
      confidence: cappedConfidence(output.confidence, params.floor.confidence),
      // What the evidence reading could not establish is never dropped by a model.
      missingInformation: [...new Set([...params.floor.missingInformation, ...output.missingInformation])],
    },
  };
}
