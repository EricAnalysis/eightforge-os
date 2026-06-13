// lib/validation/contractValidation.ts
// Contract extraction validation harness for EightForge OS.
//
// Accepts an EightForge extraction payload (actual) and a reference JSON (expected).
// Produces a typed result object + human-readable reports.
//
// Design principles:
//  - Purely deterministic. No I/O, no AI, no randomness.
//  - Additive: does not touch the extraction pipeline.
//  - Field pickers try evidence_v1 first (structured), then typed_fields (heuristic).

import {
  normalizeDate,
  normalizeCurrency,
  fuzzyStringMatch,
  numericClose,
  dateMatch,
} from './normalizeValidationValues';

// ── Input types ───────────────────────────────────────────────────────────────

/** Shape of one rate row in the expected reference JSON. */
export type ExpectedRateRow = {
  material_type?: string | null;
  unit?: string | null;
  rate_amount?: number | null;
  rate_raw?: string;
};

/**
 * Expected reference JSON shape.
 * All fields are optional — only the ones provided will be checked.
 */
export type ContractExpected = {
  /** Human-readable label used in reports. */
  contract_name?: string;
  contractor_name?: string | null;
  executed_date?: string | null;
  term_start_date?: string | null;
  term_end_date?: string | null;
  not_to_exceed_amount?: number | null;
  rate_schedule_present?: boolean;
  /** Expected number of rate rows. Compared exactly unless rate_row_count_exact=false. */
  rate_row_count?: number;
  /** Optional row-by-row rate comparison. Matched by index order. */
  rate_rows?: ExpectedRateRow[];
  /**
   * Anchor/evidence keys expected to be populated.
   * Checked against evidence_v1.structured_fields key presence.
   */
  expected_anchors?: string[];
  /** Optional tolerance overrides. */
  tolerance?: {
    /** % tolerance for currency comparisons. Default: 0 (exact). */
    currency_pct?: number;
    /** Require exact string match for contractor_name. Default: false (substring ok). */
    string_exact?: boolean;
    /** Require exact rate_row_count. Default: true. */
    rate_row_count_exact?: boolean;
  };
};

/**
 * EightForge extraction payload shape.
 * Maps to the output of extractDocument() in documentExtraction.ts,
 * optionally enriched by documentEvidencePipelineV1.ts.
 */
export type ContractActual = {
  fields?: {
    typed_fields?: Record<string, unknown> | null;
    detected_document_type?: string | null;
    [key: string]: unknown;
  } | null;
  extraction?: {
    text_preview?: string | null;
    evidence_v1?: {
      structured_fields?: Record<string, unknown> | null;
      section_signals?: Record<string, unknown> | null;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  } | null;
  ai_enrichment?: {
    confidence_note?: string | null;
    classification?: string | null;
    [key: string]: unknown;
  } | null;
};

// ── Output types ──────────────────────────────────────────────────────────────

export type ValidationStatus = 'PASS' | 'FAIL' | 'MISSING' | 'WARN';

export type FieldValidationResult = {
  field: string;
  expected: unknown;
  actual: unknown;
  status: ValidationStatus;
  reason: string;
};

export type ContractValidationResult = {
  contract_name: string;
  overall_status: ValidationStatus;
  passed_checks: number;
  failed_checks: number;
  missing_checks: number;
  warnings: string[];
  field_results: FieldValidationResult[];
  validated_at: string;
};

// ── Field pickers ─────────────────────────────────────────────────────────────
// Each picker tries the most authoritative source first.

function sf(actual: ContractActual): Record<string, unknown> {
  return (actual.extraction?.evidence_v1?.structured_fields ?? {}) as Record<string, unknown>;
}

function ss(actual: ContractActual): Record<string, unknown> {
  return (actual.extraction?.evidence_v1?.section_signals ?? {}) as Record<string, unknown>;
}

function tf(actual: ContractActual): Record<string, unknown> {
  return (actual.fields?.typed_fields ?? {}) as Record<string, unknown>;
}

/** Pick contractor name: evidence_v1 > typed_fields vendor_name/contractor_name. */
export function pickContractorName(actual: ContractActual): string | null {
  const s = sf(actual);
  const t = tf(actual);
  return (
    (s.contractor_name as string | null) ??
    (t.vendor_name as string | null) ??
    (t.contractor_name as string | null) ??
    null
  );
}

/** Pick executed/contract date: evidence_v1 > typed_fields contract_date. */
export function pickExecutedDate(actual: ContractActual): string | null {
  const s = sf(actual);
  const t = tf(actual);
  return (
    (s.executed_date as string | null) ??
    (t.contract_date as string | null) ??
    (t.executed_date as string | null) ??
    null
  );
}

/** Pick term start date: evidence_v1 > typed_fields effective_date. */
export function pickTermStartDate(actual: ContractActual): string | null {
  const s = sf(actual);
  const t = tf(actual);
  return (
    (s.term_start_date as string | null) ??
    (t.effective_date as string | null) ??
    (t.term_start_date as string | null) ??
    null
  );
}

/** Pick term end date: evidence_v1 > typed_fields expiration_date. */
export function pickTermEndDate(actual: ContractActual): string | null {
  const s = sf(actual);
  const t = tf(actual);
  return (
    (s.term_end_date as string | null) ??
    (s.expiration_date as string | null) ??
    (t.expiration_date as string | null) ??
    (t.term_end_date as string | null) ??
    null
  );
}

/** Pick NTE: evidence_v1 (already numeric) > typed_fields nte_amount. */
export function pickNTE(actual: ContractActual): number | null {
  const s = sf(actual);
  const t = tf(actual);
  const fromEvidence = normalizeCurrency(s.nte_amount as string | number | null | undefined);
  if (fromEvidence !== null) return fromEvidence;
  return normalizeCurrency(
    (t.nte_amount ?? t.not_to_exceed_amount ?? t.notToExceedAmount) as string | number | null | undefined
  );
}

/**
 * Detect rate schedule presence.
 * Priority: section_signals > typed_fields rate_table length > false.
 */
export function pickRateSchedulePresent(actual: ContractActual): boolean {
  const signals = ss(actual);
  if (signals.rate_section_present === true) return true;
  if (signals.unit_price_structure_present === true) return true;
  const rows = pickRateRows(actual);
  return rows.length > 0;
}

/** Pick rate table rows from typed_fields. Returns empty array if none. */
export function pickRateRows(actual: ContractActual): ExpectedRateRow[] {
  const t = tf(actual);
  const rows = t.rate_table;
  if (!Array.isArray(rows)) return [];
  return rows as ExpectedRateRow[];
}

/**
 * Pick rate row count.
 * Prefers section_signals.rate_items_detected (evidence pipeline count)
 * over typed_fields.rate_table.length (heuristic count).
 */
export function pickRateRowCount(actual: ContractActual): number {
  const signals = ss(actual);
  if (typeof signals.rate_items_detected === 'number') return signals.rate_items_detected;
  return pickRateRows(actual).length;
}

// ── Individual field validators ───────────────────────────────────────────────

function validateContractorName(
  actual: ContractActual,
  expected: ContractExpected,
): FieldValidationResult {
  if (!('contractor_name' in expected)) {
    return { field: 'contractor_name', expected: undefined, actual: undefined, status: 'PASS', reason: 'not checked' };
  }

  const actualVal = pickContractorName(actual);
  const expectedVal = expected.contractor_name;

  if (expectedVal === null && actualVal === null) {
    return { field: 'contractor_name', expected: null, actual: null, status: 'PASS', reason: 'both null as expected' };
  }
  if (actualVal === null) {
    return { field: 'contractor_name', expected: expectedVal, actual: null, status: 'MISSING', reason: 'contractor_name not found in extraction' };
  }
  if (expectedVal === null) {
    return { field: 'contractor_name', expected: null, actual: actualVal, status: 'FAIL', reason: 'expected null but got a value' };
  }

  const exact = expected.tolerance?.string_exact ?? false;
  const r = fuzzyStringMatch(actualVal, expectedVal, { exact });
  return {
    field: 'contractor_name',
    expected: expectedVal,
    actual: actualVal,
    status: r.match ? 'PASS' : 'FAIL',
    reason: r.reason,
  };
}

function validateDateField(
  field: string,
  actualVal: string | null,
  expectedVal: string | null | undefined,
): FieldValidationResult {
  if (expectedVal === undefined) {
    return { field, expected: undefined, actual: undefined, status: 'PASS', reason: 'not checked' };
  }

  const normalizedActual = normalizeDate(actualVal);
  const normalizedExpected = normalizeDate(expectedVal);

  if (normalizedExpected === null && normalizedActual === null) {
    return { field, expected: null, actual: null, status: 'PASS', reason: 'both null as expected' };
  }
  if (normalizedActual === null) {
    return { field, expected: normalizedExpected, actual: null, status: 'MISSING', reason: `${field} not found in extraction` };
  }
  if (normalizedExpected === null) {
    return { field, expected: null, actual: normalizedActual, status: 'FAIL', reason: 'expected null but got a value' };
  }

  const r = dateMatch(actualVal, expectedVal);
  return {
    field,
    expected: normalizedExpected,
    actual: normalizedActual,
    status: r.match ? 'PASS' : 'FAIL',
    reason: r.reason,
  };
}

function validateNTE(
  actual: ContractActual,
  expected: ContractExpected,
): FieldValidationResult {
  if (!('not_to_exceed_amount' in expected)) {
    return { field: 'not_to_exceed_amount', expected: undefined, actual: undefined, status: 'PASS', reason: 'not checked' };
  }

  const actualVal = pickNTE(actual);
  const expectedVal = expected.not_to_exceed_amount;

  if (expectedVal === null && actualVal === null) {
    return { field: 'not_to_exceed_amount', expected: null, actual: null, status: 'PASS', reason: 'both null as expected' };
  }
  if (actualVal === null) {
    return { field: 'not_to_exceed_amount', expected: expectedVal, actual: null, status: 'MISSING', reason: 'NTE not found in extraction' };
  }
  if (expectedVal === null) {
    return { field: 'not_to_exceed_amount', expected: null, actual: actualVal, status: 'FAIL', reason: 'expected null but got a value' };
  }

  const tolerancePct = expected.tolerance?.currency_pct ?? 0;
  const r = numericClose(actualVal, expectedVal, tolerancePct);
  return {
    field: 'not_to_exceed_amount',
    expected: expectedVal,
    actual: actualVal,
    status: r.match ? 'PASS' : 'FAIL',
    reason: r.reason,
  };
}

function validateRateSchedulePresent(
  actual: ContractActual,
  expected: ContractExpected,
): FieldValidationResult {
  if (!('rate_schedule_present' in expected)) {
    return { field: 'rate_schedule_present', expected: undefined, actual: undefined, status: 'PASS', reason: 'not checked' };
  }

  const actualVal = pickRateSchedulePresent(actual);
  const expectedVal = expected.rate_schedule_present!;
  const match = actualVal === expectedVal;
  return {
    field: 'rate_schedule_present',
    expected: expectedVal,
    actual: actualVal,
    status: match ? 'PASS' : 'FAIL',
    reason: match ? `rate_schedule_present = ${actualVal}` : `expected ${expectedVal}, got ${actualVal}`,
  };
}

function validateRateRowCount(
  actual: ContractActual,
  expected: ContractExpected,
): FieldValidationResult {
  if (!('rate_row_count' in expected)) {
    return { field: 'rate_row_count', expected: undefined, actual: undefined, status: 'PASS', reason: 'not checked' };
  }

  const actualCount = pickRateRowCount(actual);
  const expectedCount = expected.rate_row_count!;
  const exact = expected.tolerance?.rate_row_count_exact !== false; // default true
  const match = exact ? actualCount === expectedCount : actualCount >= expectedCount;
  const reason = match
    ? `row count ${actualCount} ${exact ? '== ' : '>= '}${expectedCount}`
    : `expected ${expectedCount} rows, got ${actualCount}${!exact ? ' (minimum)' : ''}`;

  return {
    field: 'rate_row_count',
    expected: expectedCount,
    actual: actualCount,
    status: match ? 'PASS' : 'FAIL',
    reason,
  };
}

function validateRateRows(
  actual: ContractActual,
  expected: ContractExpected,
): FieldValidationResult[] {
  if (!expected.rate_rows?.length) return [];

  const actualRows = pickRateRows(actual);
  const results: FieldValidationResult[] = [];

  for (let i = 0; i < expected.rate_rows.length; i++) {
    const exp = expected.rate_rows[i];
    const act = actualRows[i] ?? null;
    const field = `rate_rows[${i}]`;

    if (act === null) {
      results.push({
        field,
        expected: exp,
        actual: null,
        status: 'MISSING',
        reason: `row ${i} not present in extraction (found ${actualRows.length} rows total)`,
      });
      continue;
    }

    const issues: string[] = [];

    // Compare rate_amount if provided
    if (exp.rate_amount !== undefined) {
      const tolerancePct = expected.tolerance?.currency_pct ?? 0;
      const r = numericClose(act.rate_amount as number | null, exp.rate_amount, tolerancePct);
      if (!r.match) issues.push(`rate_amount: ${r.reason}`);
    }

    // Compare unit if provided (tolerant string match)
    if (exp.unit !== undefined) {
      const r = fuzzyStringMatch(act.unit as string | null, exp.unit);
      if (!r.match) issues.push(`unit: ${r.reason}`);
    }

    // Compare material_type if provided (tolerant)
    if (exp.material_type !== undefined) {
      const r = fuzzyStringMatch(act.material_type as string | null, exp.material_type);
      if (!r.match) issues.push(`material_type: ${r.reason}`);
    }

    results.push({
      field,
      expected: exp,
      actual: act,
      status: issues.length === 0 ? 'PASS' : 'FAIL',
      reason: issues.length === 0 ? 'row fields match' : issues.join('; '),
    });
  }

  return results;
}

function validateEvidenceAnchors(
  actual: ContractActual,
  expected: ContractExpected,
): FieldValidationResult[] {
  if (!expected.expected_anchors?.length) return [];

  const structured = sf(actual);
  return expected.expected_anchors.map((anchor) => {
    const present = anchor in structured && structured[anchor] != null;
    return {
      field: `evidence_anchor:${anchor}`,
      expected: 'populated',
      actual: present ? structured[anchor] : null,
      status: present ? 'PASS' : ('MISSING' as ValidationStatus),
      reason: present ? `${anchor} is present in structured_fields` : `${anchor} missing from evidence_v1.structured_fields`,
    };
  });
}

// ── Warnings collector ────────────────────────────────────────────────────────

function collectWarnings(actual: ContractActual, results: FieldValidationResult[]): string[] {
  const warnings: string[] = [];

  // Confidence note from AI enrichment
  const confidenceNote = actual.ai_enrichment?.confidence_note;
  if (confidenceNote) warnings.push(`AI confidence note: "${confidenceNote}"`);

  // Rate schedule detected via text only (no structured signal)
  const signals = ss(actual);
  const ratePresent = pickRateSchedulePresent(actual);
  if (
    ratePresent &&
    signals.rate_section_present !== true &&
    signals.unit_price_structure_present !== true
  ) {
    warnings.push('Rate schedule detected via text heuristics only — no structured evidence_v1 signal present');
  }

  // Contractor name sourced from heuristic (lower confidence)
  const structured = sf(actual);
  const contractorSource = structured.contractor_name_source as string | null | undefined;
  if (contractorSource === 'heuristic') {
    warnings.push('contractor_name sourced from heuristic pattern match — verify against document header');
  }

  // Any MISSING fields that were in expected
  const missingFields = results.filter(r => r.status === 'MISSING').map(r => r.field);
  if (missingFields.length > 0) {
    warnings.push(`Fields not found in extraction: ${missingFields.join(', ')}`);
  }

  return warnings;
}

// ── Main validator ────────────────────────────────────────────────────────────

/**
 * Validate an EightForge contract extraction against expected reference values.
 *
 * @param actual   - Extraction payload from the EightForge pipeline.
 * @param expected - Reference JSON with known ground-truth values.
 * @returns        - Typed validation result with per-field status + reports.
 *
 * @example
 * const result = validateContractExtraction(extractionPayload, williamsonExpected);
 * console.log(formatTerminalReport(result));
 */
export function validateContractExtraction(
  actual: ContractActual,
  expected: ContractExpected,
): ContractValidationResult {
  const contractName = expected.contract_name ?? 'Unnamed Contract';

  const fieldResults: FieldValidationResult[] = [
    validateContractorName(actual, expected),
    validateDateField('executed_date', pickExecutedDate(actual), expected.executed_date),
    validateDateField('term_start_date', pickTermStartDate(actual), expected.term_start_date),
    validateDateField('term_end_date', pickTermEndDate(actual), expected.term_end_date),
    validateNTE(actual, expected),
    validateRateSchedulePresent(actual, expected),
    validateRateRowCount(actual, expected),
    ...validateRateRows(actual, expected),
    ...validateEvidenceAnchors(actual, expected),
  ].filter(r => r.expected !== undefined); // drop 'not checked' fields

  const warnings = collectWarnings(actual, fieldResults);

  const passed = fieldResults.filter(r => r.status === 'PASS').length;
  const failed = fieldResults.filter(r => r.status === 'FAIL').length;
  const missing = fieldResults.filter(r => r.status === 'MISSING').length;

  const overall: ValidationStatus =
    failed > 0 ? 'FAIL' : missing > 0 ? 'WARN' : warnings.length > 0 ? 'WARN' : 'PASS';

  return {
    contract_name: contractName,
    overall_status: overall,
    passed_checks: passed,
    failed_checks: failed,
    missing_checks: missing,
    warnings,
    field_results: fieldResults,
    validated_at: new Date().toISOString(),
  };
}

// ── Terminal report ───────────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function statusIcon(status: ValidationStatus): string {
  switch (status) {
    case 'PASS': return `${ANSI.green}✓${ANSI.reset}`;
    case 'FAIL': return `${ANSI.red}✗${ANSI.reset}`;
    case 'MISSING': return `${ANSI.yellow}⚠${ANSI.reset}`;
    case 'WARN': return `${ANSI.yellow}~${ANSI.reset}`;
  }
}

function overallBadge(status: ValidationStatus): string {
  const labels: Record<ValidationStatus, string> = {
    PASS: `${ANSI.green}${ANSI.bold}PASS${ANSI.reset}`,
    FAIL: `${ANSI.red}${ANSI.bold}FAIL${ANSI.reset}`,
    WARN: `${ANSI.yellow}${ANSI.bold}WARN${ANSI.reset}`,
    MISSING: `${ANSI.yellow}${ANSI.bold}MISSING${ANSI.reset}`,
  };
  return labels[status];
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return ANSI.dim + 'null' + ANSI.reset;
  if (typeof v === 'number') return `${ANSI.cyan}${v.toLocaleString()}${ANSI.reset}`;
  if (typeof v === 'boolean') return `${ANSI.cyan}${v}${ANSI.reset}`;
  if (typeof v === 'object') return ANSI.dim + JSON.stringify(v) + ANSI.reset;
  return `"${v}"`;
}

/**
 * Format a compact, ANSI-colored terminal report.
 */
export function formatTerminalReport(result: ContractValidationResult): string {
  const bar = '─'.repeat(56);
  const lines: string[] = [
    `\n${ANSI.bold}${bar}${ANSI.reset}`,
    `${ANSI.bold}CONTRACT VALIDATION: ${result.contract_name}${ANSI.reset}`,
    bar,
    `Overall: ${overallBadge(result.overall_status)}   ` +
      `${ANSI.green}${result.passed_checks} passed${ANSI.reset}  ` +
      `${ANSI.red}${result.failed_checks} failed${ANSI.reset}  ` +
      `${ANSI.yellow}${result.missing_checks} missing${ANSI.reset}`,
    '',
  ];

  const passed = result.field_results.filter(r => r.status === 'PASS');
  const failed = result.field_results.filter(r => r.status === 'FAIL');
  const missing = result.field_results.filter(r => r.status === 'MISSING');

  if (passed.length > 0) {
    lines.push(`${ANSI.bold}PASSED:${ANSI.reset}`);
    for (const r of passed) {
      lines.push(`  ${statusIcon('PASS')} ${r.field.padEnd(28)} ${fmtValue(r.actual)}`);
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push(`${ANSI.bold}FAILED:${ANSI.reset}`);
    for (const r of failed) {
      lines.push(`  ${statusIcon('FAIL')} ${r.field}`);
      lines.push(`       expected: ${fmtValue(r.expected)}`);
      lines.push(`       actual:   ${fmtValue(r.actual)}`);
      lines.push(`       ${ANSI.dim}reason: ${r.reason}${ANSI.reset}`);
    }
    lines.push('');
  }

  if (missing.length > 0) {
    lines.push(`${ANSI.bold}MISSING:${ANSI.reset}`);
    for (const r of missing) {
      lines.push(`  ${statusIcon('MISSING')} ${r.field.padEnd(28)} ${ANSI.dim}${r.reason}${ANSI.reset}`);
    }
    lines.push('');
  }

  if (result.warnings.length > 0) {
    lines.push(`${ANSI.bold}WARNINGS:${ANSI.reset}`);
    for (const w of result.warnings) {
      lines.push(`  ${ANSI.yellow}•${ANSI.reset} ${w}`);
    }
    lines.push('');
  }

  lines.push(`${ANSI.dim}Validated at: ${result.validated_at}${ANSI.reset}`);
  lines.push(bar);

  return lines.join('\n');
}

// ── Markdown summary ──────────────────────────────────────────────────────────

function mdStatusIcon(status: ValidationStatus): string {
  switch (status) {
    case 'PASS': return '✅';
    case 'FAIL': return '❌';
    case 'MISSING': return '⚠️';
    case 'WARN': return '⚠️';
  }
}

function mdFmtValue(v: unknown): string {
  if (v === null || v === undefined) return '_null_';
  if (typeof v === 'object') return `\`${JSON.stringify(v)}\``;
  return `\`${v}\``;
}

/**
 * Format a Markdown summary suitable for issue trackers, Notion docs, etc.
 */
export function formatMarkdownSummary(result: ContractValidationResult): string {
  const overallIcon = mdStatusIcon(result.overall_status);
  const lines: string[] = [
    `## ${overallIcon} Contract Validation: ${result.contract_name}`,
    '',
    `**Overall:** \`${result.overall_status}\` — ` +
      `${result.passed_checks} passed / ${result.failed_checks} failed / ${result.missing_checks} missing`,
    '',
    '| Field | Expected | Actual | Status | Reason |',
    '|-------|----------|--------|--------|--------|',
  ];

  for (const r of result.field_results) {
    const icon = mdStatusIcon(r.status);
    lines.push(
      `| \`${r.field}\` | ${mdFmtValue(r.expected)} | ${mdFmtValue(r.actual)} | ${icon} ${r.status} | ${r.reason} |`,
    );
  }

  if (result.warnings.length > 0) {
    lines.push('', '### Warnings', '');
    for (const w of result.warnings) lines.push(`- ⚠️ ${w}`);
  }

  lines.push('', `_Validated at: ${result.validated_at}_`);
  return lines.join('\n');
}
