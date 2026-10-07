import { evidenceIsScanned } from '@/lib/contracts/rateAuthority';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { ResolutionCase, ResolutionCaseKind } from '@/lib/resolution/resolutionCases';

/**
 * The shared investigation context of one ResolutionCase (Forgewing
 * generalization, phase 3). Every investigation, deterministic or provider
 * backed, operator-invoked or automatic, reads a case through this one
 * function, composed only from records existing resolvers already produced.
 *
 *   - the case kind decides which slices are RELEVANT;
 *   - the content policy decides which relevant slices may be TRANSMITTED;
 *   - the budget bounds how much is transmitted.
 *
 * Every slice says where it came from. Every relevant slice that is not
 * present or not transmitted is listed as an omission with its reason. The
 * context is scoped to the case's document and page: there is no
 * whole-project send. Pure; it reads nothing and writes nothing.
 */

export const INVESTIGATION_SLICE_KINDS = [
  'case_evidence',
  'source_text',
  'page_structure',
  'neighbouring_rows',
  'human_reviewed_values',
  'validator_findings',
  'document_relationships',
  'deterministic_impact',
  'prior_forgewing',
] as const;
export type InvestigationSliceKind = typeof INVESTIGATION_SLICE_KINDS[number];

export type InvestigationPurpose =
  /** A person reads the context in the workspace. Nothing leaves EightForge. */
  | 'operator_review'
  /** Deterministic investigation inside EightForge. Nothing leaves EightForge. */
  | 'deterministic_investigation'
  /** Content would be sent to a provider: the content policy applies. */
  | 'provider_investigation';

/**
 * What a slice would send, by data-policy class. Declared here, not imported
 * from the gate module: Core never consults a gate. The server read maps the
 * ledger's approved classes onto these, and the compiler holds them equal.
 */
export type InvestigationContentClass = 'text_excerpts' | 'page_region_images';

export type InvestigationContentPolicy = Readonly<{
  /** Content classes the organization's data-policy ledger approved for this request. */
  approvedContentClasses: readonly InvestigationContentClass[];
}>;

export type InvestigationBudget = Readonly<{
  /** Maximum characters of text transmitted across all slices. */
  maxTransmittedTextChars: number;
}>;

/** Text slices are text_excerpts; region pictures are page_region_images; ids and labels are metadata. */
export type InvestigationSliceContentClass = InvestigationContentClass | 'metadata';

export type InvestigationSliceProvenance = Readonly<{
  source:
    | 'resolution_case'
    | 'layout_observations_v1'
    | 'priced_schedule_reconstruction_v1'
    | 'human_fact_assertions'
    | 'project_validation_findings'
    | 'document_precedence'
    | 'forgewing_proposals';
  documentId: string | null;
  physicalPageNumber: number | null;
  recordIds: readonly string[];
}>;

export type InvestigationSlice = Readonly<{
  kind: InvestigationSliceKind;
  contentClass: InvestigationSliceContentClass;
  provenance: InvestigationSliceProvenance;
  /** Whether this slice may leave EightForge under the purpose, policy and budget. */
  transmitted: boolean;
  payload: unknown;
}>;

export type InvestigationOmissionReason =
  /** The case kind does not use this slice. */
  | 'not_relevant_for_case_kind'
  /** Relevant, but EightForge holds no such record for this case. */
  | 'not_available'
  /** Relevant and present, but the data-policy ledger did not approve its content class. */
  | 'content_class_not_approved'
  /** Relevant and present, but the transmission budget was spent by higher-priority slices. */
  | 'over_budget'
  /** Computed only when a person asks (the B5-C impact preview), never assembled ahead. */
  | 'computed_on_request';

export type InvestigationOmission = Readonly<{ kind: InvestigationSliceKind; reason: InvestigationOmissionReason }>;

export type InvestigationContext = Readonly<{
  caseId: string;
  caseKind: ResolutionCaseKind;
  purpose: InvestigationPurpose;
  slices: readonly InvestigationSlice[];
  omissions: readonly InvestigationOmission[];
  /** Digest of exactly what would be transmitted; the reuse key for a provider investigation. */
  transmittedDigest: string;
  /** Digest of every slice read, transmitted or not: the same evidence always yields the same digest. */
  readDigest: string;
}>;

/** Which slices a case kind uses, in transmission priority order. */
export const RELEVANT_SLICES: Readonly<Record<ResolutionCaseKind, readonly InvestigationSliceKind[]>> = Object.freeze({
  unreadable_priced_line: ['case_evidence', 'source_text', 'page_structure', 'neighbouring_rows', 'human_reviewed_values', 'prior_forgewing'],
  withheld_priced_line: ['case_evidence', 'source_text', 'page_structure', 'neighbouring_rows', 'human_reviewed_values', 'prior_forgewing'],
  review_required_value: ['case_evidence', 'source_text', 'neighbouring_rows', 'page_structure', 'human_reviewed_values', 'validator_findings', 'deterministic_impact', 'prior_forgewing'],
  reviewed_value_needs_rereview: ['case_evidence', 'source_text', 'human_reviewed_values', 'page_structure', 'deterministic_impact'],
  recovery_proposal_pending: ['case_evidence', 'source_text', 'page_structure', 'neighbouring_rows', 'prior_forgewing'],
  structure_review: ['case_evidence', 'page_structure', 'neighbouring_rows', 'prior_forgewing'],
  coverage_gap: ['case_evidence', 'page_structure', 'document_relationships'],
  pricing_withheld: ['case_evidence', 'page_structure', 'document_relationships', 'validator_findings'],
  validator_finding: ['case_evidence', 'validator_findings', 'human_reviewed_values', 'document_relationships', 'deterministic_impact'],
});

/** What the server already resolved for this case. Every field is optional: absence is recorded, never guessed. */
export type InvestigationSources = Readonly<{
  /** The case document's preferred extraction, as the queue chose it. */
  extractionData?: unknown;
  /** Effective and held reviewed values for the case document (shared reviewed-truth resolver). */
  reviewedTruth?: Readonly<{
    effective: readonly Readonly<{ anchorKey: string; factKey: string; value: unknown; assertionId: string; physicalPageNumber: number }>[];
    held: readonly Readonly<{ anchorKey: string; factKey: string; reason: string; assertionIds: readonly string[] }>[];
  }> | null;
  /** Open Validator findings on the case document. */
  findings?: readonly Readonly<{ id: string; ruleId: string; severity: string; summary: string; documentId: string | null }>[];
  /** The case document's governing relationships (shared precedence resolver). */
  documentRelationships?: Readonly<{
    family: string | null;
    isGoverning: boolean | null;
    governingDocumentId: string | null;
    governingReason: string | null;
    relationships: readonly Readonly<{ id: string | null; type: string; sourceDocumentId: string; targetDocumentId: string }>[];
  }> | null;
  /** Earlier Forgewing proposals and outcomes for this case's evidence. */
  priorForgewing?: readonly Readonly<{ proposalId: string; kind: string; state: string; outcome: string | null }>[];
}>;

const NEIGHBOUR_ROWS = 3;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function pdfLayer(extractionData: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(asRecord(asRecord(extractionData)?.extraction)?.content_layers_v1)?.pdf);
}

function textLength(payload: unknown): number {
  return JSON.stringify(payload ?? null).length;
}

type Candidate = Omit<InvestigationSlice, 'transmitted'>;

function caseEvidence(resolutionCase: ResolutionCase): Candidate {
  return {
    kind: 'case_evidence',
    contentClass: 'metadata',
    provenance: { source: 'resolution_case', documentId: resolutionCase.documentId,
      physicalPageNumber: resolutionCase.physicalPageNumber, recordIds: [resolutionCase.caseId] },
    payload: {
      title: resolutionCase.title,
      problem: resolutionCase.problem,
      deterministicState: resolutionCase.deterministicState,
      diagnostic: resolutionCase.diagnostic ?? null,
      evidence: resolutionCase.evidence.map((entry) => ({
        documentId: entry.documentId, physicalPageNumber: entry.physicalPageNumber,
        observationIds: entry.observationIds, region: entry.region, role: entry.role, label: entry.label,
      })),
    },
  };
}

// One extraction serves every case on its document: index it once per read.
const observationIndexCache = new WeakMap<object, Map<string, Record<string, unknown>>>();
function observationIndex(pdf: Record<string, unknown> | null): Map<string, Record<string, unknown>> {
  const layer = asRecord(pdf?.layout_observations_v1);
  if (!layer) return new Map();
  const cached = observationIndexCache.get(layer);
  if (cached) return cached;
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of Array.isArray(layer.observations) ? layer.observations : []) {
    const observation = asRecord(value);
    if (observation && typeof observation.id === 'string') byId.set(observation.id, observation);
  }
  observationIndexCache.set(layer, byId);
  return byId;
}

function sourceText(resolutionCase: ResolutionCase, pdf: Record<string, unknown> | null): Candidate | null {
  const ids = [...new Set(resolutionCase.evidence.filter((entry) => entry.role === 'current')
    .flatMap((entry) => entry.observationIds))];
  const byId = observationIndex(pdf);
  // The case's own reconstructed row, when it is one: its rate cell is the candidate.
  const idSet = new Set(ids);
  const ownRow = pageRows(reconstructionPage(pdf, resolutionCase.physicalPageNumber))
    .find((row) => row.observationIds.length > 0 && row.observationIds.every((id) => idSet.has(id))) ?? null;
  const tokens = ids.flatMap((id) => {
    const observation = byId.get(id);
    return observation && typeof observation.raw_text === 'string'
      ? [{ observationId: id, rawText: observation.raw_text, sourceMethod: observation.source_method ?? null }] : [];
  });
  if (tokens.length === 0 && !resolutionCase.originalSourceText) return null;
  return {
    kind: 'source_text',
    contentClass: 'text_excerpts',
    provenance: { source: 'layout_observations_v1', documentId: resolutionCase.documentId,
      physicalPageNumber: resolutionCase.physicalPageNumber, recordIds: tokens.map((token) => token.observationId) },
    payload: {
      originalSourceText: resolutionCase.originalSourceText,
      tokens,
      caseRow: ownRow ? { rowIndex: ownRow.rowIndex, rawText: ownRow.rawText, rateText: ownRow.rateText,
        rateRead: ownRow.rateScanned ? 'scanned_candidate' : 'native' } : null,
    },
  };
}

type PageRow = Readonly<{ rowIndex: number; rawText: string; y: number | null; rateText: string | null; rateScanned: boolean; observationIds: readonly string[] }>;

function reconstructionPage(pdf: Record<string, unknown> | null, page: number | null): Record<string, unknown> | null {
  if (page == null) return null;
  const pages = asRecord(pdf?.priced_schedule_reconstruction_v1)?.pages;
  return (Array.isArray(pages) ? pages : []).map(asRecord)
    .find((entry) => entry?.physical_page_number === page) ?? null;
}

const pageRowsCache = new WeakMap<object, PageRow[]>();
function pageRows(page: Record<string, unknown> | null): PageRow[] {
  if (!page) return [];
  const cached = pageRowsCache.get(page);
  if (cached) return cached;
  const parsed = parsePageRows(page);
  pageRowsCache.set(page, parsed);
  return parsed;
}

function parsePageRows(page: Record<string, unknown>): PageRow[] {
  const rows = Array.isArray(page.rows) ? page.rows : [];
  return rows.flatMap((value) => {
    const row = asRecord(value);
    if (!row || typeof row.raw_text !== 'string' || typeof row.row_index !== 'number') return [];
    const cells = (Array.isArray(row.cells) ? row.cells : []).map(asRecord);
    const rate = cells.find((cell) => cell?.role === 'rate') ?? null;
    const refs = cells.flatMap((cell) => (Array.isArray(cell?.source_refs) ? cell.source_refs : []).map(asRecord));
    return [{
      rowIndex: row.row_index,
      rawText: row.raw_text,
      y: typeof row.y_min === 'number' ? row.y_min : null,
      rateText: typeof rate?.raw_text === 'string' ? rate.raw_text : null,
      rateScanned: rate ? evidenceIsScanned((Array.isArray(rate.source_refs) ? rate.source_refs : []).map((ref) => asRecord(ref) ?? {})) : false,
      observationIds: refs.flatMap((ref) => typeof ref?.observation_id === 'string' ? [ref.observation_id] : []),
    }];
  });
}

function pageStructure(resolutionCase: ResolutionCase, pdf: Record<string, unknown> | null): Candidate | null {
  const page = reconstructionPage(pdf, resolutionCase.physicalPageNumber);
  const unresolved = asRecord(pdf?.priced_schedule_reconstruction_v1)?.unresolved_pages;
  const unresolvedPage = (Array.isArray(unresolved) ? unresolved : []).map(asRecord)
    .find((entry) => entry?.physical_page_number === resolutionCase.physicalPageNumber) ?? null;
  if (!page && !unresolvedPage) return null;
  const columns = (Array.isArray(page?.columns) ? page.columns : []).map(asRecord)
    .flatMap((column) => column ? [{ role: column.role ?? null, headerText: column.header_text ?? null }] : []);
  return {
    kind: 'page_structure',
    contentClass: 'text_excerpts',
    provenance: { source: 'priced_schedule_reconstruction_v1', documentId: resolutionCase.documentId,
      physicalPageNumber: resolutionCase.physicalPageNumber, recordIds: [] },
    payload: {
      parserVersion: asRecord(pdf?.priced_schedule_reconstruction_v1)?.parser_version ?? null,
      status: page?.status ?? null,
      semanticStatus: page?.semantic_status ?? null,
      headerRawText: page?.header_raw_text ?? null,
      columns,
      rowCount: Array.isArray(page?.rows) ? page.rows.length : 0,
      rejectedSpineCount: Array.isArray(page?.rejected_spines) ? page.rejected_spines.length : 0,
      unassignedLineCount: Array.isArray(page?.unassigned_lines) ? page.unassigned_lines.length : 0,
      unresolvedReason: unresolvedPage?.reason ?? null,
    },
  };
}

function caseY(resolutionCase: ResolutionCase): number | null {
  const boxes = resolutionCase.evidence.flatMap((entry) => entry.role === 'current' ? entry.region?.boxes ?? [] : []);
  return boxes.length > 0 ? Math.min(...boxes.map((box) => box.y_min)) : null;
}

function neighbouringRows(resolutionCase: ResolutionCase, pdf: Record<string, unknown> | null): Candidate | null {
  const rows = pageRows(reconstructionPage(pdf, resolutionCase.physicalPageNumber));
  if (rows.length === 0) return null;
  const caseIds = new Set(resolutionCase.evidence.flatMap((entry) => entry.observationIds));
  const others = rows.filter((row) => !row.observationIds.some((id) => caseIds.has(id)));
  const y = caseY(resolutionCase);
  // Nearest by vertical distance to the case; without a position, the page's first rows.
  const ranked = y == null ? others
    : [...others].sort((left, right) => Math.abs((left.y ?? Infinity) - y) - Math.abs((right.y ?? Infinity) - y)
      || left.rowIndex - right.rowIndex);
  const chosen = ranked.slice(0, NEIGHBOUR_ROWS * 2).sort((left, right) => left.rowIndex - right.rowIndex);
  if (chosen.length === 0) return null;
  return {
    kind: 'neighbouring_rows',
    contentClass: 'text_excerpts',
    provenance: { source: 'priced_schedule_reconstruction_v1', documentId: resolutionCase.documentId,
      physicalPageNumber: resolutionCase.physicalPageNumber, recordIds: chosen.flatMap((row) => row.observationIds) },
    payload: chosen.map((row) => ({ rowIndex: row.rowIndex, rawText: row.rawText, rateText: row.rateText,
      rateRead: row.rateScanned ? 'scanned_candidate' : 'native' })),
  };
}

function reviewedValues(resolutionCase: ResolutionCase, sources: InvestigationSources): Candidate | null {
  const truth = sources.reviewedTruth;
  if (!truth) return null;
  const page = resolutionCase.physicalPageNumber;
  const effective = truth.effective.filter((entry) => page == null || entry.physicalPageNumber === page);
  const anchor = resolutionCase.sourceRefs.anchorKey ?? null;
  const held = truth.held.filter((entry) => anchor == null || entry.anchorKey.split(',').includes(anchor));
  if (effective.length === 0 && held.length === 0) return null;
  return {
    kind: 'human_reviewed_values',
    contentClass: 'text_excerpts',
    provenance: { source: 'human_fact_assertions', documentId: resolutionCase.documentId, physicalPageNumber: page,
      recordIds: [...effective.map((entry) => entry.assertionId), ...held.flatMap((entry) => entry.assertionIds)] },
    payload: {
      effective: effective.map((entry) => ({ anchorKey: entry.anchorKey, factKey: entry.factKey, value: entry.value })),
      held: held.map((entry) => ({ anchorKey: entry.anchorKey, factKey: entry.factKey, reason: entry.reason })),
    },
  };
}

function validatorFindings(resolutionCase: ResolutionCase, sources: InvestigationSources): Candidate | null {
  const findings = (sources.findings ?? []).filter((entry) =>
    resolutionCase.documentId == null || entry.documentId === resolutionCase.documentId);
  const own = resolutionCase.finding
    ? [{ id: resolutionCase.finding.checkKey, ruleId: resolutionCase.finding.ruleId, severity: resolutionCase.finding.severity,
      summary: resolutionCase.problem }]
    : [];
  const all = [...own, ...findings.filter((entry) => !own.some((mine) => mine.id === entry.id))];
  if (all.length === 0) return null;
  return {
    kind: 'validator_findings',
    contentClass: 'text_excerpts',
    provenance: { source: 'project_validation_findings', documentId: resolutionCase.documentId,
      physicalPageNumber: resolutionCase.physicalPageNumber, recordIds: all.map((entry) => entry.id) },
    payload: all.map((entry) => ({ id: entry.id, ruleId: entry.ruleId, severity: entry.severity, summary: entry.summary })),
  };
}

function relationships(resolutionCase: ResolutionCase, sources: InvestigationSources): Candidate | null {
  const value = sources.documentRelationships;
  if (!value) return null;
  return {
    kind: 'document_relationships',
    contentClass: 'metadata',
    provenance: { source: 'document_precedence', documentId: resolutionCase.documentId, physicalPageNumber: null,
      recordIds: value.relationships.flatMap((entry) => entry.id ? [entry.id] : []) },
    payload: value,
  };
}

function priorForgewing(resolutionCase: ResolutionCase, sources: InvestigationSources): Candidate | null {
  const prior = [
    ...resolutionCase.suggestions.map((entry) => ({ proposalId: entry.proposalId, kind: entry.source,
      state: 'offered', outcome: null as string | null, proposedValue: entry.proposedValue })),
    ...(sources.priorForgewing ?? []).map((entry) => ({ ...entry, proposedValue: null as string | null })),
  ].filter((entry, index, list) => list.findIndex((other) => other.proposalId === entry.proposalId) === index);
  if (prior.length === 0 && !resolutionCase.valueReadingOutcome) return null;
  return {
    kind: 'prior_forgewing',
    contentClass: 'text_excerpts',
    provenance: { source: 'forgewing_proposals', documentId: resolutionCase.documentId,
      physicalPageNumber: resolutionCase.physicalPageNumber, recordIds: prior.map((entry) => entry.proposalId) },
    payload: { proposals: prior, lastOutcome: resolutionCase.valueReadingOutcome ?? null },
  };
}

export function resolveInvestigationContext(
  resolutionCase: ResolutionCase,
  sources: InvestigationSources,
  options: Readonly<{ purpose: InvestigationPurpose; contentPolicy: InvestigationContentPolicy; budget: InvestigationBudget }>,
): InvestigationContext {
  const pdf = pdfLayer(sources.extractionData);
  const relevant = new Set(RELEVANT_SLICES[resolutionCase.kind]);
  const builders: Record<InvestigationSliceKind, () => Candidate | null> = {
    case_evidence: () => caseEvidence(resolutionCase),
    source_text: () => sourceText(resolutionCase, pdf),
    page_structure: () => pageStructure(resolutionCase, pdf),
    neighbouring_rows: () => neighbouringRows(resolutionCase, pdf),
    human_reviewed_values: () => reviewedValues(resolutionCase, sources),
    validator_findings: () => validatorFindings(resolutionCase, sources),
    document_relationships: () => relationships(resolutionCase, sources),
    deterministic_impact: () => null,
    prior_forgewing: () => priorForgewing(resolutionCase, sources),
  };
  const local = options.purpose !== 'provider_investigation';
  const approved = new Set(options.contentPolicy.approvedContentClasses);
  let budget = Math.max(0, options.budget.maxTransmittedTextChars);
  const slices: InvestigationSlice[] = [];
  const omissions: InvestigationOmission[] = [];
  for (const kind of INVESTIGATION_SLICE_KINDS) {
    if (!relevant.has(kind)) omissions.push({ kind, reason: 'not_relevant_for_case_kind' });
  }
  // Priority order is the case kind's own order.
  for (const kind of RELEVANT_SLICES[resolutionCase.kind]) {
    if (kind === 'deterministic_impact') {
      omissions.push({ kind, reason: 'computed_on_request' });
      continue;
    }
    const candidate = builders[kind]();
    if (!candidate) {
      omissions.push({ kind, reason: 'not_available' });
      continue;
    }
    if (local) {
      // Nothing leaves EightForge for a local purpose; every slice is readable.
      slices.push({ ...candidate, transmitted: false });
      continue;
    }
    // Metadata (ids, labels, positions) travels only alongside approved content.
    const classApproved = candidate.contentClass === 'metadata' ? approved.size > 0 : approved.has(candidate.contentClass);
    if (!classApproved) {
      omissions.push({ kind, reason: 'content_class_not_approved' });
      slices.push({ ...candidate, transmitted: false });
      continue;
    }
    const size = textLength(candidate.payload);
    if (size > budget) {
      omissions.push({ kind, reason: 'over_budget' });
      slices.push({ ...candidate, transmitted: false });
      continue;
    }
    budget -= size;
    slices.push({ ...candidate, transmitted: true });
  }
  const transmitted = slices.filter((slice) => slice.transmitted)
    .map((slice) => ({ kind: slice.kind, provenance: slice.provenance, payload: slice.payload }));
  return {
    caseId: resolutionCase.caseId,
    caseKind: resolutionCase.kind,
    purpose: options.purpose,
    slices,
    omissions,
    transmittedDigest: hashCanonical({ version: 'investigation_context_v1', caseId: resolutionCase.caseId, transmitted }),
    readDigest: hashCanonical({ version: 'investigation_context_v1', caseId: resolutionCase.caseId,
      read: slices.map((slice) => ({ kind: slice.kind, provenance: slice.provenance, payload: slice.payload })) }),
  };
}
