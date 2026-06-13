import type { TransactionDataProjectOperationsOverview } from '@/lib/types/transactionData';
import type { TransactionDataRecord } from '@/lib/types/transactionData';
import type { ValidationFinding, ValidationStatus } from '@/types/validator';

/** Stage 1 (project validator) lifecycle exposed on spreadsheet document flows. */
export type SpreadsheetValidatorLifecycleStatus =
  | 'not_reviewed'
  | 'in_review'
  | 'validated'
  | 'blocked'
  | 'exceptions_approved';

export type ValidatorOverrideScope = 'check' | 'ticket';

export type SpreadsheetValidatorOverrideRecord = {
  scope: ValidatorOverrideScope;
  /** finding.id for check scope; transaction data record id for ticket scope */
  targetId: string;
  reason: string;
  notes?: string | null;
  user: string;
  timestamp: string;
};

export type SpreadsheetValidatorOverrideStore = {
  byCheck: Record<string, SpreadsheetValidatorOverrideRecord>;
  byTicket: Record<string, SpreadsheetValidatorOverrideRecord>;
};

export type SpreadsheetFactWorkspaceDatasetSummary = {
  totalTickets: number;
  totalNetTonnage: number;
  invoicedTickets: number;
  totalInvoices: number;
  totalDollarInvoiced: number;
  uninvoicedLines: number;
  eligible: number;
  ineligible: number;
  unknownEligibility: number;
  mobileTickets: number;
  mobileUnitTickets: number;
  loadTickets: number;
  unknownTicketTypeCount: number;
};

const OVERRIDE_STORAGE_KEY = 'eightforge.spreadsheetValidatorOverrides.v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function isSpreadsheetFileMime(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return (
    lower.includes('spreadsheetml')
    || lower.includes('application/vnd.ms-excel')
    || lower === 'text/csv'
    || lower === 'application/csv'
  );
}

export function isSpreadsheetFileExtension(ext: string | null | undefined): boolean {
  if (!ext) return false;
  const e = ext.toLowerCase().replace(/^\./, '');
  return e === 'xlsx' || e === 'xls' || e === 'csv';
}

export function overrideStoreKey(projectId: string, documentId: string): string {
  return `${projectId}:${documentId}`;
}

export function loadSpreadsheetValidatorOverrides(
  projectId: string | null | undefined,
  documentId: string | null | undefined,
): SpreadsheetValidatorOverrideStore {
  if (!projectId || !documentId || typeof window === 'undefined') {
    return { byCheck: {}, byTicket: {} };
  }
  try {
    const raw = window.localStorage.getItem(OVERRIDE_STORAGE_KEY);
    if (!raw) return { byCheck: {}, byTicket: {} };
    const parsed = JSON.parse(raw) as Record<string, SpreadsheetValidatorOverrideStore>;
    return parsed[overrideStoreKey(projectId, documentId)] ?? { byCheck: {}, byTicket: {} };
  } catch {
    return { byCheck: {}, byTicket: {} };
  }
}

export function saveSpreadsheetValidatorOverrides(
  projectId: string,
  documentId: string,
  store: SpreadsheetValidatorOverrideStore,
): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(OVERRIDE_STORAGE_KEY);
    const parsed: Record<string, SpreadsheetValidatorOverrideStore> = raw ? JSON.parse(raw) : {};
    parsed[overrideStoreKey(projectId, documentId)] = store;
    window.localStorage.setItem(OVERRIDE_STORAGE_KEY, JSON.stringify(parsed));
    window.dispatchEvent(
      new CustomEvent('eightforge-spreadsheet-overrides-changed', {
        detail: { projectId, documentId },
      }),
    );
  } catch {
    // ignore
  }
}

export function readValidationStatusFromSummaryJson(raw: unknown): ValidationStatus | null {
  if (!isRecord(raw)) return null;
  const s = raw.status;
  if (s === 'NOT_READY' || s === 'BLOCKED' || s === 'VALIDATED' || s === 'FINDINGS_OPEN') {
    return s;
  }
  return null;
}

export type CanonicalTicketTypeBucket = 'mobile' | 'mobile_unit' | 'load' | 'unknown';

/** Normalize ticket type labels into Mobile | Mobile Unit | Load buckets. */
export function normalizeTicketTypeLabel(raw: string | null | undefined): CanonicalTicketTypeBucket {
  if (raw == null) return 'unknown';
  let s = raw.trim().toLowerCase();
  if (!s) return 'unknown';
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/[_-]+/g, ' ');
  const compact = s.replace(/\s/g, '');
  // Abbreviations and compact spellings (case-insensitive via prior lowercasing)
  if (compact === 'mu' || /^m[./]u$/.test(compact) || compact === 'mobu' || compact === 'mobileunit') {
    return 'mobile_unit';
  }
  // Collapse common variants
  if (/\bmobile\s+unit\b/.test(s) || /\bmobileunit\b/.test(compact)) {
    return 'mobile_unit';
  }
  if (/\bmobile\b/.test(s) && !/\bunit\b/.test(s)) {
    return 'mobile';
  }
  if (/\bmobil\b/.test(s) && /\bunit\b/.test(s)) {
    return 'mobile_unit';
  }
  if (/\bload\s*out\b/.test(s) || /\bload\s*in\b/.test(s) || /\bline\s*haul\b/.test(s)) {
    return 'load';
  }
  if (/\bload\b/.test(s) || /\bloads\b/.test(s)) {
    return 'load';
  }
  return 'unknown';
}

/** Matches Ticket Type, ticket_type, TicketType, or a lone "Type" column header. */
const TICKET_TYPE_HEADER = /^ticket[\s._-]*type$|^type$/i;

function findTicketTypeRawFromRow(rawRow: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(rawRow)) {
    if (!TICKET_TYPE_HEADER.test(key.trim())) continue;
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  // Fallback: keys that clearly reference ticket type (avoid generic "*type*" columns)
  for (const [key, value] of Object.entries(rawRow)) {
    const k = key.trim();
    if (!/type/i.test(k) || !/ticket/i.test(k)) continue;
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function countRecordsWithInvoice(list: readonly TransactionDataRecord[]): number {
  return list.filter((r) => {
    const inv = r.invoice_number;
    return typeof inv === 'string' && inv.trim().length > 0;
  }).length;
}

function countDistinctInvoiceNumbers(list: readonly TransactionDataRecord[]): number {
  const seen = new Set<string>();
  for (const r of list) {
    const inv = r.invoice_number;
    if (typeof inv === 'string' && inv.trim().length > 0) {
      seen.add(inv.trim().toUpperCase());
    }
  }
  return seen.size;
}

function countUninvoicedLinesFromRecords(list: readonly TransactionDataRecord[]): number {
  return list.filter((r) => {
    const inv = r.invoice_number;
    return inv == null || (typeof inv === 'string' && inv.trim().length === 0);
  }).length;
}

function eligibilityRollupsFromRecords(list: readonly TransactionDataRecord[]): {
  eligible: number;
  ineligible: number;
  unknown: number;
} {
  let eligible = 0;
  let ineligible = 0;
  let unknown = 0;
  for (const r of list) {
    const e = r.eligibility;
    if (e == null || (typeof e === 'string' && e.trim() === '')) {
      unknown += 1;
      continue;
    }
    const v = e.trim().toLowerCase();
    if (v === 'eligible' || v === 'yes' || v === 'y' || v === 'true' || v === '1') {
      eligible += 1;
    } else if (v === 'ineligible' || v === 'no' || v === 'n' || v === 'false' || v === '0') {
      ineligible += 1;
    } else {
      unknown += 1;
    }
  }
  return { eligible, ineligible, unknown };
}

function sumInvoicedExtendedCost(list: readonly TransactionDataRecord[]): number {
  let total = 0;
  for (const r of list) {
    const inv = r.invoice_number;
    if (typeof inv !== 'string' || inv.trim() === '') continue;
    const c = r.extended_cost;
    if (typeof c === 'number' && Number.isFinite(c)) total += c;
  }
  return total;
}

export function countTicketTypesFromRecords(
  records: readonly TransactionDataRecord[],
): Pick<
  SpreadsheetFactWorkspaceDatasetSummary,
  'mobileTickets' | 'mobileUnitTickets' | 'loadTickets' | 'unknownTicketTypeCount'
> {
  let mobileTickets = 0;
  let mobileUnitTickets = 0;
  let loadTickets = 0;
  let unknownTicketTypeCount = 0;

  for (const record of records) {
    const raw = findTicketTypeRawFromRow(record.raw_row as Record<string, unknown>);
    const bucket = normalizeTicketTypeLabel(raw);
    switch (bucket) {
      case 'mobile':
        mobileTickets += 1;
        break;
      case 'mobile_unit':
        mobileUnitTickets += 1;
        break;
      case 'load':
        loadTickets += 1;
        break;
      default:
        unknownTicketTypeCount += 1;
        break;
    }
  }

  return { mobileTickets, mobileUnitTickets, loadTickets, unknownTicketTypeCount };
}

export function buildSpreadsheetFactWorkspaceDatasetSummary(params: {
  ops: TransactionDataProjectOperationsOverview | null | undefined;
  records: readonly TransactionDataRecord[] | null | undefined;
}): SpreadsheetFactWorkspaceDatasetSummary | null {
  const { ops, records } = params;
  if (!ops && (!records || records.length === 0)) return null;

  const list = records ?? [];
  const ticketCounts = list.length > 0 ? countTicketTypesFromRecords(list) : {
    mobileTickets: 0,
    mobileUnitTickets: 0,
    loadTickets: 0,
    unknownTicketTypeCount: 0,
  };

  let totalNetTonnage = 0;
  for (const r of list) {
    if (typeof r.net_tonnage === 'number' && Number.isFinite(r.net_tonnage)) {
      totalNetTonnage += r.net_tonnage;
    }
  }

  const eligRoll = list.length > 0 ? eligibilityRollupsFromRecords(list) : null;
  /** Row-level ticket counts align with ticket-type buckets (per normalized row). */
  const totalTickets = list.length > 0 ? list.length : (ops?.total_tickets ?? 0);
  const invoicedTickets =
    ops != null
      ? ops.invoiced_ticket_count
      : list.length > 0
        ? countRecordsWithInvoice(list)
        : 0;
  const totalInvoices =
    ops != null
      ? ops.distinct_invoice_count
      : list.length > 0
        ? countDistinctInvoiceNumbers(list)
        : 0;
  const totalDollarInvoiced =
    ops != null
      ? ops.total_invoiced_amount
      : list.length > 0
        ? sumInvoicedExtendedCost(list)
        : 0;
  const uninvoicedLines =
    ops != null
      ? ops.uninvoiced_line_count
      : list.length > 0
        ? countUninvoicedLinesFromRecords(list)
        : 0;
  const eligible = ops != null ? ops.eligible_count : eligRoll?.eligible ?? 0;
  const ineligible = ops != null ? ops.ineligible_count : eligRoll?.ineligible ?? 0;
  const unknownEligibility =
    ops != null ? ops.unknown_eligibility_count : eligRoll?.unknown ?? 0;

  return {
    totalTickets,
    totalNetTonnage,
    invoicedTickets,
    totalInvoices,
    totalDollarInvoiced,
    uninvoicedLines,
    eligible,
    ineligible,
    unknownEligibility,
    mobileTickets: ticketCounts.mobileTickets,
    mobileUnitTickets: ticketCounts.mobileUnitTickets,
    loadTickets: ticketCounts.loadTickets,
    unknownTicketTypeCount: ticketCounts.unknownTicketTypeCount,
  };
}

function findingIsStage1Actionable(finding: ValidationFinding): boolean {
  return finding.status === 'open' && finding.severity !== 'info';
}

function recordIdsForFindingMatch(
  finding: ValidationFinding,
  evidence: readonly { record_id: string | null }[],
): Set<string> {
  const ids = new Set<string>();
  if (finding.subject_type === 'transaction_row' && finding.subject_id) {
    ids.add(finding.subject_id);
  }
  for (const ev of evidence) {
    if (ev.record_id) ids.add(ev.record_id);
  }
  return ids;
}

export function resolveTicketOverrideTargetId(
  finding: ValidationFinding,
  evidence: readonly { record_id: string | null }[],
): string | null {
  const recordIds = [...recordIdsForFindingMatch(finding, evidence)];
  return recordIds.length === 1 ? recordIds[0] : null;
}

export function findingWaivedByDocumentOverrides(
  finding: ValidationFinding,
  evidence: readonly { record_id: string | null }[],
  store: SpreadsheetValidatorOverrideStore,
): boolean {
  if (store.byCheck[finding.id]) return true;
  const recordIds = recordIdsForFindingMatch(finding, evidence);
  if (recordIds.size === 0) return false;
  for (const id of recordIds) {
    if (store.byTicket[id]) return true;
  }
  return false;
}

export function listUnresolvedStage1Findings(
  findings: readonly ValidationFinding[],
  evidenceByFindingId: Map<string, { record_id: string | null }[]>,
  store: SpreadsheetValidatorOverrideStore,
): ValidationFinding[] {
  return findings.filter((finding) => {
    if (!findingIsStage1Actionable(finding)) return false;
    const ev = evidenceByFindingId.get(finding.id) ?? [];
    return !findingWaivedByDocumentOverrides(finding, ev, store);
  });
}

export function deriveSpreadsheetValidatorLifecycle(params: {
  validationStatus: ValidationStatus | null;
  unresolvedActionableCount: number;
  hadValidatorRun: boolean;
}): SpreadsheetValidatorLifecycleStatus {
  const { validationStatus, unresolvedActionableCount, hadValidatorRun } = params;

  if (!hadValidatorRun || validationStatus == null || validationStatus === 'NOT_READY') {
    return 'not_reviewed';
  }

  if (validationStatus === 'BLOCKED') {
    return 'blocked';
  }

  if (validationStatus === 'VALIDATED') {
    return unresolvedActionableCount > 0 ? 'exceptions_approved' : 'validated';
  }

  if (validationStatus === 'FINDINGS_OPEN') {
    if (unresolvedActionableCount === 0) return 'exceptions_approved';
    return 'in_review';
  }

  return 'not_reviewed';
}

export function stageTwoInvoiceSupportAllowed(
  validationStatus: ValidationStatus | null,
  unresolvedActionableCount: number,
): boolean {
  if (validationStatus == null || validationStatus === 'NOT_READY') return false;
  if (validationStatus === 'BLOCKED') return false;
  return unresolvedActionableCount === 0;
}
