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
import { operatorPresentation } from '@/lib/projectIntelligence/operatorTerms';
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
    ...(entry.unclassifiedDocuments?.length ? { documentsNotYetClassified: entry.unclassifiedDocuments.map((document) => ({ id: document.id, title: document.title, read: document.read })) } : {}),
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

/**
 * What the provider receives. EightForge determines the safe action and the model explains
 * it, so the reading gains what the floor already worked out: the real next step, and the
 * counts of the full open list, not the bounded one, so nothing needs calculating. The copy
 * is put in operator terms (operatorTerms.ts), and validation stays as strict as ever.
 */
export function guidanceTransmittedContext(context: ProjectIntelligenceContext, assessment: ProjectEvidenceAssessment, floor: OperatorRecommendation) {
  const findingsBySeverity: Record<string, number> = { critical: 0, warning: 0 };
  for (const finding of [...(assessment.primary ? [assessment.primary] : []), ...assessment.others]) {
    findingsBySeverity[finding.severity] = (findingsBySeverity[finding.severity] ?? 0) + 1;
  }
  const sections = guidanceSourceContext(context, assessment).sections.map((section) => ({
    ...section,
    payload: operatorPresentation(section.kind === 'evidence_assessment' ? {
      ...section.payload as object,
      findingsBySeverity,
      otherOpenFindingCount: Math.max(assessment.openFindingCount - 1, 0),
      deterministicNextStep: { kind: floor.recommendedNextStep.kind, instruction: floor.recommendedNextStep.instruction },
    } : section.payload, null),
  }));
  return { sections, request: providerRequestContext(sections) };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const LONG_HASH = /\b[0-9a-f]{16,}\b/giu;
/** Letters and digits joined into one token (`LOAD-884`, `INV1001::HAUL015`, `F-04`). An identifier, whatever digits it holds. */
const IDENTIFIER_TOKEN = /\b(?=[a-z0-9._:-]*[a-z])(?=[a-z0-9._:-]*\d)[a-z0-9]+(?:[-_:.]+[a-z0-9]+)*\b/giu;
const ORDINAL_WORD = /\b\d{1,2}(?:st|nd|rd|th)\b/giu;
const WRITTEN_PERCENT = /(\d[\d,]*(?:\.\d+)?)\s*(?:%|percent\b)/giu;
const UNIT_WORDS = 'cubic|yards?|cy|tons?|miles?|hours?|loads?|gallons?|feet|ft|acres?';
const MEASURE_AFTER = new RegExp(`^\\s*(?:${UNIT_WORDS})\\b`, 'iu');
const NUMBER_WORD_VALUES: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});
const NUMBER_WORD = new RegExp(`\\b(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\\b(?=\\s+(?:percent|dollars?|tickets?|rows?|items?|lines?|transactions?|${UNIT_WORDS}|(?:other\\s+|open\\s+|additional\\s+|more\\s+|remaining\\s+)*(?:critical|warnings?|findings?|issues?))\\b)`, 'giu');
/** Written-out scale is never in a context as words, so it is never supported. */
const NUMBER_WORD_AT_SCALE = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(?:hundred|thousand|million|billion)\b/giu;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?\b/gu;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_NAME = `(${MONTHS.join('|')}|${MONTHS.map((month) => month.slice(0, 3)).join('|')})\\.?`;
const MONTH_FIRST_DATE = new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'giu');
const DAY_FIRST_DATE = new RegExp(`\\b(\\d{1,2})\\s+${MONTH_NAME}\\s+(\\d{4})\\b`, 'giu');
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/gu;
const LIST_MARKER = /^[ \t>*_#-]*(\d{1,2})[.)](?=[\s*_])/gmu;
const FINDING_ORDINAL = /\bfinding\s+(\d{1,2})\b/giu;
/** A claim about how many findings are open: "5 warnings", "3 critical", "2 other open findings". */
const COUNT_CLAIM = /\b(\d{1,4})\s+((?:(?:other|open|additional|more|remaining|further|total)\s+)*)(?:(critical|warnings?|info)\b|(?:findings?|issues?)\b)/giu;
/** Whose values name a record, not a quantity. */
const IDENTIFYING_KEY = /^(?:id|.*Id|.*Sha256|.*Digest|.*Hash)$/u;
const TITLE_VALUE_KEYS: ReadonlySet<string> = new Set(['title', 'name', 'documentName']);

const isoDate = (year: string, month: number, day: string) => `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
const monthNumber = (name: string) => MONTHS.findIndex((month) => month.startsWith(name.slice(0, 3).toLowerCase())) + 1;

type NumberSource = 'page' | 'count' | 'percent' | 'value';

/** What a sent number is, from the field that holds it. An unnamed value stays general. */
function sourceOfNumber(fieldName: string): Exclude<NumberSource, 'percent'> {
  if (/page/iu.test(fieldName)) return 'page';
  if (/count|rows?\b|findingsBySeverity/iu.test(fieldName)) return 'count';
  return 'value';
}

/** What the payloads carry as values: digits inside an identifier, a title or a date support no quantity. */
function sentValues(transmitted: readonly Readonly<{ payload: unknown }>[]) {
  const numbers = new Map<string, Set<NumberSource>>();
  const dates = new Set<string>();
  const titles = new Set<string>();
  const add = (token: string, source: NumberSource) => { numbers.set(token, (numbers.get(token) ?? new Set()).add(source)); };
  const visit = (value: unknown, key: string | null, field: string): void => {
    if (Array.isArray(value)) return value.forEach((entry) => visit(entry, key, field));
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // A fact's value is named by its field key: `{ fieldKey: 'rate row count', value: 9 }`.
      const named = typeof record.fieldKey === 'string' ? record.fieldKey : null;
      return Object.entries(record).forEach(([entryKey, entry]) => visit(entry, entryKey, entryKey === 'value' && named ? named : key === 'findingsBySeverity' ? key : entryKey));
    }
    if (typeof value === 'number') return numericTokens(String(value)).forEach((token) => add(token, /percent|pct/iu.test(field) ? 'percent' : sourceOfNumber(field)));
    if (typeof value !== 'string' || (key != null && IDENTIFYING_KEY.test(key))) return;
    if (key != null && TITLE_VALUE_KEYS.has(key)) {
      if (/\d/u.test(value)) titles.add(value);
      return;
    }
    for (const match of value.matchAll(ISO_DATE)) dates.add(`${match[1]}-${match[2]}-${match[3]}`);
    const clean = value.replace(ISO_DATE, ' ').replace(UUID, ' ').replace(LONG_HASH, ' ').replace(IDENTIFIER_TOKEN, ' ');
    for (const match of clean.matchAll(WRITTEN_PERCENT)) numericTokens(match[1]!).forEach((token) => add(token, 'percent'));
    numericTokens(clean).forEach((token) => add(token, sourceOfNumber(field)));
  };
  for (const slice of transmitted) visit(slice.payload, null, '');
  return { numbers, dates, titles: [...titles].sort((left, right) => right.length - left.length) };
}

type NumberMention = 'percent' | 'money' | 'page' | 'measure' | 'other';

function mentionAt(text: string, start: number, end: number): NumberMention {
  const before = text.slice(Math.max(0, start - 8), start);
  const after = text.slice(end, end + 12);
  if (/^\s*(?:%|percent\b)/iu.test(after)) return 'percent';
  if (/\$\s*$/u.test(before) || /^\s*(?:dollars?\b|usd\b)/iu.test(after)) return 'money';
  if (/\b(?:pages?|pp?\.)\s*$/iu.test(before)) return 'page';
  if (MEASURE_AFTER.test(after)) return 'measure';
  return 'other';
}

/** A page number is no rate, a count is no percentage, and nothing but a percentage is one. */
const SOURCES_FOR_MENTION: Readonly<Record<NumberMention, readonly NumberSource[]>> = Object.freeze({
  percent: ['percent'], money: ['value'], measure: ['value'], page: ['page', 'value'], other: ['value', 'count', 'percent'],
});

function unsupportedQuantities(text: string, sent: ReadonlyMap<string, ReadonlySet<NumberSource>>): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/gu)].flatMap((match) => numericTokens(match[0]).filter((token) => {
    const sources = sent.get(token);
    const allowed = SOURCES_FOR_MENTION[mentionAt(text, match.index, match.index + match[0].length)];
    return !sources || !allowed.some((source) => sources.has(source));
  }));
}

/** A written-out number before a unit is the same claim as its digits. */
function withNumberWordsAsDigits(text: string): string {
  return text.replace(NUMBER_WORD, (written) => {
    const parts = written.toLowerCase().split(/[-\s]+/u);
    return String(parts.reduce((sum, part) => sum + (NUMBER_WORD_VALUES[part] ?? 0), 0));
  });
}

/** A list marker is not a quantity, but only as part of a run 1, 2, 3 in order of appearance. */
function withoutListMarkers(text: string): string {
  let next = 1;
  return text.replace(LIST_MARKER, (marker, digits: string) => {
    if (Number(digits) !== next) return marker;
    next += 1;
    return marker.replace(digits, ' ');
  });
}

function withoutSentDates(text: string, sentDates: ReadonlySet<string>): string {
  const ifSent = (date: string, iso: string) => (sentDates.has(iso) ? ' ' : date);
  return text
    .replace(ISO_DATE, (date, year: string, month: string, day: string) => ifSent(date, `${year}-${month}-${day}`))
    .replace(MONTH_FIRST_DATE, (date, month: string, day: string, year: string) => ifSent(date, isoDate(year, monthNumber(month), day)))
    .replace(DAY_FIRST_DATE, (date, day: string, month: string, year: string) => ifSent(date, isoDate(year, monthNumber(month), day)))
    .replace(SLASH_DATE, (date, month: string, day: string, year: string) => ifSent(date, isoDate(year, Number(month), day)));
}

type SentCounts = Readonly<{ open: number; other: number; bySeverity: Readonly<Record<string, number>> }>;

function sentCounts(transmitted: readonly Readonly<{ kind: string; payload: unknown }>[]): SentCounts {
  const reading = transmitted.find((slice) => slice.kind === 'evidence_assessment')?.payload as
    { openFindingCount?: number; otherOpenFindingCount?: number; findingsBySeverity?: Record<string, number> } | undefined;
  const open = reading?.openFindingCount ?? 0;
  return { open, other: reading?.otherOpenFindingCount ?? Math.max(open - 1, 0), bySeverity: reading?.findingsBySeverity ?? {} };
}

/** A count stated about the findings must be the count EightForge sent, even where that number appears elsewhere. */
function wrongCountClaims(text: string, counts: SentCounts): string[] {
  return [...text.matchAll(COUNT_CLAIM)].flatMap((match) => {
    const stated = Number(match[1]);
    const severity = match[3]?.toLowerCase().replace(/s$/u, '');
    const onlyOthers = /\b(?:other|additional|more|remaining|further)\b/iu.test(match[2] ?? '');
    const right = severity ? stated === (counts.bySeverity[severity] ?? 0)
      : onlyOthers ? stated === counts.other
      : [counts.open, counts.other, ...Object.values(counts.bySeverity)].includes(stated);
    return right ? [] : [match[0]];
  });
}

/**
 * What the answer writes that the transmitted context never carried. The guidance path's
 * own check: `unsupportedNumbers` stays as Case Investigation's records used it.
 *
 * A number must be a value the context sent, and sent as that kind of thing: a page number
 * or a count supports no rate, cost or measurement, and only a percentage supports a
 * percentage. Digits inside a UUID, hash, identifier, title or timestamp support nothing. An
 * identifier or UUID must have been sent whole, and a date must equal a sent date in any safe
 * format. Structure is not quantity, so a sequential list marker, an ordinal word and
 * `Finding N` up to the open count are ignored. A number written as a word before a unit is
 * read as its digits, and a count stated about the findings must equal the count sent.
 *
 * It proves a number's kind, not its meaning: "12 rows" and a rate of 12 are told apart only
 * where the context names the field. Reviewers still read every accepted answer.
 */
export function guidanceUnsupportedNumbers(
  texts: readonly string[],
  transmitted: readonly Readonly<{ kind: string; provenance: unknown; payload: unknown }>[],
): string[] {
  const sent = sentValues(transmitted);
  const counts = sentCounts(transmitted);
  const sentIdentifiers = JSON.stringify(transmitted.map((slice) => [slice.provenance, slice.payload])).toLowerCase();
  return texts.flatMap((text) => {
    const withoutUuids = text.replace(UUID, ' ');
    const withoutTitles = sent.titles.reduce((rest, title) => rest.split(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu')).join(' '), withoutUuids);
    const undated = withoutSentDates(withoutTitles, sent.dates);
    const atScale = [...undated.matchAll(NUMBER_WORD_AT_SCALE)].map((match) => match[0]);
    const words = withNumberWordsAsDigits(undated.replace(NUMBER_WORD_AT_SCALE, ' ')).replace(ORDINAL_WORD, ' ');
    const quantities = withoutListMarkers(words.replace(IDENTIFIER_TOKEN, ' ')).replace(FINDING_ORDINAL, (ordinal, digits: string) => (
      Number(digits) >= 1 && Number(digits) <= counts.open ? 'finding' : ordinal
    ));
    return [
      ...[...text.matchAll(UUID)].map((match) => match[0].toLowerCase()).filter((id) => !sentIdentifiers.includes(id)),
      ...[...words.matchAll(IDENTIFIER_TOKEN)].map((match) => match[0]).filter((id) => !sentIdentifiers.includes(id.toLowerCase())),
      ...atScale,
      ...unsupportedQuantities(quantities, sent.numbers),
      ...wrongCountClaims(quantities, counts),
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
