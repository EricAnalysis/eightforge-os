import {
  deriveBillingKeysForInvoiceLine,
  deriveInvoiceRateKey,
  indexRateScheduleItemsByCanonicalKeys,
  matchRateScheduleItemForInvoiceLine,
} from '@/lib/validator/billingKeys';
import {
  collectRowIdentityKeys,
  findFactRecords,
  isRuleEnabled,
  makeEvidenceInput,
  makeFinding,
  normalizeCode,
  partiesClearlyDifferent,
  readRowNumber,
  readRowString,
  rowIdentifier,
  structuredRowEvidenceInput,
  toNumber,
  type InvoiceLineRow,
  type InvoiceRow,
  type ProjectValidatorInput,
  type RateScheduleItem,
  type ValidatorFactRecord,
  type ValidatorFindingResult,
} from '@/lib/validator/shared';
import type {
  ContractInvoiceReconciliationStatus,
  ContractInvoiceReconciliationSummary,
} from '@/types/validator';

const CATEGORY = 'financial_integrity';

const CONTRACTOR_FACT_KEYS = ['contractor_name', 'vendor_name'] as const;
const CLIENT_FACT_KEYS = ['owner_name', 'client_name', 'customer_name'] as const;
const CONTRACT_TERM_START_FACT_KEYS = ['term_start_date', 'effective_date'] as const;
const CONTRACT_TERM_END_FACT_KEYS = ['term_end_date', 'expiration_date'] as const;

const INVOICE_IDENTITY_KEYS = [
  'id',
  'invoice_id',
  'source_document_id',
  'document_id',
  'invoice_number',
  'invoice_no',
  'number',
] as const;
const INVOICE_VENDOR_KEYS = [
  'vendor_name',
  'contractor_name',
  'vendor',
  'contractor',
  'payee_name',
] as const;
const INVOICE_CLIENT_KEYS = [
  'client_name',
  'owner_name',
  'customer_name',
  'bill_to_name',
  'bill_to',
  'recipient_name',
  'invoice_recipient',
  'applicant_name',
] as const;
const INVOICE_TOTAL_KEYS = [
  'total_amount',
  'invoice_total',
  'billed_amount',
  'current_amount_due',
  'amount_due',
  'subtotal',
  'net_amount',
  'currentPaymentDue',
  'total',
  'amount',
] as const;
const INVOICE_PERIOD_START_KEYS = [
  'period_start',
  'service_period_start',
  'service_start',
  'service_start_date',
  'work_start_date',
  'from_date',
  'start_date',
  'service_date',
  'work_date',
  'date_of_service',
] as const;
const INVOICE_PERIOD_END_KEYS = [
  'period_end',
  'service_period_end',
  'service_end',
  'service_end_date',
  'work_end_date',
  'to_date',
  'end_date',
  'service_date',
  'work_date',
  'date_of_service',
] as const;

const INVOICE_LINE_ID_KEYS = ['id', 'invoice_line_id', 'line_id'] as const;
const INVOICE_LINE_RATE_CODE_KEYS = [
  'rate_code',
  'contract_rate_code',
  'item_code',
  'service_code',
  'code',
  'line_code',
  'clin',
  'rate_item_code',
  'service_item_code',
  'line_item_code',
] as const;
const INVOICE_LINE_DESCRIPTION_KEYS = [
  'description',
  'rate_description',
  'item_description',
  'line_description',
  'service_item',
  'service_description',
  'name',
  'item',
  'rate_raw',
] as const;
const INVOICE_LINE_RATE_KEYS = [
  'billed_rate',
  'unit_rate',
  'rate',
  'price',
  'contract_rate',
  'unit_price',
  'bill_rate',
  'rate_amount',
  'amount_per_unit',
  'unit_cost',
  'uom_rate',
  'rate_raw',
] as const;
const INVOICE_LINE_MATERIAL_KEYS = ['material', 'material_type', 'debris_type'] as const;
const INVOICE_LINE_SERVICE_ITEM_KEYS = [
  'service_item',
  'service_item_code',
  'line_service_item',
] as const;
const INVOICE_LINE_TOTAL_KEYS = [
  'line_total',
  'extended_amount',
  'total_amount',
  'amount',
  'total',
  'extended_cost',
  'line_amount',
  'net_amount',
] as const;

type InvoiceMetadata = {
  key: string;
  subject_id: string;
  source_document_id: string | null;
  invoice_number: string | null;
  vendor_name: string | null;
  client_name: string | null;
  period_start: string | null;
  period_end: string | null;
  total_amount: number | null;
  row: InvoiceRow | null;
  line_items: CanonicalInvoiceLine[];
  vendor_facts: ValidatorFactRecord[];
  client_facts: ValidatorFactRecord[];
  period_start_facts: ValidatorFactRecord[];
  period_end_facts: ValidatorFactRecord[];
  total_facts: ValidatorFactRecord[];
};

type CanonicalInvoiceLine = {
  line_id: string;
  source_document_id: string | null;
  invoice_number: string | null;
  rate_code: string | null;
  description: string | null;
  service_item: string | null;
  material: string | null;
  unit_price: number | null;
  line_total: number | null;
  row: InvoiceLineRow;
  billing_rate_key: string | null;
  description_match_key: string | null;
  site_material_key: string | null;
  invoice_rate_key: string | null;
};

export type ContractInvoiceReconciliationResult = {
  findings: ValidatorFindingResult[];
  summary: ContractInvoiceReconciliationSummary;
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  );
}

function factStringValue(facts: readonly ValidatorFactRecord[]): string | null {
  for (const fact of facts) {
    if (typeof fact.value === 'string' && fact.value.trim().length > 0) {
      return fact.value.trim();
    }
  }

  return null;
}

function factNumberValue(facts: readonly ValidatorFactRecord[]): number | null {
  for (const fact of facts) {
    const value = toNumber(fact.value);
    if (value != null) return value;
  }

  return null;
}

function evidenceFromFacts(
  facts: readonly ValidatorFactRecord[],
  limit = 12,
) {
  return facts
    .flatMap((fact) => fact.evidence.map((evidence) => makeEvidenceInput(evidence)))
    .slice(0, limit);
}

function parseDateValue(value: string | null | undefined): number | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(`${trimmed}T00:00:00Z`);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const slashMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    const rawYear = Number(slashMatch[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const parsed = Date.UTC(year, month - 1, day);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function overlapsDateRange(params: {
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
}): boolean {
  return params.leftStart <= params.rightEnd && params.leftEnd >= params.rightStart;
}

function reduceStatus(
  statuses: ContractInvoiceReconciliationStatus[],
): ContractInvoiceReconciliationStatus {
  if (statuses.length === 0) return 'MISSING';
  if (statuses.includes('MISMATCH')) return 'MISMATCH';
  if (statuses.every((status) => status === 'MISSING')) return 'MISSING';
  if (statuses.includes('MISSING')) return 'PARTIAL';
  return 'MATCH';
}

function rowFactIdentifiers(row: InvoiceRow): string[] {
  return collectRowIdentityKeys(row, INVOICE_IDENTITY_KEYS);
}

function createInvoiceMetadata(params: {
  key: string;
  subjectId: string;
  sourceDocumentId?: string | null;
  invoiceNumber?: string | null;
}): InvoiceMetadata {
  return {
    key: params.key,
    subject_id: params.subjectId,
    source_document_id: params.sourceDocumentId ?? null,
    invoice_number: params.invoiceNumber ?? null,
    vendor_name: null,
    client_name: null,
    period_start: null,
    period_end: null,
    total_amount: null,
    row: null,
    line_items: [],
    vendor_facts: [],
    client_facts: [],
    period_start_facts: [],
    period_end_facts: [],
    total_facts: [],
  };
}

function pickInvoiceMetadata(
  line: InvoiceLineRow,
  indexes: {
    byDocumentId: Map<string, InvoiceMetadata>;
    byInvoiceRowId: Map<string, InvoiceMetadata>;
    byInvoiceNumber: Map<string, InvoiceMetadata>;
    byKey: Map<string, InvoiceMetadata>;
  },
): InvoiceMetadata {
  const sourceDocumentId = readRowString(line, ['source_document_id', 'document_id']);
  if (sourceDocumentId && indexes.byDocumentId.has(sourceDocumentId)) {
    return indexes.byDocumentId.get(sourceDocumentId)!;
  }

  const invoiceRowId = readRowString(line, ['invoice_id', 'source_invoice_id']);
  if (invoiceRowId && indexes.byInvoiceRowId.has(invoiceRowId)) {
    return indexes.byInvoiceRowId.get(invoiceRowId)!;
  }

  const invoiceNumber = normalizeCode(
    readRowString(line, ['invoice_number', 'invoice_no']),
  );
  if (invoiceNumber && indexes.byInvoiceNumber.has(invoiceNumber)) {
    return indexes.byInvoiceNumber.get(invoiceNumber)!;
  }

  const lineId = rowIdentifier(line, INVOICE_LINE_ID_KEYS, 'invoice_line');
  const key = sourceDocumentId
    ? `document:${sourceDocumentId}`
    : invoiceNumber
      ? `invoice:${invoiceNumber}`
      : `orphan:${lineId}`;
  const subjectId = readRowString(line, ['invoice_number', 'invoice_no'])
    ?? sourceDocumentId
    ?? lineId;
  const metadata = createInvoiceMetadata({
    key,
    subjectId,
    sourceDocumentId,
    invoiceNumber: readRowString(line, ['invoice_number', 'invoice_no']),
  });
  indexes.byKey.set(key, metadata);
  if (sourceDocumentId) indexes.byDocumentId.set(sourceDocumentId, metadata);
  if (invoiceNumber) indexes.byInvoiceNumber.set(invoiceNumber, metadata);
  return metadata;
}

function buildInvoiceMetadata(input: ProjectValidatorInput): InvoiceMetadata[] {
  const byKey = new Map<string, InvoiceMetadata>();
  const byDocumentId = new Map<string, InvoiceMetadata>();
  const byInvoiceNumber = new Map<string, InvoiceMetadata>();
  const byInvoiceRowId = new Map<string, InvoiceMetadata>();
  const invoiceDocumentIds = Array.from(
    new Set([
      ...input.governingDocumentIds.invoice,
      ...input.familyDocumentIds.invoice,
    ]),
  );

  for (const documentId of invoiceDocumentIds) {
    const invoiceNumberFacts = findFactRecords(
      input.factsByDocumentId,
      [documentId],
      ['invoice_number'],
    );
    const vendorFacts = findFactRecords(
      input.factsByDocumentId,
      [documentId],
      CONTRACTOR_FACT_KEYS,
    );
    const clientFacts = findFactRecords(
      input.factsByDocumentId,
      [documentId],
      INVOICE_CLIENT_KEYS,
    );
    const periodStartFacts = findFactRecords(
      input.factsByDocumentId,
      [documentId],
      INVOICE_PERIOD_START_KEYS,
    );
    const periodEndFacts = findFactRecords(
      input.factsByDocumentId,
      [documentId],
      INVOICE_PERIOD_END_KEYS,
    );
    const totalFacts = findFactRecords(
      input.factsByDocumentId,
      [documentId],
      INVOICE_TOTAL_KEYS,
    );
    const invoiceNumber = factStringValue(invoiceNumberFacts);
    const metadata = createInvoiceMetadata({
      key: `document:${documentId}`,
      subjectId: invoiceNumber ?? documentId,
      sourceDocumentId: documentId,
      invoiceNumber,
    });

    metadata.vendor_name = factStringValue(vendorFacts);
    metadata.client_name = factStringValue(clientFacts);
    metadata.period_start = factStringValue(periodStartFacts);
    metadata.period_end = factStringValue(periodEndFacts);
    metadata.total_amount = factNumberValue(totalFacts);
    metadata.vendor_facts = vendorFacts;
    metadata.client_facts = clientFacts;
    metadata.period_start_facts = periodStartFacts;
    metadata.period_end_facts = periodEndFacts;
    metadata.total_facts = totalFacts;

    byKey.set(metadata.key, metadata);
    byDocumentId.set(documentId, metadata);

    const normalizedInvoiceNumber = normalizeCode(invoiceNumber);
    if (normalizedInvoiceNumber) {
      byInvoiceNumber.set(normalizedInvoiceNumber, metadata);
    }
  }

  for (const row of input.invoices) {
    const sourceDocumentId = readRowString(row, ['source_document_id', 'document_id']);
    const invoiceNumber = readRowString(row, ['invoice_number', 'invoice_no', 'number']);
    const normalizedInvoiceNumber = normalizeCode(invoiceNumber);
    const invoiceRowId = readRowString(row, ['id', 'invoice_id']);

    let metadata =
      (sourceDocumentId ? byDocumentId.get(sourceDocumentId) ?? null : null)
      ?? (normalizedInvoiceNumber ? byInvoiceNumber.get(normalizedInvoiceNumber) ?? null : null);

    if (!metadata) {
      metadata = createInvoiceMetadata({
        key: sourceDocumentId
          ? `document:${sourceDocumentId}`
          : normalizedInvoiceNumber
            ? `invoice:${normalizedInvoiceNumber}`
            : `row:${invoiceRowId ?? byKey.size + 1}`,
        subjectId: invoiceNumber ?? sourceDocumentId ?? invoiceRowId ?? `invoice:${byKey.size + 1}`,
        sourceDocumentId,
        invoiceNumber,
      });
      byKey.set(metadata.key, metadata);
      if (sourceDocumentId) byDocumentId.set(sourceDocumentId, metadata);
      if (normalizedInvoiceNumber) byInvoiceNumber.set(normalizedInvoiceNumber, metadata);
    }

    metadata.row = row;
    metadata.subject_id = invoiceNumber ?? metadata.subject_id;
    metadata.source_document_id = sourceDocumentId ?? metadata.source_document_id;
    metadata.invoice_number = invoiceNumber ?? metadata.invoice_number;
    metadata.vendor_name = readRowString(row, INVOICE_VENDOR_KEYS) ?? metadata.vendor_name;
    metadata.client_name = readRowString(row, INVOICE_CLIENT_KEYS) ?? metadata.client_name;
    metadata.period_start =
      readRowString(row, INVOICE_PERIOD_START_KEYS) ?? metadata.period_start;
    metadata.period_end =
      readRowString(row, INVOICE_PERIOD_END_KEYS) ?? metadata.period_end;
    metadata.total_amount =
      readRowNumber(row, INVOICE_TOTAL_KEYS) ?? metadata.total_amount;

    const rowIdentifiers = rowFactIdentifiers(row);
    for (const identifier of rowIdentifiers) {
      byInvoiceRowId.set(identifier, metadata);
    }
    if (sourceDocumentId) byDocumentId.set(sourceDocumentId, metadata);
    if (normalizedInvoiceNumber) byInvoiceNumber.set(normalizedInvoiceNumber, metadata);
  }

  const indexes = {
    byDocumentId,
    byInvoiceRowId,
    byInvoiceNumber,
    byKey,
  };

  for (const row of input.invoiceLines) {
    const metadata = pickInvoiceMetadata(row, indexes);
    const rateCodeRaw = readRowString(row, INVOICE_LINE_RATE_CODE_KEYS);
    const descriptionRaw = readRowString(row, INVOICE_LINE_DESCRIPTION_KEYS);
    const serviceItemRaw = readRowString(row, INVOICE_LINE_SERVICE_ITEM_KEYS);
    const materialRaw = readRowString(row, INVOICE_LINE_MATERIAL_KEYS);
    const keys = deriveBillingKeysForInvoiceLine({
      rate_code: rateCodeRaw,
      description: descriptionRaw,
      service_item: serviceItemRaw,
      material: materialRaw,
    });
    const invoiceNoForKey =
      readRowString(row, ['invoice_number', 'invoice_no']) ?? metadata.invoice_number;

    metadata.line_items.push({
      line_id: rowIdentifier(row, INVOICE_LINE_ID_KEYS, 'invoice_line'),
      source_document_id:
        readRowString(row, ['source_document_id', 'document_id'])
        ?? metadata.source_document_id,
      invoice_number:
        readRowString(row, ['invoice_number', 'invoice_no'])
        ?? metadata.invoice_number,
      rate_code: rateCodeRaw,
      description: descriptionRaw,
      service_item: serviceItemRaw,
      material: materialRaw,
      unit_price: readRowNumber(row, INVOICE_LINE_RATE_KEYS),
      line_total: readRowNumber(row, INVOICE_LINE_TOTAL_KEYS),
      row,
      billing_rate_key: keys.billing_rate_key,
      description_match_key: keys.description_match_key,
      site_material_key: keys.site_material_key,
      invoice_rate_key: deriveInvoiceRateKey(invoiceNoForKey, keys.billing_rate_key),
    });
  }

  return [...byKey.values()];
}

function contractRateEvidence(
  item: RateScheduleItem | null,
  input: ProjectValidatorInput,
) {
  if (item) {
    const rawValue =
      item.raw_value != null
      && typeof item.raw_value === 'object'
      && !Array.isArray(item.raw_value)
        ? item.raw_value as Record<string, unknown>
        : null;

    return [
      makeEvidenceInput({
        evidence_type: 'rate_schedule',
        source_document_id: item.source_document_id,
        source_page:
          typeof rawValue?.source_page === 'number'
            ? rawValue.source_page
            : typeof rawValue?.page === 'number'
              ? rawValue.page
              : null,
        record_id: item.record_id,
        field_name: 'rate_amount',
        field_value: item.rate_amount,
        note: 'Matched governing contract schedule line.',
      }),
    ];
  }

  return input.factLookups.rateScheduleFacts
    .slice(0, 3)
    .map((fact) => makeEvidenceInput({
      evidence_type: 'rate_schedule',
      source_document_id: fact.document_id,
      fact_id: fact.id,
      record_id: fact.id,
      field_name: fact.key,
      field_value: fact.value,
      note: 'Extracted governing contract schedule fact used for invoice reconciliation.',
    }));
}

export function evaluateContractInvoiceReconciliation(
  input: ProjectValidatorInput,
): ContractInvoiceReconciliationResult {
  const findings: ValidatorFindingResult[] = [];
  const invoices = buildInvoiceMetadata(input);
  const scheduleIndex = indexRateScheduleItemsByCanonicalKeys(
    input.factLookups.rateScheduleItems,
  );

  const contractDocumentIds = uniqueStrings([
    ...input.governingDocumentIds.contract,
    ...input.familyDocumentIds.contract,
  ]);
  const contractVendorFacts = findFactRecords(
    input.factsByDocumentId,
    contractDocumentIds,
    CONTRACTOR_FACT_KEYS,
  );
  const contractClientFacts = findFactRecords(
    input.factsByDocumentId,
    contractDocumentIds,
    CLIENT_FACT_KEYS,
  );
  const contractTermStartFacts = findFactRecords(
    input.factsByDocumentId,
    contractDocumentIds,
    CONTRACT_TERM_START_FACT_KEYS,
  );
  const contractTermEndFacts = findFactRecords(
    input.factsByDocumentId,
    contractDocumentIds,
    CONTRACT_TERM_END_FACT_KEYS,
  );

  const contractVendor =
    factStringValue(contractVendorFacts)
    ?? (
      typeof input.contractValidationContext?.analysis.contract_identity.contractor_name?.value === 'string'
        ? input.contractValidationContext.analysis.contract_identity.contractor_name.value
        : null
    );
  const contractClient =
    factStringValue(contractClientFacts)
    ?? (
      typeof input.contractValidationContext?.analysis.contract_identity.owner_name?.value === 'string'
        ? input.contractValidationContext.analysis.contract_identity.owner_name.value
        : null
    );
  const contractStartRaw =
    factStringValue(contractTermStartFacts)
    ?? (
      typeof input.contractValidationContext?.analysis.contract_identity.effective_date?.value === 'string'
        ? input.contractValidationContext.analysis.contract_identity.effective_date.value
        : null
    );
  const contractEndRaw =
    factStringValue(contractTermEndFacts)
    ?? (
      typeof input.contractValidationContext?.analysis.term_model.expiration_date?.value === 'string'
        ? input.contractValidationContext.analysis.term_model.expiration_date.value
        : null
    );
  const contractStart = parseDateValue(contractStartRaw);
  const contractEnd = parseDateValue(contractEndRaw);

  let matchedInvoiceLines = 0;
  let unmatchedInvoiceLines = 0;
  let rateMismatches = 0;
  const vendorStatuses: ContractInvoiceReconciliationStatus[] = [];
  const clientStatuses: ContractInvoiceReconciliationStatus[] = [];
  const serviceStatuses: ContractInvoiceReconciliationStatus[] = [];
  const totalStatuses: ContractInvoiceReconciliationStatus[] = [];

  for (const invoice of invoices) {
    if (!contractVendor || !invoice.vendor_name) {
      vendorStatuses.push('MISSING');
    } else if (partiesClearlyDifferent(invoice.vendor_name, contractVendor)) {
      vendorStatuses.push('MISMATCH');
      if (
        isRuleEnabled(
          input.ruleStateByRuleId,
          'FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR',
        )
      ) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR',
            category: CATEGORY,
            severity: 'critical',
            subjectType: 'invoice',
            subjectId: invoice.subject_id,
            field: 'vendor_name',
            expected: contractVendor,
            actual: invoice.vendor_name,
            evidence: [
              ...(invoice.row
                ? [
                  structuredRowEvidenceInput({
                    evidenceType: 'invoice',
                    row: invoice.row,
                    fieldName: 'vendor_name',
                    fieldValue: invoice.vendor_name,
                    note: 'Invoice vendor extracted for contractor identity comparison.',
                  }),
                ]
                : evidenceFromFacts(invoice.vendor_facts)),
              ...evidenceFromFacts(contractVendorFacts),
            ],
          }),
        );
      }
    } else {
      vendorStatuses.push('MATCH');
    }

    if (!contractClient || !invoice.client_name) {
      clientStatuses.push('MISSING');
      if (
        !invoice.client_name &&
        isRuleEnabled(
          input.ruleStateByRuleId,
          'FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON',
        )
      ) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON',
            category: CATEGORY,
            severity: 'warning',
            subjectType: 'invoice',
            subjectId: invoice.subject_id,
            field: 'client_name',
            expected: contractClient ?? 'extractable invoice client',
            actual: 'missing',
            evidence: [
              ...(invoice.row
                ? [
                  structuredRowEvidenceInput({
                    evidenceType: 'invoice',
                    row: invoice.row,
                    fieldName: 'client_name',
                    fieldValue: null,
                    note: 'Invoice client could not be extracted for governing contract comparison.',
                  }),
                ]
                : []),
              ...evidenceFromFacts(contractClientFacts),
            ],
          }),
        );
      }
    } else if (partiesClearlyDifferent(invoice.client_name, contractClient)) {
      clientStatuses.push('MISMATCH');
      if (
        isRuleEnabled(
          input.ruleStateByRuleId,
          'FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT',
        )
      ) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT',
            category: CATEGORY,
            severity: 'critical',
            subjectType: 'invoice',
            subjectId: invoice.subject_id,
            field: 'client_name',
            expected: contractClient,
            actual: invoice.client_name,
            evidence: [
              ...(invoice.row
                ? [
                  structuredRowEvidenceInput({
                    evidenceType: 'invoice',
                    row: invoice.row,
                    fieldName: 'client_name',
                    fieldValue: invoice.client_name,
                    note: 'Invoice client extracted for governing contract comparison.',
                  }),
                ]
                : evidenceFromFacts(invoice.client_facts)),
              ...evidenceFromFacts(contractClientFacts),
            ],
          }),
        );
      }
    } else {
      clientStatuses.push('MATCH');
    }

    const invoicePeriodStart = parseDateValue(invoice.period_start);
    const invoicePeriodEnd = parseDateValue(invoice.period_end);
    if (
      contractStart == null
      || contractEnd == null
      || invoicePeriodStart == null
      || invoicePeriodEnd == null
    ) {
      serviceStatuses.push('MISSING');
      if (
        (invoicePeriodStart == null || invoicePeriodEnd == null) &&
        isRuleEnabled(
          input.ruleStateByRuleId,
          'FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING',
        )
      ) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING',
            category: CATEGORY,
            severity: 'warning',
            subjectType: 'invoice',
            subjectId: invoice.subject_id,
            field: 'service_period',
            expected: 'extractable invoice service period',
            actual: 'missing',
            evidence: [
              ...(invoice.row
                ? [
                  structuredRowEvidenceInput({
                    evidenceType: 'invoice',
                    row: invoice.row,
                    fieldName: 'service_period',
                    fieldValue:
                      invoice.period_start && invoice.period_end
                        ? `${invoice.period_start} - ${invoice.period_end}`
                        : null,
                    note: 'Invoice service period could not be fully extracted for contract term comparison.',
                  }),
                ]
                : [
                  ...evidenceFromFacts(invoice.period_start_facts, 6),
                  ...evidenceFromFacts(invoice.period_end_facts, 6),
                ]),
              ...evidenceFromFacts(contractTermStartFacts, 6),
              ...evidenceFromFacts(contractTermEndFacts, 6),
            ],
          }),
        );
      }
    } else if (
      !overlapsDateRange({
        leftStart: invoicePeriodStart,
        leftEnd: invoicePeriodEnd,
        rightStart: contractStart,
        rightEnd: contractEnd,
      })
    ) {
      serviceStatuses.push('MISMATCH');
      if (
        isRuleEnabled(
          input.ruleStateByRuleId,
          'FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM',
        )
      ) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM',
            category: CATEGORY,
            severity: 'critical',
            subjectType: 'invoice',
            subjectId: invoice.subject_id,
            field: 'service_period',
            expected: `${contractStartRaw ?? ''} - ${contractEndRaw ?? ''}`.trim(),
            actual: `${invoice.period_start ?? ''} - ${invoice.period_end ?? ''}`.trim(),
            evidence: [
              ...(invoice.row
                ? [
                  structuredRowEvidenceInput({
                    evidenceType: 'invoice',
                    row: invoice.row,
                    fieldName: 'service_period',
                    fieldValue: `${invoice.period_start ?? ''} - ${invoice.period_end ?? ''}`.trim(),
                    note: 'Invoice service period falls outside the governing contract term.',
                  }),
                ]
                : [
                  ...evidenceFromFacts(invoice.period_start_facts, 6),
                  ...evidenceFromFacts(invoice.period_end_facts, 6),
                ]),
              ...evidenceFromFacts(contractTermStartFacts, 6),
              ...evidenceFromFacts(contractTermEndFacts, 6),
            ],
          }),
        );
      }
    } else {
      serviceStatuses.push('MATCH');
    }

    if (invoice.line_items.length === 0) {
      totalStatuses.push('MISSING');
    } else {
      const lineTotalValues = invoice.line_items
        .map((line) => line.line_total)
        .filter((value): value is number => value != null);
      if (lineTotalValues.length === 0 || invoice.total_amount == null) {
        totalStatuses.push('MISSING');
      } else {
        const lineTotalSum = lineTotalValues.reduce((sum, value) => sum + value, 0);
        if (Math.abs(lineTotalSum - invoice.total_amount) > 0.01) {
          totalStatuses.push('MISMATCH');
          if (
            isRuleEnabled(
              input.ruleStateByRuleId,
              'FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS',
            )
          ) {
            findings.push(
              makeFinding({
                projectId: input.project.id,
                ruleId: 'FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS',
                category: CATEGORY,
                severity: 'critical',
                subjectType: 'invoice',
                subjectId: invoice.subject_id,
                field: 'total_amount',
                expected: invoice.total_amount,
                actual: lineTotalSum,
                variance: Math.abs(lineTotalSum - invoice.total_amount),
                varianceUnit: 'USD',
                evidence: [
                  ...invoice.line_items.slice(0, 12).map((line) => (
                    structuredRowEvidenceInput({
                      evidenceType: 'invoice_line',
                      row: line.row,
                      fieldName: 'line_total',
                      fieldValue: line.line_total,
                      note: 'Invoice line total used in billed total reconciliation.',
                    })
                  )),
                  ...(invoice.row
                    ? [
                      structuredRowEvidenceInput({
                        evidenceType: 'invoice',
                        row: invoice.row,
                        fieldName: 'total_amount',
                        fieldValue: invoice.total_amount,
                        note: 'Invoice total compared against billed line item math.',
                      }),
                    ]
                    : evidenceFromFacts(invoice.total_facts)),
                ],
              }),
            );
          }
        } else {
          totalStatuses.push('MATCH');
        }
      }
    }

    for (const line of invoice.line_items) {
      const { candidates: scheduleCandidates, match: scheduleItem } =
        matchRateScheduleItemForInvoiceLine(line, scheduleIndex);

      if (scheduleCandidates.length > 0) {
        matchedInvoiceLines += 1;
      } else {
        unmatchedInvoiceLines += 1;
      }

      if (
        normalizeCode(line.rate_code) &&
        scheduleCandidates.length === 0 &&
        isRuleEnabled(
          input.ruleStateByRuleId,
          'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
        )
      ) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
            category: CATEGORY,
            severity: 'critical',
            subjectType: 'invoice_line',
            subjectId: line.line_id,
            field: 'rate_code',
            expected: 'governing contract schedule code',
            actual: line.rate_code,
            evidence: [
              structuredRowEvidenceInput({
                evidenceType: 'invoice_line',
                row: line.row,
                fieldName: 'invoice_number',
                fieldValue: line.invoice_number,
                note: 'Invoice number linked to the unmatched contract rate code.',
              }),
              structuredRowEvidenceInput({
                evidenceType: 'invoice_line',
                row: line.row,
                fieldName: 'rate_code',
                fieldValue: line.rate_code,
                note: 'Invoice line code was compared against the governing contract schedule codes.',
              }),
              ...contractRateEvidence(null, input),
            ],
          }),
        );
      }

      if (
        scheduleItem &&
        line.unit_price != null &&
        scheduleItem.rate_amount != null &&
        Math.abs(line.unit_price - scheduleItem.rate_amount) > 0.01
      ) {
        rateMismatches += 1;
        if (
          isRuleEnabled(
            input.ruleStateByRuleId,
            'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE',
          )
        ) {
          findings.push(
            makeFinding({
              projectId: input.project.id,
              ruleId: 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE',
              category: CATEGORY,
              severity: 'critical',
              subjectType: 'invoice_line',
              subjectId: line.line_id,
              field: 'unit_price',
              expected: scheduleItem.rate_amount,
              actual: line.unit_price,
              variance: Math.abs(line.unit_price - scheduleItem.rate_amount),
              varianceUnit: 'USD',
              evidence: [
                structuredRowEvidenceInput({
                  evidenceType: 'invoice_line',
                  row: line.row,
                  fieldName: 'invoice_number',
                  fieldValue: line.invoice_number,
                  note: 'Invoice number linked to the billed rate mismatch.',
                }),
                structuredRowEvidenceInput({
                  evidenceType: 'invoice_line',
                  row: line.row,
                  fieldName: 'rate_code',
                  fieldValue: line.rate_code,
                  note: 'Invoice rate code compared against the governing contract schedule.',
                }),
                structuredRowEvidenceInput({
                  evidenceType: 'invoice_line',
                  row: line.row,
                  fieldName: 'unit_price',
                  fieldValue: line.unit_price,
                  note: 'Invoice unit price compared against the governing contract schedule rate.',
                }),
                ...contractRateEvidence(scheduleItem, input),
              ],
            }),
          );
        }
      }
    }
  }

  return {
    findings,
    summary: {
      matched_invoice_lines: matchedInvoiceLines,
      unmatched_invoice_lines: unmatchedInvoiceLines,
      rate_mismatches: rateMismatches,
      vendor_identity_status: reduceStatus(vendorStatuses),
      client_identity_status: reduceStatus(clientStatuses),
      service_period_status: reduceStatus(serviceStatuses),
      invoice_total_status: reduceStatus(totalStatuses),
    },
  };
}
