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
> & {
  evidenceSignature: string;
};

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
  return params.history.get(params.finding.check_key)?.find((historical) => isSameClearedFinding({
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
 * Findings operators already cleared, by check key. Read-only; used here and
 * by the B5-C impact preview so both apply the same recurrence rule.
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
      .select('id, check_key, rule_id, subject_type, subject_id, field, expected, actual, variance, variance_unit, status, linked_decision_id, resolved_at')
      .eq('project_id', projectId)
      .in('status', ['resolved', 'dismissed'])
      .in('check_key', batch)
      .order('resolved_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to load resolved validation findings: ${error.message}`);
    }

    const rows = (data ?? []) as Array<Omit<HistoricalResolvedFindingRow, 'evidenceSignature'>>;
    if (rows.length === 0) continue;

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
      };
      const rowsForCheckKey = findingsByCheckKey.get(row.check_key) ?? [];
      rowsForCheckKey.push(historicalRow);
      findingsByCheckKey.set(row.check_key, rowsForCheckKey);
    }
  }

  return findingsByCheckKey;
}
