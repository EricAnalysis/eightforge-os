import { z } from 'zod';

import { sha256Hex } from '@/lib/extraction/domain/hash';

export const FORGEWING_LABELLED_PRICING_A3_VERSION =
  'forgewing-labelled-pricing-a3-v1' as const;

export const LABELLED_PRICING_A3_ROLE_MAPPING = Object.freeze({
  description: 'description_like_text',
  unit: 'unit_like_text',
  cost: 'rate_like_amount',
} as const);

export type LabelledPricingA3LabelRole = keyof typeof LABELLED_PRICING_A3_ROLE_MAPPING;
export type LabelledPricingA3SemanticRole =
  (typeof LABELLED_PRICING_A3_ROLE_MAPPING)[LabelledPricingA3LabelRole];

const identifier = z.string().min(1).max(500)
  .refine((value) => value.trim() === value, 'identifier whitespace');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const sourcePdfSchema = z.object({
  file_name: identifier.optional(),
  sha256,
  byte_length: z.number().int().positive(),
  pages: z.number().int().positive(),
}).strict();

const humanAttestationSchema = z.object({
  attested: z.literal(true),
  attested_by: identifier,
  attested_at: z.string().datetime({ offset: true }),
}).strict();

const labelProvenanceSchema = z.object({
  method: z.enum(['human_authored', 'human_verified', 'machine_generated']),
  human_attestation: humanAttestationSchema.optional(),
}).strict();

const observationSchema = z.object({
  field_identifier: identifier,
  source_pdf_sha256: sha256,
  source_page: z.number().int().positive(),
  coordinate_space: identifier.optional(),
  bbox_x0: z.number().finite().nonnegative(),
  bbox_y0: z.number().finite().nonnegative(),
  bbox_x1: z.number().finite().positive(),
  bbox_y1: z.number().finite().positive(),
  bbox_normalized_json: z.string().optional(),
  page_width_points: z.number().finite().positive(),
  page_height_points: z.number().finite().positive(),
  exact_raw_text: z.string(),
  raw_text_sha256: sha256,
  interpreted_field_or_role: identifier,
  row_identity: identifier,
  ledger_version: identifier.optional(),
  generation_method_id: identifier.optional(),
  evidence_status: identifier.optional(),
  notes: z.string().optional(),
}).strict().superRefine((observation, context) => {
  if (observation.bbox_x0 >= observation.bbox_x1
    || observation.bbox_y0 >= observation.bbox_y1
    || observation.bbox_x1 > observation.page_width_points
    || observation.bbox_y1 > observation.page_height_points) {
    context.addIssue({ code: 'custom', message: 'invalid observation bounding box' });
  }
  if (sha256Hex(observation.exact_raw_text) !== observation.raw_text_sha256) {
    context.addIssue({ code: 'custom', message: 'raw text SHA-256 mismatch' });
  }
});

const ledgerSchema = z.object({
  ledger_version: identifier,
  status: z.enum(['draft', 'final', 'machine_generated']).optional(),
  created_at: z.string().optional(),
  evidence_status: identifier.optional(),
  package_status: z.enum(['draft', 'final']).optional(),
  label_provenance: labelProvenanceSchema.optional(),
  source_pdf: sourcePdfSchema,
  production_parser_input_prohibited: z.boolean().optional(),
  legacy_output_used_as_annotation_truth: z.boolean().optional(),
  authored_stitched_rows_used: z.boolean().optional(),
  expected_row_count_used: z.boolean().optional(),
  annotation_method: z.object({
    generation_method_id: identifier,
    library: identifier,
    source: identifier,
    pages: z.array(z.number().int().positive()),
    coordinate_space: identifier,
  }).strict().optional(),
  page_summaries: z.array(z.object({
    source_page: z.number().int().positive(),
    detected_table_count: z.number().int().nonnegative(),
    table_bbox_points: z.tuple([
      z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(),
    ]),
    observed_field_count: z.number().int().nonnegative(),
    generation_method_id: identifier,
    observed_row_identities: z.array(identifier),
  }).strict()).optional(),
  observations: z.array(observationSchema).min(1),
}).strict().superRefine((ledger, context) => {
  const identifiers = new Set<string>();
  ledger.observations.forEach((observation, index) => {
    if (identifiers.has(observation.field_identifier)) {
      context.addIssue({
        code: 'custom',
        path: ['observations', index, 'field_identifier'],
        message: 'duplicate field identifier',
      });
    }
    identifiers.add(observation.field_identifier);
    if (observation.source_pdf_sha256 !== ledger.source_pdf.sha256) {
      context.addIssue({
        code: 'custom',
        path: ['observations', index, 'source_pdf_sha256'],
        message: 'observation source identity mismatch',
      });
    }
    if (observation.source_page > ledger.source_pdf.pages) {
      context.addIssue({
        code: 'custom',
        path: ['observations', index, 'source_page'],
        message: 'observation page exceeds source page count',
      });
    }
  });
});

export type LabelledPricingA3Ledger = z.infer<typeof ledgerSchema>;
export type LabelledPricingA3Observation = LabelledPricingA3Ledger['observations'][number];

export type LabelledPricingA3UnmetLabelReason =
  | 'label_provenance_missing'
  | 'label_provenance_machine_generated'
  | 'human_attestation_missing';

export type LabelledPricingA3LabelWarning =
  | 'label_package_draft'
  | 'label_package_status_unknown';

export type LabelledPricingA3RoleDenominator = Readonly<{
  labelRole: LabelledPricingA3LabelRole;
  semanticRole: LabelledPricingA3SemanticRole;
  observationCount: number;
  distinctRowCount: number;
}>;

export type LabelledPricingA3ExpectedLabel = Readonly<{
  labelObservationId: string;
  rowIdentity: string;
  sourcePage: number;
  labelRole: LabelledPricingA3LabelRole;
  expectedSemanticRole: LabelledPricingA3SemanticRole;
  /** Exact authored evidence. Evaluation must not numerically coerce this value. */
  expectedRawText: string;
  rawTextSha256: string;
}>;

export type LabelledPricingA3LabelAudit = Readonly<{
  evaluationVersion: typeof FORGEWING_LABELLED_PRICING_A3_VERSION;
  corpusStatus: 'labelled_a3_labels_ready' | 'labelled_a3_unmet_labels';
  unmetReasons: readonly LabelledPricingA3UnmetLabelReason[];
  warnings: readonly LabelledPricingA3LabelWarning[];
  package: Readonly<{
    ledgerVersion: string;
    status: 'draft' | 'final' | 'unknown';
    provenanceMethod: 'human_authored' | 'human_verified' | 'machine_generated' | null;
    humanAttested: boolean;
    promotionSuitable: boolean;
  }>;
  source: Readonly<{
    sha256: string;
    byteLength: number;
    pages: number;
  }>;
  denominators: Readonly<{
    totalObservations: number;
    totalDistinctRows: number;
    scoredObservations: number;
    scoredDistinctRows: number;
    byRole: Readonly<Record<LabelledPricingA3LabelRole, LabelledPricingA3RoleDenominator>>;
    excludedByRole: Readonly<Record<string, number>>;
  }>;
  roleMapping: typeof LABELLED_PRICING_A3_ROLE_MAPPING;
  expectedLabels: readonly LabelledPricingA3ExpectedLabel[];
}>;

export type LabelledPricingA3CaseClassification =
  | 'correct_answer'
  | 'safe_abstention'
  | 'unsafe_confident_answer'
  | 'schema_failure'
  | 'provider_failure'
  | 'not_scored';

export type LabelledPricingA3CaseScore = Readonly<{
  candidateId: string;
  rowObservationId: string;
  labelObservationIds: readonly string[];
  classification: LabelledPricingA3CaseClassification;
  semanticRoleCorrect: boolean | null;
  amountCorrect: boolean | null;
  evidenceAnchorFidelity: 'valid' | 'invalid' | 'unverifiable';
  abstained: boolean;
  confidence: number | null;
  failureReason: string | null;
}>;

export type LabelledPricingA3ScoredReport = Readonly<{
  evaluationVersion: typeof FORGEWING_LABELLED_PRICING_A3_VERSION;
  authority: 'non_authoritative_measurement';
  corpusStatus:
    | 'labelled_a3_measured'
    | 'labelled_a3_unmet_labels'
    | 'labelled_a3_source_mismatch'
    | 'labelled_a3_no_eligible_candidates'
    | 'labelled_a3_provider_unavailable'
    | 'labelled_a3_non_deterministic_input'
    | 'labelled_a3_incomplete';
  labelAudit: LabelledPricingA3LabelAudit;
  cases: readonly LabelledPricingA3CaseScore[];
}>;

function resolvedPackageStatus(ledger: LabelledPricingA3Ledger): 'draft' | 'final' | 'unknown' {
  if (ledger.package_status) return ledger.package_status;
  if (/(?:^|[._-])draft(?:$|[._-])/i.test(ledger.ledger_version)) return 'draft';
  return 'unknown';
}

export function auditLabelledPricingA3Ledger(input: unknown): LabelledPricingA3LabelAudit {
  const ledger = ledgerSchema.parse(input);
  const packageStatus = resolvedPackageStatus(ledger);
  const provenanceMethod = ledger.label_provenance?.method
    ?? (ledger.status === 'machine_generated' ? 'machine_generated' : null);
  const unmetReasons = new Set<LabelledPricingA3UnmetLabelReason>();
  const warnings = new Set<LabelledPricingA3LabelWarning>();
  if (packageStatus === 'draft') warnings.add('label_package_draft');
  if (packageStatus === 'unknown') warnings.add('label_package_status_unknown');
  if (provenanceMethod == null) unmetReasons.add('label_provenance_missing');
  if (provenanceMethod === 'machine_generated') {
    unmetReasons.add('label_provenance_machine_generated');
  }
  if (!ledger.label_provenance?.human_attestation) {
    unmetReasons.add('human_attestation_missing');
  }

  const expectedLabels = ledger.observations.flatMap((observation) => {
    const labelRole = observation.interpreted_field_or_role as LabelledPricingA3LabelRole;
    if (!(labelRole in LABELLED_PRICING_A3_ROLE_MAPPING)) return [];
    return [{
      labelObservationId: observation.field_identifier,
      rowIdentity: observation.row_identity,
      sourcePage: observation.source_page,
      labelRole,
      expectedSemanticRole: LABELLED_PRICING_A3_ROLE_MAPPING[labelRole],
      expectedRawText: observation.exact_raw_text,
      rawTextSha256: observation.raw_text_sha256,
    }];
  });
  const byRole = Object.fromEntries(
    Object.entries(LABELLED_PRICING_A3_ROLE_MAPPING).map(([rawLabelRole, semanticRole]) => {
      const labelRole = rawLabelRole as LabelledPricingA3LabelRole;
      const observations = expectedLabels.filter((label) => label.labelRole === labelRole);
      return [labelRole, {
        labelRole,
        semanticRole,
        observationCount: observations.length,
        distinctRowCount: new Set(observations.map((label) => label.rowIdentity)).size,
      }];
    }),
  ) as Record<LabelledPricingA3LabelRole, LabelledPricingA3RoleDenominator>;
  const excludedByRole: Record<string, number> = {};
  for (const observation of ledger.observations) {
    if (observation.interpreted_field_or_role in LABELLED_PRICING_A3_ROLE_MAPPING) continue;
    excludedByRole[observation.interpreted_field_or_role] =
      (excludedByRole[observation.interpreted_field_or_role] ?? 0) + 1;
  }

  return {
    evaluationVersion: FORGEWING_LABELLED_PRICING_A3_VERSION,
    corpusStatus: unmetReasons.size === 0
      ? 'labelled_a3_labels_ready'
      : 'labelled_a3_unmet_labels',
    unmetReasons: [...unmetReasons].sort(),
    warnings: [...warnings].sort(),
    package: {
      ledgerVersion: ledger.ledger_version,
      status: packageStatus,
      provenanceMethod,
      humanAttested: ledger.label_provenance?.human_attestation != null,
      promotionSuitable: packageStatus === 'final'
        && ['human_authored', 'human_verified'].includes(provenanceMethod ?? '')
        && ledger.label_provenance?.human_attestation != null,
    },
    source: {
      sha256: ledger.source_pdf.sha256,
      byteLength: ledger.source_pdf.byte_length,
      pages: ledger.source_pdf.pages,
    },
    denominators: {
      totalObservations: ledger.observations.length,
      totalDistinctRows: new Set(ledger.observations.map((item) => item.row_identity)).size,
      scoredObservations: expectedLabels.length,
      scoredDistinctRows: new Set(expectedLabels.map((label) => label.rowIdentity)).size,
      byRole,
      excludedByRole: Object.fromEntries(Object.entries(excludedByRole)
        .sort(([left], [right]) => left.localeCompare(right, 'en-US'))),
    },
    roleMapping: LABELLED_PRICING_A3_ROLE_MAPPING,
    expectedLabels,
  };
}
