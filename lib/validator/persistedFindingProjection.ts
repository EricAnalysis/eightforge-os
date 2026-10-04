import { EXECUTION_ITEM_OUTCOMES } from '@/lib/executionItems';
import { terminalStatusOfFeedbackRecord, type DecisionFeedbackRecord } from '@/lib/decisions/feedbackTerminalStatus';
import { MANUAL_RATE_LINK_RULE_IDS } from '@/lib/server/manualRateLinkRules';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { evaluateFindingRouting } from '@/lib/validator/validatorRouting';
import type { ValidationEvidence, ValidationFinding, ValidatorResult } from '@/types/validator';

/**
 * What one Validator result looks like once persisted: which findings stay
 * open, how evidence is stored, and which recurrences of findings an operator
 * already cleared stay closed. Pure rules plus one read. `persistValidationRun`
 * applies exactly these rules when it writes; the B5-C impact preview applies
 * them in memory so what it previews is what persistence will show. Nothing in
 * this module writes.
 */

type PersistableValidationFinding = ValidationFinding & { evidence?: ValidationEvidence[] };

const EXISTING_FINDING_CHECK_KEY_BATCH_SIZE = 25;

function requireAdminClient() {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error('Server validation client is not configured.');
  }

  return admin;
}

const UUID_PREFIX_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FINANCIAL_MISSING_CONTRACT_RATE_RULE_ID = 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT';

const CROSS_DOCUMENT_MISSING_CONTRACT_RATE_RULE_ID = 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS';

export type HistoricalResolvedFindingRow = Pick<
  ValidationFinding,
  | 'id'
  | 'check_key'
  | 'rule_id'
  | 'subject_type'
  | 'subject_id'
  | 'field'
  | 'expected'
  | 'actual'
  | 'variance'
  | 'variance_unit'
  | 'status'
  | 'linked_decision_id'
  | 'linked_action_id'
  | 'resolved_at'
> & {
  evidenceSignature: string;
  /**
   * The operator record that closed this finding, or null when it was closed
   * only because a run no longer observed it. Only an operator-cleared finding
   * can suppress an identical recurrence.
   */
  operatorClearance: OperatorClearance | null;
};

/**
 * How a closed finding was closed (derived, never stored):
 * - `operator_cleared`: an explicit, actor-attributed operator record closed it;
 * - `not_observed`: a later run simply did not detect it.
 * Observed absence is not operator clearance.
 */
export type FindingClosureKind = 'operator_cleared' | 'not_observed';

export type OperatorClearance = Readonly<{
  kind: 'execution_outcome' | 'decision_feedback' | 'manual_rate_link';
  /** The id of the operator record that proves it. */
  recordId: string;
}>;

/** The existing operator records, as each operator closure path writes them. Read-only. */
export type OperatorClearanceRecords = Readonly<{
  /** `execution_items`: an outcome is written only by the execution outcome route, an operator decision closure, or a carried-forward operator override. */
  executionItems: readonly Readonly<{ id: string; outcome: string | null }>[];
  /** `decisions`: the decision's current status. A reopened decision clears nothing. */
  decisions: readonly Readonly<{ id: string; status: string | null }>[];
  /** `decision_feedback`: written by the decision status and feedback routes, attributed to the operator. */
  decisionFeedback: readonly (DecisionFeedbackRecord & Readonly<{ id: string }>)[];
  /** `invoice_line_rate_links`: written by the manual rate link route, attributed to the operator. */
  rateLinks: readonly Readonly<{ id: string; invoice_line_subject_id: string; actor_id: string | null; created_at: string | null }>[];
}>;

const OPERATOR_EXECUTION_OUTCOMES = new Set<string>(EXECUTION_ITEM_OUTCOMES);
const MANUAL_RATE_LINK_RULES = new Set<string>(MANUAL_RATE_LINK_RULE_IDS);

/**
 * The operator record that closed a finding, from records the operator paths
 * already write. Pure. Reads no finding status and no `resolved_by_user_id`:
 * an automatic transition can set those, an operator record it cannot.
 */
export function operatorClearanceOf(
  finding: Pick<ValidationFinding, 'rule_id' | 'subject_id' | 'linked_decision_id' | 'linked_action_id' | 'resolved_at'>,
  records: OperatorClearanceRecords,
): OperatorClearance | null {
  if (finding.linked_action_id) {
    const item = records.executionItems.find((row) => row.id === finding.linked_action_id);
    if (item?.outcome && OPERATOR_EXECUTION_OUTCOMES.has(item.outcome)) {
      return { kind: 'execution_outcome', recordId: item.id };
    }
  }
  if (finding.linked_decision_id) {
    const decision = records.decisions.find((row) => row.id === finding.linked_decision_id);
    const closed = decision?.status === 'resolved' || decision?.status === 'dismissed';
    const feedback = closed ? records.decisionFeedback.find((row) => row.decision_id === decision!.id
      && row.created_by != null && terminalStatusOfFeedbackRecord(row) != null) : undefined;
    if (feedback) return { kind: 'decision_feedback', recordId: feedback.id };
  }
  if (MANUAL_RATE_LINK_RULES.has(finding.rule_id)) {
    const link = records.rateLinks.find((row) => row.invoice_line_subject_id === finding.subject_id
      && row.actor_id != null
      && (finding.resolved_at == null || row.created_at == null || row.created_at <= finding.resolved_at));
    if (link) return { kind: 'manual_rate_link', recordId: link.id };
  }
  return null;
}

export function findingClosureKind(row: Pick<HistoricalResolvedFindingRow, 'operatorClearance'>): FindingClosureKind {
  return row.operatorClearance ? 'operator_cleared' : 'not_observed';
}

export type PersistedEvidenceRow = Pick<
  ValidationEvidence,
  | 'evidence_type'
  | 'source_document_id'
  | 'source_page'
  | 'fact_id'
  | 'record_id'
  | 'field_name'
  | 'field_value'
  | 'note'
>;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function extractUuidPrefix(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const firstSegment = value.split(':')[0]?.trim() ?? '';
  return UUID_PREFIX_PATTERN.test(firstSegment) ? firstSegment : null;
}

function firstSemanticAnchor(row: ValidationEvidence): string | null {
  for (const value of [row.fact_id, row.source_document_id, row.record_id]) {
    if (typeof value === 'string' && value.includes(':')) return value;
  }

  return null;
}

export function buildEvidenceInserts(
  findingId: string,
  evidence: readonly ValidationEvidence[],
) {
  return evidence.map((row) => {
    const semanticAnchor = firstSemanticAnchor(row);

    return {
      finding_id: findingId,
      evidence_type: row.evidence_type,
      source_document_id: extractUuidPrefix(row.source_document_id),
      source_page: row.source_page,
      fact_id: extractUuidPrefix(row.fact_id),
      record_id: row.record_id ?? semanticAnchor,
      field_name: row.field_name,
      field_value: row.field_value,
      note: row.note,
    };
  });
}

export function applyFindingRouting(
  finding: PersistableValidationFinding,
): PersistableValidationFinding {
  const routing = evaluateFindingRouting(finding);

  return {
    ...finding,
    decision_eligible: routing.decision_eligible,
    action_eligible: routing.action_eligible,
  };
}

export function suppressOverlappingMissingContractRateFindings(
  findings: readonly PersistableValidationFinding[],
): PersistableValidationFinding[] {
  const subjectsWithCrossDocumentRate = new Set(
    findings
      .filter((finding) => finding.rule_id === CROSS_DOCUMENT_MISSING_CONTRACT_RATE_RULE_ID)
      .map((finding) => finding.subject_id),
  );

  return findings.filter((finding) => !(
    finding.rule_id === FINANCIAL_MISSING_CONTRACT_RATE_RULE_ID
    && subjectsWithCrossDocumentRate.has(finding.subject_id)
  ));
}

export function normalizeSignatureText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function evidenceSignature(rows: readonly PersistedEvidenceRow[]): string {
  return JSON.stringify(
    rows
      .map((row) => ({
        evidence_type: normalizeSignatureText(row.evidence_type),
        source_document_id: normalizeSignatureText(row.source_document_id),
        source_page: row.source_page ?? null,
        fact_id: normalizeSignatureText(row.fact_id),
        record_id: normalizeSignatureText(row.record_id),
        field_name: normalizeSignatureText(row.field_name),
        field_value: normalizeSignatureText(row.field_value),
        note: normalizeSignatureText(row.note),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en-US')),
  );
}

function findingClearanceSignature(params: {
  projectId: string;
  finding: Pick<
    ValidationFinding,
    | 'check_key'
    | 'rule_id'
    | 'subject_type'
    | 'subject_id'
    | 'field'
    | 'expected'
    | 'actual'
    | 'variance'
    | 'variance_unit'
  >;
  evidenceSignature: string;
}): string {
  return JSON.stringify({
    project_id: params.projectId,
    check_key: normalizeSignatureText(params.finding.check_key),
    rule_id: normalizeSignatureText(params.finding.rule_id),
    subject_type: normalizeSignatureText(params.finding.subject_type),
    subject_id: normalizeSignatureText(params.finding.subject_id),
    field: normalizeSignatureText(params.finding.field),
    expected: normalizeSignatureText(params.finding.expected),
    actual: normalizeSignatureText(params.finding.actual),
    variance: params.finding.variance ?? null,
    variance_unit: normalizeSignatureText(params.finding.variance_unit),
    evidence: params.evidenceSignature,
  });
}

function currentFindingEvidenceSignature(finding: PersistableValidationFinding): string {
  return evidenceSignature(buildEvidenceInserts('00000000-0000-4000-8000-000000000000', finding.evidence ?? []));
}

/**
 * The findings this result will hold open once persisted: routing applied,
 * overlapping missing-rate findings folded, and any recurrence identical to a
 * finding an operator already cleared left closed. Pure. `persistValidationRun`
 * applies exactly these rules, and the B5-C impact preview uses this function
 * so what it previews is what persistence will show.
 */
export function persistedOpenFindingsForResult(params: {
  projectId: string;
  result: ValidatorResult;
  clearedHistoryByCheckKey: ReadonlyMap<string, readonly HistoricalResolvedFindingRow[]>;
}): PersistableValidationFinding[] {
  return persistableFindingsForResult(params.result).filter((finding) => finding.status === 'open'
    && !clearedRecurrenceOf({ projectId: params.projectId, finding, history: params.clearedHistoryByCheckKey }));
}

export function persistableFindingsForResult(result: ValidatorResult): PersistableValidationFinding[] {
  return suppressOverlappingMissingContractRateFindings(
    (result.findings as PersistableValidationFinding[]).map(applyFindingRouting),
  );
}

export function clearedRecurrenceOf(params: {
  projectId: string;
  finding: PersistableValidationFinding;
  history: ReadonlyMap<string, readonly HistoricalResolvedFindingRow[]>;
}): HistoricalResolvedFindingRow | null {
  if (params.finding.status !== 'open') return null;
  // Only an operator-cleared finding suppresses an identical recurrence. A
  // finding that was merely not observed for a while reopens.
  return params.history.get(params.finding.check_key)?.find((historical) =>
    findingClosureKind(historical) === 'operator_cleared' && isSameClearedFinding({
    projectId: params.projectId,
    finding: params.finding,
    historical,
  })) ?? null;
}

function isSameClearedFinding(params: {
  projectId: string;
  finding: PersistableValidationFinding;
  historical: HistoricalResolvedFindingRow;
}): boolean {
  return findingClearanceSignature({
    projectId: params.projectId,
    finding: params.finding,
    evidenceSignature: currentFindingEvidenceSignature(params.finding),
  }) === findingClearanceSignature({
    projectId: params.projectId,
    finding: params.historical,
    evidenceSignature: params.historical.evidenceSignature,
  });
}

/**
 * Closed findings by check key, each with the operator record that closed it
 * (or none). Read-only; used by persistence and by the B5-C impact preview so
 * both apply the same recurrence rule.
 */
export async function loadHistoricalResolvedFindings(
  projectId: string,
  checkKeys: readonly string[],
): Promise<Map<string, HistoricalResolvedFindingRow[]>> {
  if (checkKeys.length === 0) {
    return new Map<string, HistoricalResolvedFindingRow[]>();
  }

  const admin = requireAdminClient();
  const findingsByCheckKey = new Map<string, HistoricalResolvedFindingRow[]>();
  const uniqueCheckKeys = Array.from(new Set(checkKeys));

  for (let index = 0; index < uniqueCheckKeys.length; index += EXISTING_FINDING_CHECK_KEY_BATCH_SIZE) {
    const batch = uniqueCheckKeys.slice(index, index + EXISTING_FINDING_CHECK_KEY_BATCH_SIZE);
    const { data, error } = await admin
      .from('project_validation_findings')
      .select('id, check_key, rule_id, subject_type, subject_id, field, expected, actual, variance, variance_unit, status, linked_decision_id, linked_action_id, resolved_at')
      .eq('project_id', projectId)
      .in('status', ['resolved', 'dismissed'])
      .in('check_key', batch)
      .order('resolved_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to load resolved validation findings: ${error.message}`);
    }

    const rows = (data ?? []) as Array<Omit<HistoricalResolvedFindingRow, 'evidenceSignature' | 'operatorClearance'>>;
    if (rows.length === 0) continue;
    const records = await loadOperatorClearanceRecords(admin, projectId, rows);

    const { data: evidenceRows, error: evidenceError } = await admin
      .from('project_validation_evidence')
      .select('finding_id, evidence_type, source_document_id, source_page, fact_id, record_id, field_name, field_value, note')
      .in('finding_id', rows.map((row) => row.id));

    if (evidenceError) {
      throw new Error(`Failed to load resolved validation evidence: ${evidenceError.message}`);
    }

    const evidenceByFindingId = new Map<string, PersistedEvidenceRow[]>();
    for (const row of (evidenceRows ?? []) as Array<PersistedEvidenceRow & { finding_id: string }>) {
      const rowsForFinding = evidenceByFindingId.get(row.finding_id) ?? [];
      rowsForFinding.push(row);
      evidenceByFindingId.set(row.finding_id, rowsForFinding);
    }

    for (const row of rows) {
      const historicalRow: HistoricalResolvedFindingRow = {
        ...row,
        evidenceSignature: evidenceSignature(evidenceByFindingId.get(row.id) ?? []),
        operatorClearance: operatorClearanceOf(row, records),
      };
      const rowsForCheckKey = findingsByCheckKey.get(row.check_key) ?? [];
      rowsForCheckKey.push(historicalRow);
      findingsByCheckKey.set(row.check_key, rowsForCheckKey);
    }
  }

  return findingsByCheckKey;
}

function uniqueIds(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

/** Reads the operator records that can prove these findings were cleared. Read-only. */
async function loadOperatorClearanceRecords(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  projectId: string,
  rows: readonly Pick<ValidationFinding, 'rule_id' | 'subject_id' | 'linked_decision_id' | 'linked_action_id'>[],
): Promise<OperatorClearanceRecords> {
  const actionIds = uniqueIds(rows.map((row) => row.linked_action_id));
  const decisionIds = uniqueIds(rows.map((row) => row.linked_decision_id));
  const linkSubjects = uniqueIds(rows.filter((row) => MANUAL_RATE_LINK_RULES.has(row.rule_id)).map((row) => row.subject_id));
  const read = async <T>(
    label: string,
    run: () => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>,
    tolerateMissingTable = false,
  ) => {
    const { data, error } = await run();
    // A deployment without the manual-link table has no manual-link clearance to find.
    if (error && tolerateMissingTable && (error.code === 'PGRST205' || error.code === '42P01')) return [] as T[];
    if (error) throw new Error(`Failed to load ${label} for finding clearance: ${error.message}`);
    return (data ?? []) as T[];
  };
  const [executionItems, decisions, decisionFeedback, rateLinks] = await Promise.all([
    actionIds.length === 0 ? [] : read<OperatorClearanceRecords['executionItems'][number]>('execution items',
      () => admin.from('execution_items').select('id, outcome').eq('project_id', projectId).in('id', actionIds)),
    decisionIds.length === 0 ? [] : read<OperatorClearanceRecords['decisions'][number]>('decisions',
      () => admin.from('decisions').select('id, status').in('id', decisionIds)),
    decisionIds.length === 0 ? [] : read<OperatorClearanceRecords['decisionFeedback'][number]>('decision feedback',
      () => admin.from('decision_feedback')
        .select('id, decision_id, created_by, decision_status_at_feedback, disposition, is_correct, feedback_type')
        .in('decision_id', decisionIds)),
    linkSubjects.length === 0 ? [] : read<OperatorClearanceRecords['rateLinks'][number]>('manual rate links',
      () => admin.from('invoice_line_rate_links').select('id, invoice_line_subject_id, actor_id, created_at')
        .eq('project_id', projectId).in('invoice_line_subject_id', linkSubjects), true),
  ]);
  return { executionItems, decisions, decisionFeedback, rateLinks };
}
