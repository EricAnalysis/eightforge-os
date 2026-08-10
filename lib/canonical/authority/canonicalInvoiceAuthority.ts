/**
 * Canonical invoice and invoice-line identity.
 *
 * Assembles canonical invoices inside the SAME single execution assembly by
 * reusing `adaptCurrentInvoiceRows` over the effective invoice rows validator
 * input construction already loaded. No document is re-read, no OCR is re-run,
 * and no table is reconstructed.
 *
 * The identity rules here exist because both obvious shortcuts are wrong:
 *
 *  - a persisted row id is generated at insertion, so using it as the canonical
 *    id would make identity depend on database insertion; and
 *  - an invoice number alone is not unique — two source documents can each
 *    claim `INV-1001`, and merging them on the number would destroy one
 *    observation.
 *
 * So identity is a deterministic composite of project, source artifact, source
 * document, and invoice number, with source-observation identity added ONLY
 * where that composite cannot separate two distinct observations. Every
 * degradation is announced through `identityConfidence` rather than hidden.
 */

import {
  adaptCurrentInvoiceRows,
  type CurrentInvoiceRuntimeRow,
} from '@/lib/canonical/invoice/invoiceAdapter';
import type { CanonicalInvoice } from '@/lib/canonical/invoice/invoice';
import type { CanonicalInvoiceLine } from '@/lib/canonical/invoice/invoiceLine';
import { isValueBearingState } from '@/lib/canonical/truth/envelope';
import type { SourceIdentityReadFailure } from '@/lib/sourceIdentityReadFailure';

import {
  buildCanonicalProvenance,
  type CanonicalProvenance,
} from './canonicalProvenance';

export const CANONICAL_INVOICE_ADAPTER_ID = 'canonical_invoice_authority';

/** Structural persisted-row boundary; avoids importing validator projections. */
export type PersistedCanonicalInvoiceRowInput = CurrentInvoiceRuntimeRow;

/**
 * How precisely a canonical identity could be scoped.
 *
 * `document_scoped`   — project + artifact + document + invoice number. The
 *                       strongest form; independent of any generated row id.
 * `source_scoped`     — the composite above could not separate two distinct
 *                       observations, so source-observation identity was added.
 * `unresolved`        — deterministic uniqueness could not be established from
 *                       source identity at all; input ordinal was the only
 *                       discriminator left. Surfaced, never silently accepted.
 */
export type CanonicalIdentityConfidence =
  | 'document_scoped'
  | 'source_scoped'
  | 'unresolved';

/** Whether immutable source identity was read for one invoice observation. */
export type CanonicalInvoiceSourceIdentityStatus =
  | 'present'
  | 'absent'
  | 'unreadable';

export type CanonicalInvoiceIdentity = {
  readonly canonicalInvoiceId: string;
  readonly projectId: string;
  readonly sourceArtifactId: string | null;
  readonly sourceIdentityStatus: CanonicalInvoiceSourceIdentityStatus;
  /** Sanitized store failure when identity was unreadable; null otherwise. */
  readonly sourceIdentityReadError: SourceIdentityReadFailure | null;
  readonly sourceDocumentId: string | null;
  /** The persisted row id. Evidence and scoping input — never the id basis. */
  readonly sourceRecordId: string | null;
  readonly invoiceNumber: string | null;
  /** Explicit: a missing invoice number is stated, not blanked. */
  readonly invoiceNumberPresent: boolean;
  readonly invoiceDate: string | null;
  readonly contractorVendor: string | null;
  readonly documentFamily: string | null;
  /** The components that actually formed the id, in order. Auditable. */
  readonly identityBasis: readonly string[];
  readonly identityConfidence: CanonicalIdentityConfidence;
  readonly provenance: CanonicalProvenance;
};

export type CanonicalInvoiceLineIdentity = {
  readonly canonicalLineId: string;
  readonly canonicalInvoiceId: string;
  readonly sourceArtifactId: string | null;
  readonly sourceDocumentId: string | null;
  readonly sourceRecordId: string | null;
  readonly sourcePage: number | null;
  readonly sourceSheet: string | null;
  readonly sourceRow: number | null;
  readonly identityBasis: readonly string[];
  readonly identityConfidence: CanonicalIdentityConfidence;
  readonly provenance: CanonicalProvenance;
};

/**
 * Two distinct source documents claiming one invoice number.
 *
 * Emitted, never resolved. Both observations survive with distinct canonical
 * ids; this record exists so the collision is visible instead of being implied
 * by two ids that happen to differ.
 */
export type CanonicalInvoiceIdentityConflict = {
  readonly conflictKey: string;
  readonly invoiceNumber: string;
  readonly canonicalInvoiceIds: readonly string[];
  readonly sourceDocumentIds: readonly string[];
  readonly detail: string;
};

export type CanonicalInvoiceLineIdentityIssue = {
  readonly issueKey: string;
  readonly canonicalInvoiceId: string;
  readonly canonicalLineIds: readonly string[];
  readonly reason: 'missing_source_row_identity' | 'ambiguous_source_location';
  readonly detail: string;
};

export type CanonicalInvoiceAssembly = {
  readonly invoices: readonly CanonicalInvoice[];
  readonly lines: readonly CanonicalInvoiceLine[];
  readonly invoiceIdentities: readonly CanonicalInvoiceIdentity[];
  readonly lineIdentities: readonly CanonicalInvoiceLineIdentity[];
  readonly identityConflicts: readonly CanonicalInvoiceIdentityConflict[];
  readonly lineIdentityIssues: readonly CanonicalInvoiceLineIdentityIssue[];
  readonly distinctInvoiceIdentityCount: number;
  /**
   * Lines that matched no invoice by explicit linkage or unambiguous document.
   * Reported rather than adopted by an arbitrary parent.
   */
  readonly orphanedLineCount: number;
};

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(row: PersistedCanonicalInvoiceRowInput, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = nonEmpty(row[key]);
    if (value != null) return value;
  }
  return null;
}

function readNumber(row: PersistedCanonicalInvoiceRowInput, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = finite(row[key]);
    if (value != null) return value;
  }
  return null;
}

/** Stable id component. Never derived from an amount, quantity, or total. */
function stablePart(value: unknown): string {
  return String(value ?? 'null')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'null';
}

function compare(left: string, right: string): number {
  return left.localeCompare(right, 'en-US');
}

function envelopeString(envelope: { readonly value: string | null; readonly state: Parameters<typeof isValueBearingState>[0] } | undefined): string | null {
  if (envelope == null) return null;
  return isValueBearingState(envelope.state) ? nonEmpty(envelope.value) : null;
}

const DOCUMENT_KEYS = ['source_document_id', 'document_id'] as const;
const INVOICE_NUMBER_KEYS = ['invoice_number_normalized', 'invoice_number', 'invoice_no', 'number'] as const;
const RECORD_ID_KEYS = ['id', 'invoice_id'] as const;
const LINE_RECORD_ID_KEYS = ['id', 'invoice_line_id', 'line_id'] as const;

/**
 * Deterministic ordering for the assembly.
 *
 * Sorted by source identity only — never by amount, total, or array position —
 * so two runs over the same rows produce an identical assembly regardless of
 * the order the loader happened to return them in.
 */
function invoiceSortKey(row: PersistedCanonicalInvoiceRowInput): string {
  return [
    stablePart(readString(row, DOCUMENT_KEYS)),
    stablePart(readString(row, INVOICE_NUMBER_KEYS)),
    stablePart(readString(row, RECORD_ID_KEYS)),
  ].join('|');
}

function lineSortKey(row: PersistedCanonicalInvoiceRowInput): string {
  return [
    stablePart(readString(row, DOCUMENT_KEYS)),
    stablePart(readNumber(row, ['source_page'])),
    stablePart(readString(row, ['source_sheet_name'])),
    stablePart(readNumber(row, ['source_row_number'])),
    stablePart(readString(row, LINE_RECORD_ID_KEYS)),
  ].join('|');
}

/**
 * Groups invoice lines onto their invoice row.
 *
 * Matching is by explicit source linkage first (`invoice_id`), then by source
 * document. A line that matches neither is NOT attached to an arbitrary
 * invoice: it is returned as orphaned so the relationship layer can report the
 * gap rather than inventing a parent.
 */
function groupLines(
  invoiceRows: readonly PersistedCanonicalInvoiceRowInput[],
  lineRows: readonly PersistedCanonicalInvoiceRowInput[],
): {
  readonly byInvoiceRow: ReadonlyMap<number, readonly PersistedCanonicalInvoiceRowInput[]>;
  readonly orphaned: readonly PersistedCanonicalInvoiceRowInput[];
} {
  const byInvoiceRow = new Map<number, PersistedCanonicalInvoiceRowInput[]>();
  const orphaned: PersistedCanonicalInvoiceRowInput[] = [];
  const indexByRecordId = new Map<string, number>();
  const indexByDocument = new Map<string, number[]>();

  invoiceRows.forEach((row, index) => {
    const recordId = readString(row, RECORD_ID_KEYS);
    if (recordId != null && !indexByRecordId.has(recordId)) indexByRecordId.set(recordId, index);
    const documentId = readString(row, DOCUMENT_KEYS);
    if (documentId != null) {
      indexByDocument.set(documentId, [...(indexByDocument.get(documentId) ?? []), index]);
    }
  });

  for (const line of lineRows) {
    const linkedInvoiceId = readString(line, ['invoice_id', 'source_invoice_id']);
    const documentId = readString(line, DOCUMENT_KEYS);
    const candidates = documentId != null ? indexByDocument.get(documentId) ?? [] : [];
    const index = (linkedInvoiceId != null ? indexByRecordId.get(linkedInvoiceId) : undefined)
      // A document with exactly one invoice makes document linkage unambiguous.
      // With more than one, the line is left orphaned rather than guessed.
      ?? (candidates.length === 1 ? candidates[0] : undefined);

    if (index == null) {
      orphaned.push(line);
      continue;
    }
    byInvoiceRow.set(index, [...(byInvoiceRow.get(index) ?? []), line]);
  }

  return { byInvoiceRow, orphaned };
}

/**
 * Builds the deterministic canonical invoice id.
 *
 * The composite deliberately excludes every value-bearing field — total,
 * billed amount, quantity — so a value disagreement can never masquerade as
 * two different invoices, and a corrected amount never renames an invoice.
 */
function buildInvoiceIdentityCore(input: {
  readonly projectId: string;
  readonly sourceArtifactId: string | null;
  readonly sourceIdentityStatus: CanonicalInvoiceSourceIdentityStatus;
  readonly sourceDocumentId: string | null;
  readonly invoiceNumber: string | null;
}): { readonly id: string; readonly basis: readonly string[] } {
  const basis = [
    `project:${stablePart(input.projectId)}`,
    input.sourceIdentityStatus === 'unreadable'
      ? 'artifact:unreadable'
      : `artifact:${stablePart(input.sourceArtifactId)}`,
    `document:${stablePart(input.sourceDocumentId)}`,
    input.invoiceNumber != null
      ? `invoice-number:${stablePart(input.invoiceNumber)}`
      : 'invoice-number:absent',
  ];
  return { id: `canonical-invoice:${basis.join(':')}`, basis };
}

function buildLineIdentityCore(input: {
  readonly canonicalInvoiceId: string;
  readonly sourceDocumentId: string | null;
  readonly sourcePage: number | null;
  readonly sourceSheet: string | null;
  readonly sourceRow: number | null;
  readonly observationId: string | null;
}): { readonly id: string; readonly basis: readonly string[]; readonly located: boolean } {
  // Source LOCATION, never business values. Two rendered rows with identical
  // description, quantity, rate, and amount are two rows, and collapsing them
  // would violate the repository's grain rules.
  const located =
    input.observationId != null
    || input.sourceRow != null
    || input.sourcePage != null
    || input.sourceSheet != null;
  const basis = [
    `invoice:${stablePart(input.canonicalInvoiceId)}`,
    `document:${stablePart(input.sourceDocumentId)}`,
    `page:${stablePart(input.sourcePage)}`,
    `sheet:${stablePart(input.sourceSheet)}`,
    `row:${stablePart(input.sourceRow)}`,
    input.observationId != null ? `observation:${stablePart(input.observationId)}` : 'observation:absent',
  ];
  return { id: `canonical-invoice-line:${basis.join(':')}`, basis, located };
}

type InvoiceDraft = {
  readonly invoice: CanonicalInvoice;
  readonly lines: readonly CanonicalInvoiceLine[];
  readonly row: PersistedCanonicalInvoiceRowInput;
  readonly lineRows: readonly PersistedCanonicalInvoiceRowInput[];
  readonly coreId: string;
  readonly basis: readonly string[];
  readonly sourceRecordId: string | null;
  readonly sourceArtifactId: string | null;
  readonly sourceIdentityStatus: CanonicalInvoiceSourceIdentityStatus;
  readonly sourceIdentityReadError: SourceIdentityReadFailure | null;
  readonly sourceDocumentId: string | null;
  readonly invoiceNumber: string | null;
  readonly documentFamily: string | null;
};

/**
 * Assembles canonical invoices and invoice lines for one execution.
 *
 * Deterministic throughout: rows are ordered by source identity, ids are
 * composites of source identity, and every output array is sorted by id.
 */
export function assembleCanonicalInvoices(input: {
  readonly projectId: string;
  readonly invoiceRows: readonly PersistedCanonicalInvoiceRowInput[];
  readonly invoiceLineRows: readonly PersistedCanonicalInvoiceRowInput[];
  /** Frozen source-artifact identity per document, already loaded upstream. */
  readonly sourceArtifactIdByDocumentId?: ReadonlyMap<string, string | null>;
  readonly sourceIdentityStoreState?: 'read' | 'unreadable';
  readonly sourceIdentityReadError?: SourceIdentityReadFailure | null;
  readonly documentFamilyByDocumentId?: ReadonlyMap<string, string | null>;
}): CanonicalInvoiceAssembly {
  const invoiceRows = [...input.invoiceRows].sort((left, right) =>
    compare(invoiceSortKey(left), invoiceSortKey(right)));
  const lineRows = [...input.invoiceLineRows].sort((left, right) =>
    compare(lineSortKey(left), lineSortKey(right)));
  const grouped = groupLines(invoiceRows, lineRows);

  const drafts: InvoiceDraft[] = invoiceRows.map((row, index) => {
    const sourceDocumentId = readString(row, DOCUMENT_KEYS);
    const sourceArtifactId = sourceDocumentId != null
      ? input.sourceArtifactIdByDocumentId?.get(sourceDocumentId) ?? null
      : null;
    const sourceIdentityStatus: CanonicalInvoiceSourceIdentityStatus =
      input.sourceIdentityStoreState === 'unreadable'
        ? 'unreadable'
        : sourceArtifactId != null
          ? 'present'
          : 'absent';
    const ownLineRows = grouped.byInvoiceRow.get(index) ?? [];
    const adapted = adaptCurrentInvoiceRows({
      invoiceRow: row,
      invoiceLines: ownLineRows,
      context: { projectId: input.projectId, documentId: sourceDocumentId },
    });
    const invoiceNumber = envelopeString(adapted.invoice.invoiceNumber)
      ?? readString(row, INVOICE_NUMBER_KEYS);
    const core = buildInvoiceIdentityCore({
      projectId: input.projectId,
      sourceArtifactId,
      sourceIdentityStatus,
      sourceDocumentId,
      invoiceNumber,
    });
    return {
      invoice: adapted.invoice,
      lines: adapted.lines,
      row,
      lineRows: ownLineRows,
      coreId: core.id,
      basis: core.basis,
      sourceRecordId: readString(row, RECORD_ID_KEYS),
      sourceArtifactId,
      sourceIdentityStatus,
      sourceIdentityReadError:
        sourceIdentityStatus === 'unreadable' ? input.sourceIdentityReadError ?? null : null,
      sourceDocumentId,
      invoiceNumber,
      documentFamily: sourceDocumentId != null
        ? input.documentFamilyByDocumentId?.get(sourceDocumentId) ?? null
        : null,
    };
  });

  // Where the document-scoped composite cannot separate two observations —
  // most often two unnumbered invoices in one document — source-observation
  // identity is added. Distinct observations are never collapsed onto one id.
  const coreCounts = new Map<string, number>();
  for (const draft of drafts) {
    coreCounts.set(draft.coreId, (coreCounts.get(draft.coreId) ?? 0) + 1);
  }

  const invoiceIdentities: CanonicalInvoiceIdentity[] = [];
  const invoices: CanonicalInvoice[] = [];
  const lines: CanonicalInvoiceLine[] = [];
  const lineIdentities: CanonicalInvoiceLineIdentity[] = [];
  const lineIdentityIssues: CanonicalInvoiceLineIdentityIssue[] = [];

  drafts.forEach((draft, ordinal) => {
    const collides = (coreCounts.get(draft.coreId) ?? 0) > 1;
    const discriminator = collides ? draft.sourceRecordId : null;
    const canonicalInvoiceId = !collides
      ? draft.coreId
      : discriminator != null
        ? `${draft.coreId}:observation:${stablePart(discriminator)}`
        : `${draft.coreId}:ordinal:${String(ordinal)}`;
    const identityConfidence: CanonicalIdentityConfidence = !collides
      ? 'document_scoped'
      : discriminator != null
        ? 'source_scoped'
        : 'unresolved';
    const basis = !collides
      ? draft.basis
      : [...draft.basis, discriminator != null ? `observation:${stablePart(discriminator)}` : `ordinal:${String(ordinal)}`];

    const provenance = buildCanonicalProvenance({
      adapterId: CANONICAL_INVOICE_ADAPTER_ID,
      derivation: identityConfidence === 'unresolved' ? 'unresolved' : 'observed',
      evidence: draft.invoice.evidence,
      sourceArtifactId: draft.sourceArtifactId,
      sourceDocumentId: draft.sourceDocumentId,
      sourceFamily: draft.documentFamily,
      observationId: draft.sourceRecordId,
    });

    invoiceIdentities.push({
      canonicalInvoiceId,
      projectId: input.projectId,
      sourceArtifactId: draft.sourceArtifactId,
      sourceIdentityStatus: draft.sourceIdentityStatus,
      sourceIdentityReadError: draft.sourceIdentityReadError,
      sourceDocumentId: draft.sourceDocumentId,
      sourceRecordId: draft.sourceRecordId,
      invoiceNumber: draft.invoiceNumber,
      invoiceNumberPresent: draft.invoiceNumber != null,
      invoiceDate: envelopeString(draft.invoice.invoiceDate),
      contractorVendor: envelopeString(draft.invoice.contractorVendor),
      documentFamily: draft.documentFamily,
      identityBasis: basis,
      identityConfidence,
      provenance,
    });

    invoices.push({
      ...draft.invoice,
      invoiceId: canonicalInvoiceId,
      identityKind: identityConfidence === 'unresolved' ? 'deterministic_fallback' : 'source',
      identityWarning: identityConfidence === 'unresolved'
        ? 'invoice_identity_unresolved_disambiguated_by_input_ordinal'
        : identityConfidence === 'source_scoped'
          ? 'invoice_identity_scoped_by_source_observation'
          : null,
      unresolvedFields: identityConfidence === 'unresolved'
        ? [...draft.invoice.unresolvedFields, 'invoiceId']
        : draft.invoice.unresolvedFields,
    });

    const assembled = assembleInvoiceLines({
      canonicalInvoiceId,
      sourceArtifactId: draft.sourceArtifactId,
      documentFamily: draft.documentFamily,
      invoiceDocumentId: draft.sourceDocumentId,
      lines: draft.lines,
      lineRows: draft.lineRows,
    });
    lines.push(...assembled.lines);
    lineIdentities.push(...assembled.identities);
    lineIdentityIssues.push(...assembled.issues);
  });

  return {
    invoices: invoices.sort((left, right) => compare(left.invoiceId, right.invoiceId)),
    lines: lines.sort((left, right) => compare(left.lineId, right.lineId)),
    invoiceIdentities: invoiceIdentities.sort((left, right) =>
      compare(left.canonicalInvoiceId, right.canonicalInvoiceId)),
    lineIdentities: lineIdentities.sort((left, right) =>
      compare(left.canonicalLineId, right.canonicalLineId)),
    identityConflicts: detectInvoiceIdentityConflicts(invoiceIdentities),
    lineIdentityIssues: lineIdentityIssues.sort((left, right) => compare(left.issueKey, right.issueKey)),
    distinctInvoiceIdentityCount: new Set(invoiceIdentities.map((identity) => identity.canonicalInvoiceId)).size,
    orphanedLineCount: grouped.orphaned.length,
  };
}

function assembleInvoiceLines(input: {
  readonly canonicalInvoiceId: string;
  readonly sourceArtifactId: string | null;
  readonly documentFamily: string | null;
  readonly invoiceDocumentId: string | null;
  readonly lines: readonly CanonicalInvoiceLine[];
  readonly lineRows: readonly PersistedCanonicalInvoiceRowInput[];
}): {
  readonly lines: readonly CanonicalInvoiceLine[];
  readonly identities: readonly CanonicalInvoiceLineIdentity[];
  readonly issues: readonly CanonicalInvoiceLineIdentityIssue[];
} {
  type LineDraft = {
    readonly line: CanonicalInvoiceLine;
    readonly coreId: string;
    readonly basis: readonly string[];
    readonly located: boolean;
    readonly sourceRecordId: string | null;
    readonly sourceDocumentId: string | null;
    readonly sourcePage: number | null;
    readonly sourceSheet: string | null;
    readonly sourceRow: number | null;
  };

  const drafts: LineDraft[] = input.lines.map((line, index) => {
    const row = input.lineRows[index] ?? {};
    const sourceRecordId = readString(row, LINE_RECORD_ID_KEYS);
    const sourceDocumentId = readString(row, DOCUMENT_KEYS) ?? input.invoiceDocumentId;
    const core = buildLineIdentityCore({
      canonicalInvoiceId: input.canonicalInvoiceId,
      sourceDocumentId,
      sourcePage: line.sourcePage,
      sourceSheet: line.sourceSheet,
      sourceRow: line.sourceRow,
      // The strongest available observation identity: the persisted row id,
      // else the source line anchor. Both are location/identity, not value.
      observationId: sourceRecordId ?? line.sourceLineIdentifier,
    });
    return {
      line,
      coreId: core.id,
      basis: core.basis,
      located: core.located,
      sourceRecordId,
      sourceDocumentId,
      sourcePage: line.sourcePage,
      sourceSheet: line.sourceSheet,
      sourceRow: line.sourceRow,
    };
  });

  const coreCounts = new Map<string, number>();
  for (const draft of drafts) {
    coreCounts.set(draft.coreId, (coreCounts.get(draft.coreId) ?? 0) + 1);
  }

  const lines: CanonicalInvoiceLine[] = [];
  const identities: CanonicalInvoiceLineIdentity[] = [];
  const unlocatedIds: string[] = [];
  const ambiguousIds: string[] = [];

  drafts.forEach((draft, ordinal) => {
    const collides = (coreCounts.get(draft.coreId) ?? 0) > 1;
    const canonicalLineId = collides
      ? `${draft.coreId}:ordinal:${String(ordinal)}`
      : draft.coreId;
    // A line with no source location AND no observation id cannot be proven
    // unique. It is kept — never merged into a neighbour — but its identity is
    // reported as unresolved rather than presented as trustworthy.
    const identityConfidence: CanonicalIdentityConfidence = !draft.located
      ? 'unresolved'
      : collides
        ? 'unresolved'
        : draft.sourceRecordId != null
          ? 'source_scoped'
          : 'document_scoped';

    if (!draft.located) unlocatedIds.push(canonicalLineId);
    else if (collides) ambiguousIds.push(canonicalLineId);

    const provenance = buildCanonicalProvenance({
      adapterId: CANONICAL_INVOICE_ADAPTER_ID,
      derivation: identityConfidence === 'unresolved' ? 'unresolved' : 'observed',
      evidence: draft.line.evidence,
      sourceArtifactId: input.sourceArtifactId,
      sourceDocumentId: draft.sourceDocumentId,
      sourceFamily: input.documentFamily,
      observationId: draft.sourceRecordId ?? draft.line.sourceLineIdentifier,
      page: draft.sourcePage,
      sheetName: draft.sourceSheet,
      rowNumber: draft.sourceRow,
    });

    identities.push({
      canonicalLineId,
      canonicalInvoiceId: input.canonicalInvoiceId,
      sourceArtifactId: input.sourceArtifactId,
      sourceDocumentId: draft.sourceDocumentId,
      sourceRecordId: draft.sourceRecordId,
      sourcePage: draft.sourcePage,
      sourceSheet: draft.sourceSheet,
      sourceRow: draft.sourceRow,
      identityBasis: collides ? [...draft.basis, `ordinal:${String(ordinal)}`] : draft.basis,
      identityConfidence,
      provenance,
    });

    lines.push({
      ...draft.line,
      lineId: canonicalLineId,
      invoiceId: input.canonicalInvoiceId,
      identityKind: identityConfidence === 'unresolved' ? 'deterministic_fallback' : 'source',
      identityWarning: !draft.located
        ? 'line_identity_unresolved_no_source_row_identity'
        : collides
          ? 'line_identity_ambiguous_source_location_disambiguated_by_ordinal'
          : null,
      unresolvedFields: identityConfidence === 'unresolved'
        ? [...draft.line.unresolvedFields, 'lineId']
        : draft.line.unresolvedFields,
    });
  });

  const issues: CanonicalInvoiceLineIdentityIssue[] = [];
  if (unlocatedIds.length > 0) {
    issues.push({
      issueKey: `${input.canonicalInvoiceId}:missing_source_row_identity`,
      canonicalInvoiceId: input.canonicalInvoiceId,
      canonicalLineIds: [...unlocatedIds].sort(compare),
      reason: 'missing_source_row_identity',
      detail:
        `${String(unlocatedIds.length)} invoice line(s) on ${input.canonicalInvoiceId} carry no source row, `
        + 'page, sheet, or observation identity. Their identity is unresolved; canonical authority '
        + 'preserved each line rather than merging lines that look alike.',
    });
  }
  if (ambiguousIds.length > 0) {
    issues.push({
      issueKey: `${input.canonicalInvoiceId}:ambiguous_source_location`,
      canonicalInvoiceId: input.canonicalInvoiceId,
      canonicalLineIds: [...ambiguousIds].sort(compare),
      reason: 'ambiguous_source_location',
      detail:
        `${String(ambiguousIds.length)} invoice line(s) on ${input.canonicalInvoiceId} share one source `
        + 'location. Each was preserved under a deterministic ordinal, and their identity is reported '
        + 'as unresolved rather than presented as unique.',
    });
  }

  return { lines, identities, issues };
}

/**
 * Detects one invoice number claimed by two distinct source documents.
 *
 * The canonical ids already differ, so nothing was merged. This record makes
 * the collision visible so the relationship layer can hold the affected
 * governing relationship unresolved instead of picking a document.
 */
function detectInvoiceIdentityConflicts(
  identities: readonly CanonicalInvoiceIdentity[],
): readonly CanonicalInvoiceIdentityConflict[] {
  const byNumber = new Map<string, CanonicalInvoiceIdentity[]>();
  for (const identity of identities) {
    if (identity.invoiceNumber == null) continue;
    const key = identity.invoiceNumber.trim().toLowerCase();
    byNumber.set(key, [...(byNumber.get(key) ?? []), identity]);
  }

  const conflicts: CanonicalInvoiceIdentityConflict[] = [];
  for (const [key, group] of byNumber) {
    const documents = [...new Set(group.map((identity) => identity.sourceDocumentId ?? 'unknown-document'))];
    // One document restating its own invoice number is not a conflict.
    if (documents.length < 2) continue;
    conflicts.push({
      conflictKey: `invoice-number:${key}`,
      invoiceNumber: group[0].invoiceNumber!,
      canonicalInvoiceIds: group.map((identity) => identity.canonicalInvoiceId).sort(compare),
      sourceDocumentIds: documents.sort(compare),
      detail:
        `Invoice number ${group[0].invoiceNumber!} is claimed by ${String(documents.length)} distinct source `
        + 'documents. Canonical authority preserved every observation and did not merge them on the '
        + 'invoice number alone; the governing invoice identity is unresolved until the source is corrected.',
    });
  }

  return conflicts.sort((left, right) => compare(left.conflictKey, right.conflictKey));
}
