export type TransactionDataPrimitive = string | number | boolean | null;

export type TransactionDataFieldType =
  | 'string'
  | 'date'
  | 'number'
  | 'currency'
  | 'integer'
  | 'json';

export type TransactionDataFieldKey =
  | 'transaction_number'
  | 'invoice_number'
  | 'invoice_date'
  | 'rate_code'
  | 'rate_description'
  | 'transaction_quantity'
  | 'transaction_rate'
  | 'extended_cost'
  | 'net_quantity'
  | 'mileage'
  | 'cyd'
  | 'net_tonnage'
  | 'material'
  | 'service_item'
  | 'ticket_notes'
  | 'eligibility'
  | 'eligibility_internal_comments'
  | 'eligibility_external_comments'
  | 'load_latitude'
  | 'load_longitude'
  | 'disposal_latitude'
  | 'disposal_longitude'
  | 'project_name';

export type TransactionDataDerivedRowFieldKey =
  | 'billing_rate_key'
  | 'description_match_key'
  | 'site_material_key'
  | 'invoice_rate_key';

export type TransactionDataRequiredRowFieldKey =
  | 'source_sheet_name'
  | 'source_row_number'
  | 'raw_row';

export type TransactionDataSummaryFieldKey =
  | 'row_count'
  | 'distinct_invoice_numbers'
  | 'distinct_rate_codes'
  | 'distinct_service_items'
  | 'distinct_materials'
  | 'total_extended_cost'
  | 'total_transaction_quantity'
  | 'total_tickets'
  | 'total_cyd'
  | 'invoiced_ticket_count'
  | 'distinct_invoice_count'
  | 'total_invoiced_amount'
  | 'uninvoiced_line_count'
  | 'eligible_count'
  | 'ineligible_count'
  | 'unknown_eligibility_count'
  | 'rows_with_missing_rate_code'
  | 'rows_with_missing_invoice_number'
  | 'rows_with_missing_quantity'
  | 'rows_with_missing_extended_cost'
  | 'rows_with_zero_cost'
  | 'rows_with_extreme_unit_rate'
  | 'project_operations_overview'
  | 'invoice_readiness_summary'
  | 'grouped_by_rate_code'
  | 'grouped_by_invoice'
  | 'grouped_by_site_material'
  | 'grouped_by_service_item'
  | 'grouped_by_material'
  | 'grouped_by_site_type'
  | 'grouped_by_disposal_site'
  | 'outlier_rows'
  | 'dms_fds_lifecycle_summary'
  | 'boundary_location_review'
  | 'distance_from_feature_review'
  | 'debris_class_at_disposal_site_review'
  | 'mileage_review'
  | 'load_call_review'
  | 'linked_mobile_load_consistency_review'
  | 'truck_trip_time_review'
  | 'detected_header_map'
  | 'detected_sheet_names'
  | 'inferred_date_range_start'
  | 'inferred_date_range_end';

export interface TransactionDataSchemaFieldDefinition {
  type: TransactionDataFieldType;
  required: boolean;
  nullable: boolean;
}

export interface TransactionDataHeaderMatch {
  canonical_field: TransactionDataFieldKey;
  sheet_key: string;
  sheet_name: string;
  column_name: string;
  column_index: number;
  header_row_number: number;
}

export interface TransactionDataDateRange {
  start: string;
  end: string;
}

export type TransactionDataReviewStatus =
  | 'ok'
  | 'review'
  | 'warning'
  | 'ready'
  | 'partial'
  | 'needs_review'
  | 'unavailable';

export interface TransactionDataReviewGroupBase {
  row_count: number;
  total_transaction_quantity: number;
  total_cyd: number;
  total_extended_cost: number;
  invoiced_ticket_count: number;
  uninvoiced_line_count: number;
  distinct_invoice_numbers: string[];
  distinct_rate_codes: string[];
  record_ids: string[];
  evidence_refs: string[];
}

export interface TransactionDataServiceItemGroup extends TransactionDataReviewGroupBase {
  service_item: string | null;
}

export interface TransactionDataMaterialGroup extends TransactionDataReviewGroupBase {
  material: string | null;
  disposal_sites: string[];
  site_types: string[];
}

export interface TransactionDataSiteTypeGroup extends TransactionDataReviewGroupBase {
  site_type: string | null;
  disposal_sites: string[];
  materials: string[];
}

export interface TransactionDataDisposalSiteGroup extends TransactionDataReviewGroupBase {
  disposal_site: string | null;
  site_types: string[];
  materials: string[];
}

export interface TransactionDataOutlierRow {
  record_id: string;
  transaction_number: string | null;
  invoice_number: string | null;
  billing_rate_key: string | null;
  description_match_key: string | null;
  source_sheet_name: string;
  source_row_number: number;
  severity: 'warning' | 'critical';
  reasons: string[];
  metrics: {
    transaction_quantity: number | null;
    transaction_rate: number | null;
    extended_cost: number | null;
    mileage: number | null;
    cyd: number | null;
    net_tonnage: number | null;
  };
  evidence_refs: string[];
}

export interface TransactionDataProjectOperationsOverview {
  project_name: string | null;
  total_tickets: number;
  total_transaction_quantity: number;
  total_cyd: number;
  total_invoiced_amount: number;
  distinct_invoice_count: number;
  invoiced_ticket_count: number;
  uninvoiced_line_count: number;
  eligible_count: number;
  ineligible_count: number;
  unknown_eligibility_count: number;
  distinct_service_item_count: number;
  distinct_material_count: number;
  distinct_site_type_count: number;
  distinct_disposal_site_count: number;
  reviewed_sheet_names: string[];
  record_ids: string[];
  evidence_refs: string[];
}

export interface TransactionDataInvoiceReadinessSummary {
  status: 'ready' | 'partial' | 'needs_review';
  total_tickets: number;
  invoiced_ticket_count: number;
  distinct_invoice_count: number;
  total_invoiced_amount: number;
  uninvoiced_line_count: number;
  rows_with_missing_rate_code: number;
  rows_with_missing_quantity: number;
  rows_with_missing_extended_cost: number;
  rows_with_zero_cost: number;
  rows_with_extreme_unit_rate: number;
  outlier_row_count: number;
  blocking_reasons: string[];
  record_ids: string[];
  evidence_refs: string[];
}

export type TransactionDataLifecycleStage =
  | 'DMS'
  | 'FDS'
  | 'Landfill'
  | 'Recycling'
  | 'Other'
  | 'Unknown';

export interface TransactionDataLifecycleGroup {
  lifecycle_stage: TransactionDataLifecycleStage;
  row_count: number;
  total_cyd: number;
  total_extended_cost: number;
  disposal_sites: string[];
  materials: string[];
  record_ids: string[];
  evidence_refs: string[];
}

export interface TransactionDataDmsFdsLifecycleSummary {
  lifecycle_groups: TransactionDataLifecycleGroup[];
  dms_row_count: number;
  fds_row_count: number;
  other_row_count: number;
  unknown_row_count: number;
  mixed_material_flow_count: number;
  record_ids: string[];
  evidence_refs: string[];
}

export interface TransactionDataOpsReviewBucket {
  review_key:
    | 'boundary_location_review'
    | 'distance_from_feature_review'
    | 'debris_class_at_disposal_site_review'
    | 'mileage_review'
    | 'load_call_review'
    | 'linked_mobile_load_consistency_review'
    | 'truck_trip_time_review';
  label: string;
  available: boolean;
  status: TransactionDataReviewStatus;
  reviewed_row_count: number;
  flagged_row_count: number;
  supporting_columns: string[];
  summary: string;
  flagged_record_ids: string[];
  flagged_evidence_refs: string[];
}

/** Rollup by canonical billing key (see `billing_rate_key` on rows). */
export interface TransactionDataRateCodeGroup {
  billing_rate_key: string | null;
  /** Normalized rate code sample for the group (lexicographically smallest non-empty among rows). */
  rate_code: string | null;
  /** Deterministic sample description from member rows (lexicographically smallest non-null). */
  rate_description_sample: string | null;
  row_count: number;
  total_transaction_quantity: number;
  total_extended_cost: number;
  distinct_invoice_numbers: string[];
  distinct_materials: string[];
  distinct_service_items: string[];
}

export interface TransactionDataInvoiceGroup {
  invoice_number: string | null;
  row_count: number;
  total_transaction_quantity: number;
  total_extended_cost: number;
  distinct_rate_codes: string[];
  distinct_materials: string[];
  distinct_service_items: string[];
}

export interface TransactionDataSiteMaterialGroup {
  site_material_key: string | null;
  /** Raw disposal-site column text (deterministic sample from member rows). */
  disposal_site: string | null;
  /** Raw site-type column text (deterministic sample from member rows). */
  disposal_site_type: string | null;
  /** Material column / alias text (deterministic sample from member rows). */
  material: string | null;
  row_count: number;
  total_transaction_quantity: number;
  total_extended_cost: number;
  distinct_rate_codes: string[];
  distinct_invoice_numbers: string[];
}

export interface TransactionDataRecord {
  transaction_number: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  rate_code: string | null;
  rate_description: string | null;
  transaction_quantity: number | null;
  transaction_rate: number | null;
  extended_cost: number | null;
  net_quantity: number | null;
  mileage: number | null;
  cyd: number | null;
  net_tonnage: number | null;
  material: string | null;
  service_item: string | null;
  ticket_notes: string | null;
  eligibility: string | null;
  eligibility_internal_comments: string | null;
  eligibility_external_comments: string | null;
  load_latitude: number | null;
  load_longitude: number | null;
  disposal_latitude: number | null;
  disposal_longitude: number | null;
  project_name: string | null;
  billing_rate_key: string | null;
  description_match_key: string | null;
  site_material_key: string | null;
  invoice_rate_key: string | null;
  source_sheet_name: string;
  source_row_number: number;
  raw_row: Record<string, TransactionDataPrimitive>;
}

export interface TransactionDataDatasetSummary {
  row_count: number;
  distinct_invoice_numbers: string[];
  distinct_rate_codes: string[];
  distinct_service_items: string[];
  distinct_materials: string[];
  total_extended_cost: number;
  total_transaction_quantity: number;
  total_tickets: number;
  total_cyd: number;
  invoiced_ticket_count: number;
  distinct_invoice_count: number;
  total_invoiced_amount: number;
  uninvoiced_line_count: number;
  eligible_count: number;
  ineligible_count: number;
  unknown_eligibility_count: number;
  rows_with_missing_rate_code: number;
  rows_with_missing_invoice_number: number;
  rows_with_missing_quantity: number;
  rows_with_missing_extended_cost: number;
  rows_with_zero_cost: number;
  rows_with_extreme_unit_rate: number;
  project_operations_overview: TransactionDataProjectOperationsOverview;
  invoice_readiness_summary: TransactionDataInvoiceReadinessSummary;
  grouped_by_rate_code: TransactionDataRateCodeGroup[];
  grouped_by_invoice: TransactionDataInvoiceGroup[];
  grouped_by_site_material: TransactionDataSiteMaterialGroup[];
  grouped_by_service_item: TransactionDataServiceItemGroup[];
  grouped_by_material: TransactionDataMaterialGroup[];
  grouped_by_site_type: TransactionDataSiteTypeGroup[];
  grouped_by_disposal_site: TransactionDataDisposalSiteGroup[];
  outlier_rows: TransactionDataOutlierRow[];
  dms_fds_lifecycle_summary: TransactionDataDmsFdsLifecycleSummary;
  boundary_location_review: TransactionDataOpsReviewBucket;
  distance_from_feature_review: TransactionDataOpsReviewBucket;
  debris_class_at_disposal_site_review: TransactionDataOpsReviewBucket;
  mileage_review: TransactionDataOpsReviewBucket;
  load_call_review: TransactionDataOpsReviewBucket;
  linked_mobile_load_consistency_review: TransactionDataOpsReviewBucket;
  truck_trip_time_review: TransactionDataOpsReviewBucket;
  detected_header_map: Partial<Record<TransactionDataFieldKey, TransactionDataHeaderMatch[]>>;
  detected_sheet_names: string[];
  inferred_date_range_start: string | null;
  inferred_date_range_end: string | null;
}

export const TRANSACTION_DATA_ROW_SCHEMA: Record<
  TransactionDataFieldKey | TransactionDataDerivedRowFieldKey | TransactionDataRequiredRowFieldKey,
  TransactionDataSchemaFieldDefinition
> = {
  transaction_number: { type: 'string', required: false, nullable: true },
  invoice_number: { type: 'string', required: false, nullable: true },
  invoice_date: { type: 'date', required: false, nullable: true },
  rate_code: { type: 'string', required: false, nullable: true },
  rate_description: { type: 'string', required: false, nullable: true },
  transaction_quantity: { type: 'number', required: false, nullable: true },
  transaction_rate: { type: 'currency', required: false, nullable: true },
  extended_cost: { type: 'currency', required: false, nullable: true },
  net_quantity: { type: 'number', required: false, nullable: true },
  mileage: { type: 'number', required: false, nullable: true },
  cyd: { type: 'number', required: false, nullable: true },
  net_tonnage: { type: 'number', required: false, nullable: true },
  material: { type: 'string', required: false, nullable: true },
  service_item: { type: 'string', required: false, nullable: true },
  ticket_notes: { type: 'string', required: false, nullable: true },
  eligibility: { type: 'string', required: false, nullable: true },
  eligibility_internal_comments: { type: 'string', required: false, nullable: true },
  eligibility_external_comments: { type: 'string', required: false, nullable: true },
  load_latitude: { type: 'number', required: false, nullable: true },
  load_longitude: { type: 'number', required: false, nullable: true },
  disposal_latitude: { type: 'number', required: false, nullable: true },
  disposal_longitude: { type: 'number', required: false, nullable: true },
  project_name: { type: 'string', required: false, nullable: true },
  billing_rate_key: { type: 'string', required: false, nullable: true },
  description_match_key: { type: 'string', required: false, nullable: true },
  site_material_key: { type: 'string', required: false, nullable: true },
  invoice_rate_key: { type: 'string', required: false, nullable: true },
  source_sheet_name: { type: 'string', required: true, nullable: false },
  source_row_number: { type: 'integer', required: true, nullable: false },
  raw_row: { type: 'json', required: true, nullable: false },
};

export const TRANSACTION_DATA_SUMMARY_SCHEMA: Record<
  TransactionDataSummaryFieldKey,
  TransactionDataSchemaFieldDefinition
> = {
  row_count: { type: 'integer', required: true, nullable: false },
  distinct_invoice_numbers: { type: 'json', required: true, nullable: false },
  distinct_rate_codes: { type: 'json', required: true, nullable: false },
  distinct_service_items: { type: 'json', required: true, nullable: false },
  distinct_materials: { type: 'json', required: true, nullable: false },
  total_extended_cost: { type: 'currency', required: true, nullable: false },
  total_transaction_quantity: { type: 'number', required: true, nullable: false },
  total_tickets: { type: 'integer', required: true, nullable: false },
  total_cyd: { type: 'number', required: true, nullable: false },
  invoiced_ticket_count: { type: 'integer', required: true, nullable: false },
  distinct_invoice_count: { type: 'integer', required: true, nullable: false },
  total_invoiced_amount: { type: 'currency', required: true, nullable: false },
  uninvoiced_line_count: { type: 'integer', required: true, nullable: false },
  eligible_count: { type: 'integer', required: true, nullable: false },
  ineligible_count: { type: 'integer', required: true, nullable: false },
  unknown_eligibility_count: { type: 'integer', required: true, nullable: false },
  rows_with_missing_rate_code: { type: 'integer', required: true, nullable: false },
  rows_with_missing_invoice_number: { type: 'integer', required: true, nullable: false },
  rows_with_missing_quantity: { type: 'integer', required: true, nullable: false },
  rows_with_missing_extended_cost: { type: 'integer', required: true, nullable: false },
  rows_with_zero_cost: { type: 'integer', required: true, nullable: false },
  rows_with_extreme_unit_rate: { type: 'integer', required: true, nullable: false },
  project_operations_overview: { type: 'json', required: true, nullable: false },
  invoice_readiness_summary: { type: 'json', required: true, nullable: false },
  grouped_by_rate_code: { type: 'json', required: true, nullable: false },
  grouped_by_invoice: { type: 'json', required: true, nullable: false },
  grouped_by_site_material: { type: 'json', required: true, nullable: false },
  grouped_by_service_item: { type: 'json', required: true, nullable: false },
  grouped_by_material: { type: 'json', required: true, nullable: false },
  grouped_by_site_type: { type: 'json', required: true, nullable: false },
  grouped_by_disposal_site: { type: 'json', required: true, nullable: false },
  outlier_rows: { type: 'json', required: true, nullable: false },
  dms_fds_lifecycle_summary: { type: 'json', required: true, nullable: false },
  boundary_location_review: { type: 'json', required: true, nullable: false },
  distance_from_feature_review: { type: 'json', required: true, nullable: false },
  debris_class_at_disposal_site_review: { type: 'json', required: true, nullable: false },
  mileage_review: { type: 'json', required: true, nullable: false },
  load_call_review: { type: 'json', required: true, nullable: false },
  linked_mobile_load_consistency_review: { type: 'json', required: true, nullable: false },
  truck_trip_time_review: { type: 'json', required: true, nullable: false },
  detected_header_map: { type: 'json', required: true, nullable: false },
  detected_sheet_names: { type: 'json', required: true, nullable: false },
  inferred_date_range_start: { type: 'date', required: false, nullable: true },
  inferred_date_range_end: { type: 'date', required: false, nullable: true },
};

export const TRANSACTION_DATA_FIELD_LABELS: Record<TransactionDataFieldKey, string> = {
  transaction_number: 'Transaction number',
  invoice_number: 'Invoice number',
  invoice_date: 'Invoice date',
  rate_code: 'Rate code',
  rate_description: 'Rate description',
  transaction_quantity: 'Transaction quantity',
  transaction_rate: 'Transaction rate',
  extended_cost: 'Extended cost',
  net_quantity: 'Net quantity',
  mileage: 'Mileage',
  cyd: 'CYD',
  net_tonnage: 'Net tonnage',
  material: 'Material',
  service_item: 'Service item',
  ticket_notes: 'Ticket notes',
  eligibility: 'Eligibility',
  eligibility_internal_comments: 'Eligibility internal comments',
  eligibility_external_comments: 'Eligibility external comments',
  load_latitude: 'Load latitude',
  load_longitude: 'Load longitude',
  disposal_latitude: 'Disposal latitude',
  disposal_longitude: 'Disposal longitude',
  project_name: 'Project name',
};

export const TRANSACTION_DATA_FIELD_ORDER: readonly TransactionDataFieldKey[] = [
  'transaction_number',
  'invoice_number',
  'invoice_date',
  'rate_code',
  'rate_description',
  'transaction_quantity',
  'transaction_rate',
  'extended_cost',
  'net_quantity',
  'mileage',
  'cyd',
  'net_tonnage',
  'material',
  'service_item',
  'ticket_notes',
  'eligibility',
  'eligibility_internal_comments',
  'eligibility_external_comments',
  'load_latitude',
  'load_longitude',
  'disposal_latitude',
  'disposal_longitude',
  'project_name',
] as const;

export const TRANSACTION_DATA_HEADER_ALIASES: Record<TransactionDataFieldKey, readonly string[]> = {
  transaction_number: [
    'transaction #',
    'transaction number',
    'ticket #',
    'ticket number',
    'ticket no',
    'load ticket',
    'load ticket #',
  ],
  invoice_number: [
    'invoice #',
    'invoice number',
    'invoice no',
    'invoice',
  ],
  invoice_date: [
    'invoice date',
    'bill date',
    'billing date',
    'date invoiced',
  ],
  rate_code: [
    'rate code',
    'service code',
    'item code',
    'contract rate code',
  ],
  rate_description: [
    'rate description',
    'description',
    'rate desc',
    'line description',
  ],
  transaction_quantity: [
    'transaction quantity',
    'quantity',
    'qty',
    'ticket quantity',
  ],
  transaction_rate: [
    'transaction rate',
    'unit rate',
    'unit price',
    'bill rate',
    'rate',
  ],
  extended_cost: [
    'extended cost',
    'line total',
    'extended amount',
    'total amount',
    'line amount',
    'amount',
  ],
  net_quantity: [
    'net quantity',
    'net qty',
  ],
  mileage: [
    'mileage',
    'miles',
    'haul miles',
  ],
  cyd: [
    'cyd',
    'cy',
    'cubic yard',
    'cubic yards',
  ],
  net_tonnage: [
    'net tonnage',
    'net tons',
    'tonnage',
    'tons',
  ],
  material: [
    'material',
    'material type',
    'debris type',
  ],
  service_item: [
    'service item',
    'service',
    'service line',
  ],
  ticket_notes: [
    'ticket notes',
    'notes',
    'remarks',
    'ticket comments',
  ],
  eligibility: [
    'eligibility',
    'eligible',
    'eligibility status',
  ],
  eligibility_internal_comments: [
    'eligibility internal comments',
    'internal comments',
    'internal notes',
  ],
  eligibility_external_comments: [
    'eligibility external comments',
    'external comments',
    'external notes',
  ],
  load_latitude: [
    'load latitude',
    'load lat',
    'pickup latitude',
    'load gps latitude',
  ],
  load_longitude: [
    'load longitude',
    'load lng',
    'load lon',
    'pickup longitude',
    'load gps longitude',
  ],
  disposal_latitude: [
    'disposal latitude',
    'disposal lat',
    'dump latitude',
    'destination latitude',
  ],
  disposal_longitude: [
    'disposal longitude',
    'disposal lng',
    'disposal lon',
    'dump longitude',
    'destination longitude',
  ],
  project_name: [
    'project',
    'project name',
    'job name',
    'site name',
  ],
};

export const TRANSACTION_DATA_CODE_FIELDS = new Set<TransactionDataFieldKey>([
  'transaction_number',
  'invoice_number',
  'rate_code',
]);

export const TRANSACTION_DATA_METRIC_FIELDS = new Set<TransactionDataFieldKey>([
  'transaction_quantity',
  'net_quantity',
  'mileage',
  'cyd',
  'net_tonnage',
  'load_latitude',
  'load_longitude',
  'disposal_latitude',
  'disposal_longitude',
]);

export const TRANSACTION_DATA_AMOUNT_FIELDS = new Set<TransactionDataFieldKey>([
  'transaction_rate',
  'extended_cost',
]);
