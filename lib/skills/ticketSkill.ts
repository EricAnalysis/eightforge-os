import { xrefPrimaryFact, xrefRelatedDocumentFact } from '@/lib/intelligence/groundingRefs';
import type { DocumentFamilySkill, NormalizedNodeDocument, SkillExecutionOutput } from '@/lib/pipeline/types';
import {
  collectEvidenceByIds,
  findRelatedDocument,
  getArrayFact,
  getFact,
  getNumberFact,
  getStringFact,
  makeDecision,
  makeTask,
} from '@/lib/skills/shared';

type TicketRowShape = {
  ticket_id?: string | null;
  sheet_name?: string;
  sheet_key?: string;
  row_number?: number;
  invoice_number?: string | null;
  contract_line_item?: string | null;
  quantity?: number | null;
  missing_fields?: string[];
  evidence_ref?: string;
  field_evidence_ids?: Partial<Record<string, string>>;
  column_headers?: Partial<Record<string, string | null>>;
};

function parseLineQuantity(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[$,]/g, '').trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Invoice / ticket typed line rows comparable to canonical extractComparableExportLineRows. */
function comparableLinesFromTyped(typed: Record<string, unknown>): Array<{ code: string; quantity: number }> {
  const raw = typed.line_items ?? typed.lineItems ?? typed.ticket_line_items ?? typed.g703_line_items;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ code: string; quantity: number }> = [];
  for (const row of raw) {
    const r = row as Record<string, unknown>;
    const code = String(r.item_code ?? r.code ?? r.clin ?? r.line_code ?? '').trim();
    if (!code) continue;
    const quantity = parseLineQuantity(r.quantity ?? r.qty ?? r.load_cy ?? r.cy);
    if (quantity == null) continue;
    out.push({ code, quantity });
  }
  return out;
}

function firstRowWithMissing(
  document: NormalizedNodeDocument,
  field: 'quantity' | 'rate',
): TicketRowShape | null {
  const rows = getArrayFact<TicketRowShape>(document, 'ticket_rows');
  return rows.find((row) => Array.isArray(row.missing_fields) && row.missing_fields.includes(field)) ?? null;
}

function ticketFactEvidenceIds(document: NormalizedNodeDocument, key: string): string[] {
  return getFact(document, key)?.evidence_refs ?? [];
}

function formatTicketLocation(row: TicketRowShape | null): string {
  if (!row) return 'location not pinned to a single row in facts';
  const sheet = row.sheet_name ?? row.sheet_key ?? 'ticket sheet';
  const r = row.row_number != null ? String(row.row_number) : '?';
  return `"${sheet}" row ${r}`;
}

export const ticketSkill: DocumentFamilySkill = {
  documentFamily: 'ticket',
  requiredFacts: ['ticket_row_count'],
  decisionRules: [
    'Quantities must be grounded at the row level.',
    'Rates must be grounded at the row level before invoice reconciliation.',
    'If no rows parse cleanly, the ticket export cannot drive downstream decisions.',
  ],
  actionGenerationRules: [
    'Actions should name the first affected ticket row and invoice reference when available.',
    'Do not emit generic review actions for row-level support gaps.',
  ],
  evidenceExpectations: [
    'Each ticket row should retain sheet name and row location metadata.',
    'Missing quantity or rate findings should reference a specific row citation.',
  ],
  reviewTriggers: [
    'Ticket rows missing quantity',
    'Ticket rows missing rate',
    'No parsed ticket rows',
  ],
  run(input): SkillExecutionOutput {
    const relatedInvoice = findRelatedDocument(input.relatedDocuments, 'invoice');
    const rowCount = getNumberFact(input.primaryDocument, 'ticket_row_count') ?? 0;
    const missingQuantityRows = getNumberFact(input.primaryDocument, 'missing_quantity_rows') ?? 0;
    const missingRateRows = getNumberFact(input.primaryDocument, 'missing_rate_rows') ?? 0;
    const linkedInvoiceNumber = getStringFact(relatedInvoice ?? input.primaryDocument, 'invoice_number');
    const decisions: SkillExecutionOutput['decisions'] = [];
    const actions: SkillExecutionOutput['actions'] = [];
    const audit_notes: SkillExecutionOutput['audit_notes'] = [
      {
        id: 'audit:ticket:summary',
        stage: 'decision' as const,
        status: rowCount > 0 ? 'info' as const : 'warning' as const,
        message: rowCount > 0
          ? `Parsed ${rowCount} ticket-support rows from the workbook.`
          : 'Ticket export did not yield any usable support rows.',
        fact_refs: ['ticket_row_count'],
        evidence_refs: ticketFactEvidenceIds(input.primaryDocument, 'ticket_row_count'),
      },
    ];

    if (rowCount === 0) {
      const decisionId = 'ticket:no_rows';
      const factRefs = ticketFactEvidenceIds(input.primaryDocument, 'ticket_row_count');
      const evidence_objects = collectEvidenceByIds(factRefs, input.allEvidenceById);
      decisions.push(makeDecision({
        id: decisionId,
        family: 'missing',
        severity: 'critical',
        title: 'No usable ticket rows were parsed',
        detail: 'The ticket export did not normalize into row-level support, so quantities and rates cannot be cited downstream.',
        reason:
          'Rule ticket_rows_missing: ticket_row_count is zero; no sheet_row or sheet_cell citations were produced for this workbook.',
        confidence: 0.41,
        fact_refs: ['ticket_row_count'],
        evidence_objects,
        missing_source_context: [
          'No ticket row normalization output.',
          ...(factRefs.length === 0 ? ['No spreadsheet evidence ids on ticket_row_count fact.'] : []),
        ],
        rule_id: 'ticket_rows_missing',
        field_key: 'ticket_row_count',
        expected_location: 'ticket export workbook',
        reconciliation_scope: 'single_document',
        primary_action: {
          id: 'action:ticket_rows',
          type: 'attach',
          target_object_type: 'spreadsheet',
          target_object_id: input.primaryDocument.document_id,
          target_label: input.primaryDocument.document_title ?? input.primaryDocument.document_name,
          description: 'Upload a ticket workbook that includes header-mapped quantity and rate columns.',
          expected_outcome: 'Parser returns at least one ticket row with sheet_cell ids for quantity and rate.',
          resolvable: false,
        },
      }));
      actions.push(makeTask({
        id: 'task:ticket_rows',
        title: 'Upload a ticket workbook with mappable quantity and rate columns',
        priority: 'high',
        verb: 'attach',
        entity_type: 'spreadsheet',
        flow_type: 'documentation',
        expected_outcome: 'Workbook normalizes to ticket rows with cell-level citations.',
        source_decision_ids: [decisionId],
      }));
    }

    if (missingQuantityRows > 0) {
      const row = firstRowWithMissing(input.primaryDocument, 'quantity');
      const qtyHeader =
        row?.column_headers && typeof row.column_headers.quantity === 'string'
          ? row.column_headers.quantity
          : null;
      const cellId = row?.field_evidence_ids?.quantity;
      const rowRef = row?.evidence_ref;
      const refList = [cellId, rowRef, ...ticketFactEvidenceIds(input.primaryDocument, 'missing_quantity_rows')]
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const uniqueRefs = [...new Set(refList)];
      const evidence_objects = collectEvidenceByIds(uniqueRefs, input.allEvidenceById);
      const ticketRef = row?.ticket_id ?? (row?.row_number != null ? `row ${row.row_number}` : 'first affected row');
      const invoiceRef = row?.invoice_number ?? linkedInvoiceNumber ?? 'linked invoice (not matched)';
      const lineRef = row?.contract_line_item ? `contract line ${row.contract_line_item}` : 'contract line (not on row)';
      const loc = formatTicketLocation(row);
      const decisionId = 'ticket:quantity_missing';
      const qtyLabel = qtyHeader ?? 'quantity column (header not matched)';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'missing',
        severity: 'warning',
        title: 'Ticket export rows are missing quantity support',
        detail: `${missingQuantityRows} ticket row${missingQuantityRows === 1 ? '' : 's'} did not yield a grounded quantity value.`,
        reason:
          `Rule ticket_quantity_missing: ${loc}, column "${qtyLabel}" — quantity is empty or unparsable. `
          + `Evidence ids: ${uniqueRefs.length > 0 ? uniqueRefs.join(', ') : 'none resolved'}. `
          + `Compare to ${invoiceRef} / ${lineRef}.`,
        confidence: uniqueRefs.length >= 2 ? 0.78 : 0.66,
        fact_refs: ['missing_quantity_rows', 'ticket_rows'],
        evidence_objects,
        missing_source_context: [
          ...(cellId ? [] : ['No sheet_cell id for quantity on the exemplar row.']),
          ...(qtyHeader ? [] : ['Quantity column header was not alias-matched.']),
        ],
        rule_id: 'ticket_quantity_missing',
        field_key: 'missing_quantity_rows',
        reconciliation_scope: 'single_document',
        primary_action: {
          id: 'action:ticket_quantity',
          type: 'verify',
          target_object_type: 'ticket',
          target_object_id: input.primaryDocument.document_id,
          target_label: input.primaryDocument.document_title ?? input.primaryDocument.document_name,
          description: `Enter the quantity for ticket ${ticketRef} in "${qtyLabel}" on ${loc}.`,
          expected_outcome: 'That cell reparses to a numeric quantity with the same evidence id.',
          resolvable: false,
        },
      }));
      actions.push(makeTask({
        id: 'task:ticket_quantity',
        title: `Fill quantity for ${ticketRef} (${loc})`,
        priority: 'medium',
        verb: 'verify',
        entity_type: 'ticket',
        flow_type: 'validation',
        expected_outcome: 'Quantity cell matches invoice support.',
        source_decision_ids: [decisionId],
      }));
    }

    if (missingRateRows > 0) {
      const row = firstRowWithMissing(input.primaryDocument, 'rate');
      const rateHeader =
        row?.column_headers && typeof row.column_headers.rate === 'string'
          ? row.column_headers.rate
          : null;
      const cellId = row?.field_evidence_ids?.rate;
      const rowRef = row?.evidence_ref;
      const refList = [cellId, rowRef, ...ticketFactEvidenceIds(input.primaryDocument, 'missing_rate_rows')]
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const uniqueRefs = [...new Set(refList)];
      const evidence_objects = collectEvidenceByIds(uniqueRefs, input.allEvidenceById);
      const ticketRef = row?.ticket_id ?? (row?.row_number != null ? `row ${row.row_number}` : 'first affected row');
      const lineRef = row?.contract_line_item ? `contract line ${row.contract_line_item}` : 'governing contract line (not on row)';
      const loc = formatTicketLocation(row);
      const decisionId = 'ticket:rate_missing';
      const rateLabel = rateHeader ?? 'rate column (header not matched)';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'risk',
        severity: 'warning',
        title: 'Ticket export rows are missing rate support',
        detail: `${missingRateRows} ticket row${missingRateRows === 1 ? '' : 's'} did not yield a grounded rate value.`,
        reason:
          `Rule ticket_rate_missing: ${loc}, column "${rateLabel}" — rate is empty or unparsable. `
          + `Evidence ids: ${uniqueRefs.length > 0 ? uniqueRefs.join(', ') : 'none resolved'}. `
          + `Tie to ${lineRef}.`,
        confidence: uniqueRefs.length >= 2 ? 0.76 : 0.64,
        fact_refs: ['missing_rate_rows', 'ticket_rows'],
        evidence_objects,
        missing_source_context: [
          ...(cellId ? [] : ['No sheet_cell id for rate on the exemplar row.']),
          ...(rateHeader ? [] : ['Rate column header was not alias-matched.']),
        ],
        rule_id: 'ticket_rate_missing',
        field_key: 'missing_rate_rows',
        reconciliation_scope: 'single_document',
        primary_action: {
          id: 'action:ticket_rate',
          type: 'verify',
          target_object_type: 'ticket',
          target_object_id: input.primaryDocument.document_id,
          target_label: input.primaryDocument.document_title ?? input.primaryDocument.document_name,
          description: `Enter the unit rate for ticket ${ticketRef} in "${rateLabel}" on ${loc}.`,
          expected_outcome: 'That cell reparses to a numeric rate with the same evidence id.',
          resolvable: false,
        },
      }));
      actions.push(makeTask({
        id: 'task:ticket_rate',
        title: `Fill rate for ${ticketRef} (${loc})`,
        priority: 'medium',
        verb: 'verify',
        entity_type: 'ticket',
        flow_type: 'validation',
        expected_outcome: 'Rate cell matches the governing price source.',
        source_decision_ids: [decisionId],
      }));
    }

    if (rowCount > 0 && missingQuantityRows === 0 && missingRateRows === 0) {
      const rows = getArrayFact<TicketRowShape>(input.primaryDocument, 'ticket_rows');
      const sample = rows[0];
      const sampleRefs = [
        sample?.field_evidence_ids?.quantity,
        sample?.field_evidence_ids?.rate,
        sample?.evidence_ref,
        ...ticketFactEvidenceIds(input.primaryDocument, 'ticket_rows'),
      ].filter((id): id is string => typeof id === 'string');
      const uniqueRefs = [...new Set(sampleRefs)].slice(0, 12);
      const evidence_objects = collectEvidenceByIds(uniqueRefs, input.allEvidenceById);
      const loc = formatTicketLocation(sample ?? null);
      const qCol = sample?.column_headers?.quantity ?? 'quantity column';
      const rCol = sample?.column_headers?.rate ?? 'rate column';
      decisions.push(makeDecision({
        id: 'ticket:support_confirmed',
        family: 'confirmed',
        severity: 'info',
        title: 'Confirmed ticket support rows',
        detail: `Parsed ${rowCount} ticket row${rowCount === 1 ? '' : 's'} with quantity and rate support.`,
        reason:
          `Rule ticket_support_confirmed: each row exposes quantity and rate. Sample ${loc}: columns "${qCol}" and "${rCol}". `
          + `Evidence ids: ${uniqueRefs.join(', ') || ticketFactEvidenceIds(input.primaryDocument, 'ticket_row_count').join(', ') || 'none'}.`,
        confidence: 0.88,
        fact_refs: ['ticket_row_count', 'ticket_rows'],
        evidence_objects,
        missing_source_context: [],
        rule_id: 'ticket_support_confirmed',
        field_key: 'ticket_row_count',
        reconciliation_scope: 'single_document',
      }));
    }

    if (relatedInvoice && rowCount > 0) {
      const invLines = comparableLinesFromTyped(relatedInvoice.typed_fields as Record<string, unknown>);
      if (invLines.length > 0) {
        const invMap = new Map(invLines.map((r) => [r.code.toUpperCase(), r.quantity]));
        const rows = getArrayFact<TicketRowShape>(input.primaryDocument, 'ticket_rows');
        const mismatchCodes: string[] = [];
        const ticketEvidenceIds: string[] = [];
        for (const row of rows) {
          const code =
            typeof row.contract_line_item === 'string' ? row.contract_line_item.trim() : '';
          const qty =
            typeof row.quantity === 'number' && Number.isFinite(row.quantity)
              ? row.quantity
              : null;
          if (!code || qty == null) continue;
          const invQty = invMap.get(code.toUpperCase());
          if (invQty === undefined) continue;
          if (Math.abs(invQty - qty) > 0.02) {
            mismatchCodes.push(code);
            const qId = row.field_evidence_ids?.quantity;
            if (typeof qId === 'string') ticketEvidenceIds.push(qId);
            if (typeof row.evidence_ref === 'string') ticketEvidenceIds.push(row.evidence_ref);
          }
        }
        if (mismatchCodes.length > 0) {
          const uniqueCodes = [...new Set(mismatchCodes)];
          const decisionId = 'ticket:invoice_line_qty_mismatch';
          const evidence_objects = collectEvidenceByIds([...new Set(ticketEvidenceIds)], input.allEvidenceById);
          const invLineRefs = relatedInvoice.fact_map.line_item_count?.evidence_refs ?? [];
          const invLineEvidence = collectEvidenceByIds(invLineRefs.slice(0, 12), input.allEvidenceById);
          const bundle = [...evidence_objects, ...invLineEvidence].filter(
            (item, index, self) => self.findIndex((x) => x.id === item.id) === index,
          );
          decisions.push(makeDecision({
            id: decisionId,
            family: 'mismatch',
            severity: 'critical',
            title: 'Ticket vs invoice line quantity mismatch',
            detail: `Ticket export quantities differ from the linked invoice for: ${uniqueCodes.join(', ')}.`,
            confidence: bundle.length >= 2 ? 0.91 : 0.84,
            fact_refs: ['ticket_rows', 'line_items'],
            evidence_objects: bundle,
            extra_source_refs: [
              xrefPrimaryFact('line_items'),
              xrefRelatedDocumentFact(relatedInvoice.document_id, 'line_items'),
            ],
            missing_source_context: [
              ...(ticketEvidenceIds.length === 0 ? ['No ticket quantity cell ids were captured for mismatched rows.'] : []),
              ...(invLineRefs.length === 0 ? ['Invoice line_items have no table_row evidence_refs; comparison uses typed fields only.'] : []),
            ],
            rule_id: 'volume_cross_check',
            field_key: 'ticket_rows',
            observed_value: uniqueCodes.join(', '),
            expected_value: 'aligned quantities per line code',
            impact: 'reconcile ticket export rows to invoice line items before payment submission',
            reconciliation_scope: 'cross_document',
          }));
          actions.push(makeTask({
            id: 'task:ticket_invoice_lines',
            title: `Reconcile ticket lines vs invoice for ${uniqueCodes.join(', ')}`,
            priority: 'high',
            verb: 'match',
            entity_type: 'invoice',
            flow_type: 'validation',
            expected_outcome: 'Matching line codes show the same quantity on ticket export and invoice.',
            source_decision_ids: [decisionId],
          }));
        }
      }
    }

    return {
      decisions,
      actions,
      audit_notes,
    };
  },
};
