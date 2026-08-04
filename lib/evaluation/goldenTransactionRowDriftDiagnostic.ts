/**
 * Golden transaction-row drift diagnostic — EVALUATION ONLY.
 *
 * Imported by no production module. Reads workbook paths from environment
 * variables so no personal absolute path is committed. Mutates nothing: no
 * workbook write, no database write, no production behaviour change.
 *
 * Purpose: explain a transaction row-count difference between two workbook
 * sources by executing the real production chain
 *
 *   parseWorkbook -> detectSheets -> normalizeTransactionData
 *
 * against each source and diffing the emitted rows by stable source identity
 * rather than by array position.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { read, utils } from 'xlsx';

import { detectSheets } from '@/lib/extraction/xlsx/detectSheets';
import { parseWorkbook } from '@/lib/extraction/xlsx/parseWorkbook';
import {
  hasInvoiceLink,
  normalizeTransactionData,
  type NormalizedTransactionDataRecord,
} from '@/lib/extraction/xlsx/normalizeTransactionData';

/** Physical workbook facts read straight from the file, before any pipeline stage. */
export type WorkbookSourceInspection = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly fileModifiedIso: string;
  readonly application: string | null;
  readonly appVersion: string | null;
  readonly lastAuthor: string | null;
  readonly createdIso: string | null;
  readonly modifiedIso: string | null;
  readonly definedNameCount: number;
  readonly sheets: readonly WorkbookSheetInspection[];
};

export type DeterministicWorkbookSourceInspection = Omit<
  WorkbookSourceInspection,
  'path' | 'fileModifiedIso'
>;

export type WorkbookSheetInspection = {
  readonly name: string;
  readonly hidden: boolean;
  readonly usedRange: string | null;
  readonly physicalRowCount: number;
  readonly physicalColumnCount: number;
  readonly headerLabels: readonly string[];
  readonly nonBlankRowCount: number;
  readonly blankRowCount: number;
  readonly hiddenRowCount: number;
  readonly mergedCellCount: number;
  readonly autoFilterRef: string | null;
  readonly formulaCellCount: number;
};

/** One emitted transaction row, carried with the evidence needed to diff it. */
export type TransactionRowLedgerEntry = {
  readonly recordId: string;
  readonly sourceSheet: string;
  readonly sourceRow: number;
  readonly ticketNumber: string | null;
  readonly ticketId: string | null;
  readonly transactionNumber: string | null;
  readonly invoiceNumber: string | null;
  readonly rateCode: string | null;
  readonly quantity: number | null;
  readonly extendedCost: number | null;
  readonly cyd: number | null;
  readonly material: string | null;
  readonly eligibility: string | null;
  readonly invoiceLinked: boolean;
  readonly rawRowHash: string;
  readonly identityKey: string;
};

export type TransactionRowLedger = {
  readonly source: WorkbookSourceInspection;
  readonly stageCounts: {
    /** physical rows in the used range of every parsed sheet */
    readonly physicalRows: number;
    /** rows emitted by parseWorkbook after header removal and blank-row dropping */
    readonly parserEmittedRows: number;
    /** rows emitted by normalizeTransactionData (no filter is applied at this stage) */
    readonly normalizedRows: number;
    /** rows carrying an invoice link */
    readonly invoiceLinkedRows: number;
    /** rows with no invoice link */
    readonly uninvoicedRows: number;
    /** distinct ticket-grain keys */
    readonly distinctTickets: number;
  };
  readonly rollups: {
    readonly totalExtendedCost: number;
    readonly totalTransactionQuantity: number;
    readonly totalCydTicketGrain: number;
  };
  readonly entries: readonly TransactionRowLedgerEntry[];
};

export type TransactionRowLedgerDiff = {
  readonly baselineCount: number;
  readonly comparisonCount: number;
  readonly delta: number;
  readonly onlyInBaseline: readonly TransactionRowLedgerEntry[];
  readonly onlyInComparison: readonly TransactionRowLedgerEntry[];
  readonly impact: {
    readonly rows: number;
    readonly distinctTickets: number;
    readonly quantity: number;
    readonly extendedCost: number;
    readonly rowGrainCyd: number;
    readonly invoiceLinkedRows: number;
    readonly invoiceNumbers: readonly string[];
  };
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function asText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function rawField(record: NormalizedTransactionDataRecord, header: string): string | null {
  return asText(record.raw_row[header]);
}

/**
 * Reads the physical workbook without going through the production parser, so
 * parser behaviour can be compared against the file it was handed.
 */
export function inspectWorkbookSource(path: string): WorkbookSourceInspection {
  const bytes = readFileSync(path);
  const workbook = read(bytes, { type: 'buffer', cellDates: true, raw: false, dense: true });
  const sheetMeta = new Map(
    (workbook.Workbook?.Sheets ?? []).map((entry) => [entry.name ?? '', entry]),
  );

  const sheets = workbook.SheetNames.map((name): WorkbookSheetInspection => {
    const sheet = workbook.Sheets[name];
    const ref = (sheet['!ref'] as string | undefined) ?? null;
    const range = ref ? utils.decode_range(ref) : null;
    const withBlanks = utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true }) as unknown[][];
    const withoutBlanks = utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false }) as unknown[][];
    const rowMeta = (sheet['!rows'] as Array<{ hidden?: boolean } | undefined> | undefined) ?? [];
    const dense = (sheet as unknown as { '!data'?: Array<Array<{ f?: string } | undefined> | undefined> })['!data'] ?? [];

    let formulaCellCount = 0;
    for (const row of dense) {
      if (!row) continue;
      for (const cell of row) if (cell?.f) formulaCellCount += 1;
    }

    return {
      name,
      hidden: (sheetMeta.get(name)?.Hidden ?? 0) !== 0,
      usedRange: ref,
      physicalRowCount: range ? range.e.r - range.s.r + 1 : 0,
      physicalColumnCount: range ? range.e.c - range.s.c + 1 : 0,
      headerLabels: (withoutBlanks[0] ?? []).map((cell) => String(cell ?? '')),
      nonBlankRowCount: withoutBlanks.length,
      blankRowCount: withBlanks.length - withoutBlanks.length,
      hiddenRowCount: rowMeta.filter((entry) => entry?.hidden === true).length,
      mergedCellCount: ((sheet['!merges'] as unknown[] | undefined) ?? []).length,
      autoFilterRef: ((sheet['!autofilter'] as { ref?: string } | undefined)?.ref) ?? null,
      formulaCellCount,
    };
  });

  return {
    path,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    fileModifiedIso: statSync(path).mtime.toISOString(),
    application: asText(workbook.Props?.Application),
    appVersion: asText(workbook.Props?.AppVersion),
    lastAuthor: asText(workbook.Props?.LastAuthor),
    createdIso: workbook.Props?.CreatedDate ? new Date(workbook.Props.CreatedDate).toISOString() : null,
    modifiedIso: workbook.Props?.ModifiedDate ? new Date(workbook.Props.ModifiedDate).toISOString() : null,
    definedNameCount: (workbook.Workbook?.Names ?? []).length,
    sheets,
  };
}

/** Removes machine-local path and filesystem timestamp from serializable evidence. */
export function deterministicWorkbookSourceInspection(
  inspection: WorkbookSourceInspection,
): DeterministicWorkbookSourceInspection {
  return {
    byteLength: inspection.byteLength,
    sha256: inspection.sha256,
    application: inspection.application,
    appVersion: inspection.appVersion,
    lastAuthor: inspection.lastAuthor,
    createdIso: inspection.createdIso,
    modifiedIso: inspection.modifiedIso,
    definedNameCount: inspection.definedNameCount,
    sheets: inspection.sheets,
  };
}

function ledgerEntry(record: NormalizedTransactionDataRecord): TransactionRowLedgerEntry {
  const ticketNumber = rawField(record, 'Ticket No');
  const ticketId = rawField(record, 'Ticket ID');
  return {
    recordId: record.id,
    sourceSheet: record.source_sheet_name,
    sourceRow: record.source_row_number,
    ticketNumber,
    ticketId,
    transactionNumber: record.transaction_number,
    invoiceNumber: record.invoice_number,
    rateCode: record.rate_code,
    quantity: record.transaction_quantity,
    extendedCost: record.extended_cost,
    cyd: record.cyd,
    material: record.material,
    eligibility: record.eligibility,
    invoiceLinked: hasInvoiceLink(record),
    rawRowHash: sha256(Buffer.from(stableStringify(record.raw_row), 'utf8')),
    // Deliberately identity-bearing and position-free: two physically distinct
    // rows that are byte-identical still collide here, which is why the diff
    // below consumes matches by multiplicity instead of by set membership.
    identityKey: [
      ticketId ?? '',
      ticketNumber ?? '',
      rawField(record, 'Transaction #') ?? '',
      record.rate_code ?? '',
      record.invoice_number ?? '',
      record.transaction_quantity ?? '',
      record.extended_cost ?? '',
      record.cyd ?? '',
    ].join('|'),
  };
}

/** Executes the real production transaction chain against one workbook file. */
export async function buildTransactionRowLedger(path: string): Promise<TransactionRowLedger> {
  const source = inspectWorkbookSource(path);
  const bytes = readFileSync(path);
  const workbook = await parseWorkbook(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const detected = detectSheets(workbook);
  const normalized = normalizeTransactionData({ workbook, detectedSheets: detected });
  const entries = normalized.records.map(ledgerEntry);
  const parsedSheetNames = new Set(workbook.sheets.map((sheet) => sheet.name));

  return {
    source,
    stageCounts: {
      physicalRows: source.sheets
        .filter((sheet) => parsedSheetNames.has(sheet.name))
        .reduce((sum, sheet) => sum + sheet.physicalRowCount, 0),
      parserEmittedRows: workbook.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0),
      normalizedRows: normalized.records.length,
      invoiceLinkedRows: entries.filter((entry) => entry.invoiceLinked).length,
      uninvoicedRows: entries.filter((entry) => !entry.invoiceLinked).length,
      distinctTickets: normalized.rollups.total_tickets,
    },
    rollups: {
      totalExtendedCost: normalized.rollups.total_extended_cost,
      totalTransactionQuantity: normalized.rollups.total_transaction_quantity,
      totalCydTicketGrain: normalized.rollups.total_cyd,
    },
    entries,
  };
}

function consumeByMultiplicity(
  candidates: readonly TransactionRowLedgerEntry[],
  others: readonly TransactionRowLedgerEntry[],
): TransactionRowLedgerEntry[] {
  const available = new Map<string, number>();
  for (const entry of others) available.set(entry.identityKey, (available.get(entry.identityKey) ?? 0) + 1);

  const unmatched: TransactionRowLedgerEntry[] = [];
  for (const entry of candidates) {
    const remaining = available.get(entry.identityKey) ?? 0;
    if (remaining > 0) available.set(entry.identityKey, remaining - 1);
    else unmatched.push(entry);
  }
  return unmatched;
}

/**
 * Diffs two ledgers by stable source identity, never by array position.
 * Duplicate identity keys are matched by multiplicity so a genuine duplicate
 * pair present on both sides is not reported as a difference, while an
 * unmatched member of such a pair still is.
 */
export function diffTransactionRowLedgers(
  baseline: TransactionRowLedger,
  comparison: TransactionRowLedger,
): TransactionRowLedgerDiff {
  const onlyInBaseline = consumeByMultiplicity(baseline.entries, comparison.entries);
  const onlyInComparison = consumeByMultiplicity(comparison.entries, baseline.entries);
  const tickets = new Set(onlyInBaseline.map(
    (entry) => entry.ticketId ?? entry.ticketNumber ?? entry.recordId,
  ));

  return {
    baselineCount: baseline.entries.length,
    comparisonCount: comparison.entries.length,
    delta: comparison.entries.length - baseline.entries.length,
    onlyInBaseline,
    onlyInComparison,
    impact: {
      rows: onlyInBaseline.length,
      distinctTickets: tickets.size,
      quantity: onlyInBaseline.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0),
      extendedCost: Number(onlyInBaseline.reduce((sum, entry) => sum + (entry.extendedCost ?? 0), 0).toFixed(2)),
      rowGrainCyd: onlyInBaseline.reduce((sum, entry) => sum + (entry.cyd ?? 0), 0),
      invoiceLinkedRows: onlyInBaseline.filter((entry) => entry.invoiceLinked).length,
      invoiceNumbers: [...new Set(onlyInBaseline.map((entry) => entry.invoiceNumber).filter((value): value is string => value != null))].sort(),
    },
  };
}

export const GOLDEN_ROW_DRIFT_ENV = {
  /** Authoritative workbook matching the persisted ingest source. */
  baseline: 'GOLDEN_AUTHORITATIVE_TRANSACTION_WORKBOOK',
  /** Explicit non-authoritative edited derivative. */
  comparison: 'GOLDEN_EDITED_TRANSACTION_WORKBOOK',
} as const;

export function resolveDriftWorkbookPaths(
  environment: NodeJS.ProcessEnv = process.env,
): { readonly baseline: string; readonly comparison: string } | null {
  const baseline = environment[GOLDEN_ROW_DRIFT_ENV.baseline]?.trim();
  const comparison = environment[GOLDEN_ROW_DRIFT_ENV.comparison]?.trim();
  return baseline && comparison ? { baseline, comparison } : null;
}

/** Deterministic CSV of the rows present in `baseline` but absent from `comparison`. */
export function driftLedgerCsv(diff: TransactionRowLedgerDiff): string {
  const columns: Array<keyof TransactionRowLedgerEntry> = [
    'sourceSheet', 'sourceRow', 'ticketNumber', 'ticketId', 'transactionNumber',
    'invoiceNumber', 'rateCode', 'quantity', 'extendedCost', 'cyd', 'material',
    'eligibility', 'invoiceLinked', 'rawRowHash', 'recordId',
  ];
  const escape = (value: unknown): string => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    columns.join(','),
    ...[...diff.onlyInBaseline]
      .sort((a, b) => a.sourceSheet.localeCompare(b.sourceSheet)
        || a.sourceRow - b.sourceRow
        || a.recordId.localeCompare(b.recordId))
      .map((entry) => columns.map((column) => escape(entry[column])).join(',')),
  ].join('\n');
}
