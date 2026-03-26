import { z } from 'zod';

export const instructorDocumentFamilySchema = z.enum([
  'contract',
  'invoice',
  'payment_recommendation',
  'ticket',
  'spreadsheet',
  'operational',
  'generic',
]);

export const instructorDetectedDocumentTypeSchema = z.enum([
  'contract',
  'invoice',
  'payment_recommendation',
  'ticket',
  'spreadsheet',
  'operational',
  'generic',
  'report',
]);

const boundedString = (maxLength: number) => z.string().trim().min(1).max(maxLength);

export const instructorClassificationSchema = z.object({
  family: instructorDocumentFamilySchema,
  detected_document_type: instructorDetectedDocumentTypeSchema.nullable(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(boundedString(160)).max(6).default([]),
});

const contractRateTableEntrySchema = z.object({
  material_type: z.string().trim().min(1).max(120).nullable(),
  unit: z.string().trim().min(1).max(60).nullable(),
  rate_amount: z.number().finite().nullable(),
  rate_raw: boundedString(220),
});

export const contractExtractionAssistSchema = z.object({
  schema_type: z.literal('contract'),
  vendor_name: z.string().trim().min(1).max(180).nullable().optional(),
  contract_date: z.string().trim().min(1).max(80).nullable().optional(),
  effective_date: z.string().trim().min(1).max(80).nullable().optional(),
  expiration_date: z.string().trim().min(1).max(80).nullable().optional(),
  termination_clause: z.string().trim().min(1).max(500).nullable().optional(),
  rate_table: z.array(contractRateTableEntrySchema).max(20).optional(),
  material_types: z.array(boundedString(80)).max(20).optional(),
  hauling_rates: z.array(boundedString(160)).max(20).optional(),
  tipping_fees: z.array(boundedString(160)).max(20).optional(),
  fema_reference: z.boolean().optional(),
  insurance_requirements: z.string().trim().min(1).max(300).nullable().optional(),
  bonding_requirements: z.string().trim().min(1).max(300).nullable().optional(),
});

const invoiceLineItemSchema = z.object({
  description: boundedString(220),
  quantity: z.number().finite().nullable(),
  unit: z.string().trim().min(1).max(40).nullable(),
  unit_price: z.number().finite().nullable(),
  total: z.number().finite().nullable(),
});

export const invoiceExtractionAssistSchema = z.object({
  schema_type: z.literal('invoice'),
  invoice_number: z.string().trim().min(1).max(120).nullable().optional(),
  invoice_date: z.string().trim().min(1).max(80).nullable().optional(),
  vendor_name: z.string().trim().min(1).max(180).nullable().optional(),
  line_items: z.array(invoiceLineItemSchema).max(30).optional(),
  total_amount: z.number().finite().nullable().optional(),
  payment_terms: z.string().trim().min(1).max(120).nullable().optional(),
  po_number: z.string().trim().min(1).max(120).nullable().optional(),
});

const reportFindingSchema = z.object({
  finding_text: boundedString(240),
  severity: z.enum(['info', 'warning', 'critical']).nullable(),
});

export const reportExtractionAssistSchema = z.object({
  schema_type: z.literal('report'),
  report_type: z.string().trim().min(1).max(120).nullable().optional(),
  reporting_period: z.string().trim().min(1).max(160).nullable().optional(),
  findings: z.array(reportFindingSchema).max(20).optional(),
  metrics: z.record(z.string(), z.union([z.string(), z.number()])).nullable().optional(),
  compliance_status: z.string().trim().min(1).max(120).nullable().optional(),
  author: z.string().trim().min(1).max(120).nullable().optional(),
  date: z.string().trim().min(1).max(80).nullable().optional(),
});

export const extractionAssistUnionSchema = z.discriminatedUnion('schema_type', [
  contractExtractionAssistSchema,
  invoiceExtractionAssistSchema,
  reportExtractionAssistSchema,
]);

export const extractionAssistEnvelopeSchema = z.object({
  typed_fields: extractionAssistUnionSchema,
  confidence: z.number().min(0).max(1),
  reasons: z.array(boundedString(160)).max(6).default([]),
});
