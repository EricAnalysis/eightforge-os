import { z } from 'zod';

import {
  FORGEWING_COLUMN_MAPPING_PROPOSAL_SCHEMA_VERSION,
  FORGEWING_PROPOSAL_SCHEMA_VERSION,
  FORGEWING_TABLE_CONTINUATION_PROPOSAL_SCHEMA_VERSION,
} from '@/lib/forgewing/proposal/schemaVersion';

const boundedIdentifier = z.string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, 'identifier must not contain surrounding whitespace');

const boundedText = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value.trim() === value, 'text must not contain surrounding whitespace');

/** Source evidence is preserved verbatim; whitespace-only spans are not useful citations. */
const rawSpanSchema = z.string()
  .min(1)
  .max(4_000)
  .refine(
    (value) => value.trim().length > 0,
    'raw span must contain at least one non-whitespace character',
  );

export const ForgewingTaskTypeSchema = z.enum([
  'region_classification',
  'table_continuation',
  'column_mapping',
]);

export const ForgewingProposalStateSchema = z.enum([
  'observed',
  'inferred',
  'ambiguous',
  'unresolved',
  'conflicting',
  'insufficient_evidence',
]);

export const ForgewingRegionLabelSchema = z.enum([
  'table',
  'prose',
  'header',
  'footnote',
  'rate_schedule',
  'continuation',
  'signature_block',
  'unknown',
]);

export const ForgewingTableContinuationRelationSchema = z.enum([
  'same_table',
  'separate_tables',
  'ambiguous',
]);

export const ForgewingTableContinuationRationaleCodeSchema = z.enum([
  'repeated_header_consistent',
  'column_structure_consistent',
  'row_sequence_continues',
  'prior_row_incomplete',
  'next_page_header_restart',
  'title_reset',
  'column_semantics_changed',
  'schema_changed',
  'section_break_detected',
  'mixed_evidence',
  'insufficient_structure',
]);

/** Existing deterministic semantic-column vocabulary; this is not a new authority vocabulary. */
export const ForgewingSemanticColumnRoleSchema = z.enum([
  'description',
  'row_label',
  'quantity',
  'unit',
  'rate',
  'extension',
  'origin',
  'destination',
  'origin_destination',
  'category',
  'code',
  'identifier',
  'other',
]);

/** `other` is the deterministic unresolved fallback, not a confident positive mapping. */
export const ForgewingProposedSemanticColumnRoleSchema = z.enum([
  'description',
  'row_label',
  'quantity',
  'unit',
  'rate',
  'extension',
  'origin',
  'destination',
  'origin_destination',
  'category',
  'code',
  'identifier',
]);

export const ForgewingColumnMappingRationaleCodeSchema = z.enum([
  'header_semantics',
  'currency_pattern',
  'unit_pattern',
  'numeric_rate_pattern',
  'description_text_pattern',
  'category_repetition',
  'code_pattern',
  'neighboring_column_context',
  'mixed_evidence',
  'insufficient_structure',
]);

export const ForgewingBoundingBoxSchema = z.object({
  coordinateSpace: z.literal('page_normalized'),
  origin: z.literal('top_left'),
  x0: z.number().min(0).max(1),
  y0: z.number().min(0).max(1),
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
}).strict().superRefine((box, context) => {
  if (box.x1 <= box.x0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['x1'], message: 'x1 must be greater than x0' });
  }
  if (box.y1 <= box.y0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['y1'], message: 'y1 must be greater than y0' });
  }
});

export const ForgewingEvidenceRefSchema = z.object({
  artifactId: boundedIdentifier,
  sourceDocumentId: boundedIdentifier.optional(),
  sourceArtifactId: boundedIdentifier.optional(),
  pageArtifactId: boundedIdentifier.optional(),
  physicalPageNumber: z.number().int().positive().optional(),
  artifactLocalIndex: z.number().int().nonnegative().optional(),
  boundingBox: ForgewingBoundingBoxSchema.optional(),
  rawSpan: rawSpanSchema.optional(),
  sourceLayer: z.enum([
    'pdf_page_render',
    'pdf_native_text',
    'ocr',
    'table_artifact',
    'legacy',
  ]).optional(),
}).strict().superRefine((reference, context) => {
  if (reference.artifactLocalIndex != null && reference.sourceLayer == null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceLayer'],
      message: 'artifactLocalIndex requires its real source layer',
    });
  }
  if (reference.physicalPageNumber != null) {
    for (const field of ['sourceDocumentId', 'sourceArtifactId', 'pageArtifactId'] as const) {
      if (reference[field] == null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required for a physical-page citation`,
        });
      }
    }
    if (reference.sourceLayer == null || reference.sourceLayer === 'legacy') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceLayer'],
        message: 'physicalPageNumber requires a proven non-legacy source layer',
      });
    }
  }
});

export const ForgewingMissingEvidenceCodeSchema = z.enum([
  'missing_source_observation',
  'missing_physical_page_proof',
  'insufficient_table_context',
  'conflicting_observations',
  'missing_column_context',
  'truncated_input',
]);

export const ForgewingMissingEvidenceSchema = z.object({
  code: ForgewingMissingEvidenceCodeSchema,
  description: boundedText(240).optional(),
}).strict();

const evidenceReferences = (minimum: number, maximum?: number) => z.array(ForgewingEvidenceRefSchema)
  .min(minimum)
  .max(maximum ?? 200)
  .refine(
    (references) => new Set(references.map((reference) => JSON.stringify(reference))).size === references.length,
    'evidence references must be distinct',
  );

const inputObservationIds = (minimum: number) => z.array(boundedIdentifier)
  .min(minimum)
  .refine(
    (identifiers) => new Set(identifiers).size === identifiers.length,
    'input observation identifiers must be distinct',
  );

export const ForgewingRunIdentitySchema = z.object({
  runId: boundedIdentifier,
  organizationId: boundedIdentifier,
  extractionSnapshotId: boundedIdentifier,
  inputSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const ForgewingAbstentionReasonSchema = z.enum([
  'unsupported_input',
  'input_contract_violation',
  'budget_unavailable',
  'runtime_unavailable',
  'task_not_supported',
]);

export const ForgewingAbstentionSchema = z.object({
  taskId: boundedIdentifier,
  taskType: ForgewingTaskTypeSchema,
  sourceDocumentId: boundedIdentifier,
  sourceArtifactId: boundedIdentifier,
  extractionSnapshotId: boundedIdentifier,
  inputObservationIds: inputObservationIds(0),
  reason: ForgewingAbstentionReasonSchema,
  detail: boundedText(400).optional(),
}).strict();

const proposalIdentityShape = {
  proposalId: boundedIdentifier,
  taskId: boundedIdentifier,
  taskType: z.literal('region_classification'),
  sourceDocumentId: boundedIdentifier,
  sourceArtifactId: boundedIdentifier,
  extractionSnapshotId: boundedIdentifier,
  pageArtifactId: boundedIdentifier.optional(),
  physicalPageNumber: z.number().int().positive().optional(),
  artifactLocalIndex: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1).nullable(),
  rationale: boundedText(400).optional(),
} as const;

const regionValueSchema = z.object({
  label: ForgewingRegionLabelSchema,
}).strict();

const observedProposalSchema = z.object({
  ...proposalIdentityShape,
  inputObservationIds: inputObservationIds(1),
  state: z.literal('observed'),
  value: regionValueSchema,
  evidence: evidenceReferences(1),
}).strict();

const inferredProposalSchema = z.object({
  ...proposalIdentityShape,
  inputObservationIds: inputObservationIds(1),
  state: z.literal('inferred'),
  value: regionValueSchema,
  evidence: evidenceReferences(1),
}).strict();

const ambiguousProposalSchema = z.object({
  ...proposalIdentityShape,
  inputObservationIds: inputObservationIds(1),
  state: z.literal('ambiguous'),
  evidence: evidenceReferences(2),
}).strict();

const unresolvedProposalSchema = z.object({
  ...proposalIdentityShape,
  inputObservationIds: inputObservationIds(1),
  state: z.literal('unresolved'),
  evidence: evidenceReferences(1),
}).strict();

const conflictingProposalSchema = z.object({
  ...proposalIdentityShape,
  inputObservationIds: inputObservationIds(1),
  state: z.literal('conflicting'),
  evidence: evidenceReferences(2),
}).strict();

const insufficientEvidenceProposalSchema = z.object({
  ...proposalIdentityShape,
  inputObservationIds: inputObservationIds(0),
  state: z.literal('insufficient_evidence'),
  evidence: evidenceReferences(0),
  missingEvidence: z.array(ForgewingMissingEvidenceSchema).min(1),
}).strict();

const regionProposalSchema = z.discriminatedUnion('state', [
  observedProposalSchema,
  inferredProposalSchema,
  ambiguousProposalSchema,
  unresolvedProposalSchema,
  conflictingProposalSchema,
  insufficientEvidenceProposalSchema,
]);

type RegionProposalWithEvidence = z.infer<typeof regionProposalSchema>;

function enforceProposalProvenanceCoherence(
  proposal: RegionProposalWithEvidence,
  context: z.RefinementCtx,
): void {
  const inputIds = new Set(proposal.inputObservationIds);
  proposal.evidence.forEach((reference, index) => {
    if (!inputIds.has(reference.artifactId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', index, 'artifactId'],
        message: 'evidence artifact must be declared in inputObservationIds',
      });
    }
    for (const field of [
      'sourceDocumentId',
      'sourceArtifactId',
      'pageArtifactId',
      'physicalPageNumber',
      'artifactLocalIndex',
    ] as const) {
      const evidenceValue = reference[field];
      if (evidenceValue != null && evidenceValue !== proposal[field]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence', index, field],
          message: `${field} must match the proposal provenance`,
        });
      }
    }
  });

  if (
    proposal.physicalPageNumber != null
    && !proposal.evidence.some(
      (reference) => reference.physicalPageNumber === proposal.physicalPageNumber,
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['physicalPageNumber'],
      message: 'proposal physicalPageNumber requires matching evidence',
    });
  }
}

export const ForgewingRegionProposalSchema = regionProposalSchema.superRefine(
  enforceProposalProvenanceCoherence,
);

const continuationIdentityShape = {
  proposalId: boundedIdentifier,
  taskId: boundedIdentifier,
  taskType: z.literal('table_continuation'),
  sourceDocumentId: boundedIdentifier,
  sourceArtifactId: boundedIdentifier,
  extractionSnapshotId: boundedIdentifier,
  priorSegmentId: boundedIdentifier,
  nextSegmentId: boundedIdentifier,
  priorPageArtifactId: boundedIdentifier,
  nextPageArtifactId: boundedIdentifier,
  priorPhysicalPageNumber: z.number().int().positive(),
  nextPhysicalPageNumber: z.number().int().positive(),
  priorArtifactLocalIndex: z.number().int().nonnegative().nullable(),
  nextArtifactLocalIndex: z.number().int().nonnegative().nullable(),
  priorSourceLayer: z.enum(['pdf_page_render', 'pdf_native_text', 'ocr', 'table_artifact']),
  nextSourceLayer: z.enum(['pdf_page_render', 'pdf_native_text', 'ocr', 'table_artifact']),
  confidence: z.number().min(0).max(1).nullable(),
  rationaleCode: ForgewingTableContinuationRationaleCodeSchema,
} as const;

const resolvedContinuationProposalSchema = z.object({
  ...continuationIdentityShape,
  inputObservationIds: inputObservationIds(2),
  state: z.enum(['observed', 'inferred']),
  relation: z.enum(['same_table', 'separate_tables']),
  evidence: evidenceReferences(2),
}).strict();

const ambiguousContinuationProposalSchema = z.object({
  ...continuationIdentityShape,
  inputObservationIds: inputObservationIds(2),
  state: z.literal('ambiguous'),
  relation: z.literal('ambiguous'),
  evidence: evidenceReferences(2),
}).strict();

const insufficientContinuationProposalSchema = z.object({
  ...continuationIdentityShape,
  inputObservationIds: inputObservationIds(2),
  state: z.literal('insufficient_evidence'),
  evidence: evidenceReferences(0, 0),
  missingEvidence: z.array(ForgewingMissingEvidenceSchema).min(1).max(6),
}).strict();

const continuationProposalSchema = z.discriminatedUnion('state', [
  resolvedContinuationProposalSchema,
  ambiguousContinuationProposalSchema,
  insufficientContinuationProposalSchema,
]);

type ContinuationProposalWithEvidence = z.infer<typeof continuationProposalSchema>;

function enforceContinuationProvenanceCoherence(
  proposal: ContinuationProposalWithEvidence,
  context: z.RefinementCtx,
): void {
  if (proposal.priorSegmentId === proposal.nextSegmentId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextSegmentId'],
      message: 'continuation segments must be distinct',
    });
  }
  if (proposal.priorPageArtifactId === proposal.nextPageArtifactId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextPageArtifactId'],
      message: 'continuation pages must be distinct',
    });
  }
  if (proposal.nextPhysicalPageNumber !== proposal.priorPhysicalPageNumber + 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextPhysicalPageNumber'],
      message: 'table continuation v0 requires adjacent physical pages',
    });
  }

  const inputIds = new Set(proposal.inputObservationIds);
  for (const [field, identifier] of [
    ['priorSegmentId', proposal.priorSegmentId],
    ['nextSegmentId', proposal.nextSegmentId],
  ] as const) {
    if (!inputIds.has(identifier)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be declared in inputObservationIds`,
      });
    }
  }

  const citedPages = new Set<string>();
  proposal.evidence.forEach((reference, index) => {
    if (!inputIds.has(reference.artifactId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', index, 'artifactId'],
        message: 'evidence artifact must be declared in inputObservationIds',
      });
    }
    if (
      reference.sourceDocumentId != null
      && reference.sourceDocumentId !== proposal.sourceDocumentId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', index, 'sourceDocumentId'],
        message: 'sourceDocumentId must match the proposal provenance',
      });
    }
    if (
      reference.sourceArtifactId != null
      && reference.sourceArtifactId !== proposal.sourceArtifactId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', index, 'sourceArtifactId'],
        message: 'sourceArtifactId must match the proposal provenance',
      });
    }

    const side = reference.pageArtifactId === proposal.priorPageArtifactId
      ? 'prior' as const
      : reference.pageArtifactId === proposal.nextPageArtifactId
        ? 'next' as const
        : null;
    if (side == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', index, 'pageArtifactId'],
        message: 'continuation evidence must identify the prior or next page artifact',
      });
      return;
    }
    citedPages.add(reference.pageArtifactId!);
    const physicalPageNumber = side === 'prior'
      ? proposal.priorPhysicalPageNumber : proposal.nextPhysicalPageNumber;
    if (
      reference.physicalPageNumber != null
      && reference.physicalPageNumber !== physicalPageNumber
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', index, 'physicalPageNumber'],
        message: 'physicalPageNumber must match its continuation page',
      });
    }
    // Child cells have their own proven layer-local identity. Do not collapse
    // it to the parent segment's artifactLocalIndex or sourceLayer.
  });

  if (proposal.state !== 'insufficient_evidence') {
    for (const pageArtifactId of [proposal.priorPageArtifactId, proposal.nextPageArtifactId]) {
      if (!citedPages.has(pageArtifactId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence'],
          message: 'resolved and ambiguous continuation proposals must cite both pages',
        });
      }
    }
  }
}

export const ForgewingTableContinuationProposalSchema = continuationProposalSchema.superRefine(
  enforceContinuationProvenanceCoherence,
);

const columnIdentitySchema = z.object({
  columnId: boundedIdentifier,
  columnIndex: z.number().int().nonnegative().max(10_000),
}).strict();

const columnMappingEntryCommon = {
  ...columnIdentitySchema.shape,
  confidence: z.number().min(0).max(1).nullable(),
  rationaleCodes: z.array(ForgewingColumnMappingRationaleCodeSchema)
    .min(1)
    .max(4)
    .refine((codes) => new Set(codes).size === codes.length, 'rationale codes must be distinct'),
} as const;

const resolvedColumnMappingEntrySchema = z.object({
  ...columnMappingEntryCommon,
  state: z.enum(['observed', 'inferred']),
  proposedRole: ForgewingProposedSemanticColumnRoleSchema,
  evidenceArtifactIds: inputObservationIds(1).refine(
    (identifiers) => identifiers.length <= 96,
    'column evidence identifiers must be bounded',
  ),
}).strict();

const ambiguousColumnMappingEntrySchema = z.object({
  ...columnMappingEntryCommon,
  state: z.literal('ambiguous'),
  candidateRoles: z.array(ForgewingProposedSemanticColumnRoleSchema)
    .min(1)
    .max(12)
    .refine((roles) => new Set(roles).size === roles.length, 'candidate roles must be distinct'),
  evidenceArtifactIds: inputObservationIds(2).refine(
    (identifiers) => identifiers.length <= 96,
    'column evidence identifiers must be bounded',
  ),
}).strict();

const insufficientColumnMappingEntrySchema = z.object({
  ...columnMappingEntryCommon,
  state: z.literal('insufficient_evidence'),
  confidence: z.null(),
  evidenceArtifactIds: z.array(z.never()).max(0),
  missingEvidence: z.array(ForgewingMissingEvidenceSchema).min(1).max(6),
}).strict();

export const ForgewingColumnMappingEntrySchema = z.discriminatedUnion('state', [
  resolvedColumnMappingEntrySchema,
  ambiguousColumnMappingEntrySchema,
  insufficientColumnMappingEntrySchema,
]);

const columnMappingIdentityShape = {
  proposalId: boundedIdentifier,
  taskId: boundedIdentifier,
  taskType: z.literal('column_mapping'),
  sourceDocumentId: boundedIdentifier,
  sourceArtifactId: boundedIdentifier,
  extractionSnapshotId: boundedIdentifier,
  tableSegmentId: boundedIdentifier,
  pageArtifactId: boundedIdentifier,
  physicalPageNumber: z.number().int().positive().optional(),
  artifactLocalIndex: z.number().int().nonnegative().optional(),
  sourceLayer: z.enum(['pdf_page_render', 'pdf_native_text', 'ocr', 'table_artifact']).optional(),
  inputObservationIds: inputObservationIds(1),
  candidateColumns: z.array(columnIdentitySchema)
    .min(1)
    .max(12)
    .refine(
      (columns) => new Set(columns.map(({ columnId }) => columnId)).size === columns.length
        && new Set(columns.map(({ columnIndex }) => columnIndex)).size === columns.length,
      'candidate column identities and indices must be distinct',
    ),
  mappingCompleteness: z.enum(['complete', 'partial']),
  columnMappings: z.array(ForgewingColumnMappingEntrySchema).min(1).max(12),
  confidence: z.number().min(0).max(1).nullable(),
} as const;

const resolvedColumnMappingProposalSchema = z.object({
  ...columnMappingIdentityShape,
  state: z.enum(['observed', 'inferred']),
  evidence: evidenceReferences(1, 96),
}).strict();

const ambiguousColumnMappingProposalSchema = z.object({
  ...columnMappingIdentityShape,
  state: z.literal('ambiguous'),
  evidence: evidenceReferences(2, 96),
}).strict();

const insufficientColumnMappingProposalSchema = z.object({
  ...columnMappingIdentityShape,
  state: z.literal('insufficient_evidence'),
  confidence: z.null(),
  mappingCompleteness: z.literal('partial'),
  evidence: evidenceReferences(0, 0),
  missingEvidence: z.array(ForgewingMissingEvidenceSchema).min(1).max(6),
}).strict();

const columnMappingProposalSchema = z.discriminatedUnion('state', [
  resolvedColumnMappingProposalSchema,
  ambiguousColumnMappingProposalSchema,
  insufficientColumnMappingProposalSchema,
]);

type ColumnMappingProposalWithEvidence = z.infer<typeof columnMappingProposalSchema>;

function enforceColumnMappingCoherence(
  proposal: ColumnMappingProposalWithEvidence,
  context: z.RefinementCtx,
): void {
  if (proposal.artifactLocalIndex != null && proposal.sourceLayer == null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceLayer'],
      message: 'artifactLocalIndex requires its real source layer',
    });
  }
  if (proposal.physicalPageNumber != null && proposal.sourceLayer == null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceLayer'],
      message: 'physicalPageNumber requires a proven source layer',
    });
  }

  const candidateById = new Map(
    proposal.candidateColumns.map((column) => [column.columnId, column.columnIndex]),
  );
  const mappedIds = new Set<string>();
  const mappedIndices = new Set<number>();
  const inputIds = new Set(proposal.inputObservationIds);
  const citedIds = new Set(proposal.evidence.map(({ artifactId }) => artifactId));
  let hasResolved = false;
  let hasInferred = false;
  let hasAmbiguous = false;
  let hasInsufficient = false;

  proposal.columnMappings.forEach((mapping, index) => {
    if (candidateById.get(mapping.columnId) !== mapping.columnIndex) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['columnMappings', index, 'columnId'],
        message: 'mapped column must match an actual candidate column identity and index',
      });
    }
    if (mappedIds.has(mapping.columnId) || mappedIndices.has(mapping.columnIndex)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['columnMappings', index],
        message: 'a candidate column may be mapped at most once',
      });
    }
    mappedIds.add(mapping.columnId);
    mappedIndices.add(mapping.columnIndex);
    for (const evidenceId of mapping.evidenceArtifactIds) {
      if (!inputIds.has(evidenceId) || !citedIds.has(evidenceId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['columnMappings', index, 'evidenceArtifactIds'],
          message: 'column evidence must be declared in the input and reconstructed proposal evidence',
        });
      }
    }
    hasResolved ||= mapping.state === 'observed' || mapping.state === 'inferred';
    hasInferred ||= mapping.state === 'inferred';
    hasAmbiguous ||= mapping.state === 'ambiguous';
    hasInsufficient ||= mapping.state === 'insufficient_evidence';
  });

  proposal.evidence.forEach((reference, index) => {
    if (!inputIds.has(reference.artifactId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', index, 'artifactId'],
        message: 'evidence artifact must be declared in inputObservationIds',
      });
    }
    for (const [field, expected] of [
      ['sourceDocumentId', proposal.sourceDocumentId],
      ['sourceArtifactId', proposal.sourceArtifactId],
      ['pageArtifactId', proposal.pageArtifactId],
    ] as const) {
      if (reference[field] != null && reference[field] !== expected) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence', index, field],
          message: `${field} must match the selected table`,
        });
      }
    }
    if (
      proposal.physicalPageNumber != null
      && reference.physicalPageNumber != null
      && reference.physicalPageNumber !== proposal.physicalPageNumber
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', index, 'physicalPageNumber'],
        message: 'physicalPageNumber must match the selected table',
      });
    }
  });

  const expectedCompleteness = proposal.columnMappings.length === proposal.candidateColumns.length
    && !hasAmbiguous && !hasInsufficient
    ? 'complete' : 'partial';
  if (proposal.mappingCompleteness !== expectedCompleteness) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mappingCompleteness'],
      message: 'mappingCompleteness must reflect omitted or unresolved candidate columns',
    });
  }
  if (proposal.state === 'ambiguous' && !hasAmbiguous) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: 'ambiguous proposal requires an ambiguous column mapping',
    });
  }
  if (proposal.state === 'insufficient_evidence' && (hasResolved || hasAmbiguous || !hasInsufficient)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: 'insufficient proposal may contain only insufficient column mappings',
    });
  }
  if ((proposal.state === 'observed' || proposal.state === 'inferred') && (!hasResolved || hasAmbiguous)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: 'resolved proposal requires a resolved mapping and no ambiguous mapping',
    });
  }
  if (proposal.state === 'observed' && hasInferred) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: 'observed proposal cannot contain an inferred column mapping',
    });
  }
  if (proposal.state === 'inferred' && !hasInferred) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: 'inferred proposal requires an inferred column mapping',
    });
  }
}

export const ForgewingColumnMappingProposalSchema = columnMappingProposalSchema.superRefine(
  enforceColumnMappingCoherence,
);

export const ForgewingProposalSchema = z.union([
  ForgewingRegionProposalSchema,
  ForgewingTableContinuationProposalSchema,
  ForgewingColumnMappingProposalSchema,
]);

const regionAbstentionSchema = ForgewingAbstentionSchema.extend({
  taskType: z.literal('region_classification'),
}).strict();

const continuationAbstentionSchema = ForgewingAbstentionSchema.extend({
  taskType: z.literal('table_continuation'),
}).strict();

const columnMappingAbstentionSchema = ForgewingAbstentionSchema.extend({
  taskType: z.literal('column_mapping'),
}).strict();

export const ForgewingRegionProposalBundleSchema = z.object({
  schemaVersion: z.literal(FORGEWING_PROPOSAL_SCHEMA_VERSION),
  authority: z.literal('non_authoritative'),
  run: ForgewingRunIdentitySchema,
  taskId: boundedIdentifier,
  taskType: z.literal('region_classification'),
  proposals: z.array(ForgewingRegionProposalSchema),
  abstentions: z.array(regionAbstentionSchema),
}).strict().superRefine((bundle, context) => {
  if (bundle.proposals.length + bundle.abstentions.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['proposals'],
      message: 'Forgewing bundle must contain at least one proposal or abstention',
    });
  }

  const checkIdentity = (
    item: { taskId: string; taskType: 'region_classification'; extractionSnapshotId: string },
    collection: 'proposals' | 'abstentions',
    index: number,
  ): void => {
    if (item.taskId !== bundle.taskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [collection, index, 'taskId'],
        message: `${collection} taskId must match bundle taskId`,
      });
    }
    if (item.taskType !== bundle.taskType) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [collection, index, 'taskType'],
        message: `${collection} taskType must match bundle taskType`,
      });
    }
    if (item.extractionSnapshotId !== bundle.run.extractionSnapshotId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [collection, index, 'extractionSnapshotId'],
        message: `${collection} extractionSnapshotId must match bundle run`,
      });
    }
  };

  bundle.proposals.forEach((proposal, index) => checkIdentity(proposal, 'proposals', index));
  bundle.abstentions.forEach(
    (abstention, index) => checkIdentity(abstention, 'abstentions', index),
  );
});

export const ForgewingTableContinuationProposalBundleSchema = z.object({
  schemaVersion: z.literal(FORGEWING_TABLE_CONTINUATION_PROPOSAL_SCHEMA_VERSION),
  authority: z.literal('non_authoritative'),
  run: ForgewingRunIdentitySchema,
  taskId: boundedIdentifier,
  taskType: z.literal('table_continuation'),
  proposals: z.array(ForgewingTableContinuationProposalSchema),
  abstentions: z.array(continuationAbstentionSchema),
}).strict().superRefine((bundle, context) => {
  if (bundle.proposals.length + bundle.abstentions.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['proposals'],
      message: 'Forgewing bundle must contain at least one proposal or abstention',
    });
  }
  const items = [
    ...bundle.proposals.map((item, index) => ({ item, collection: 'proposals' as const, index })),
    ...bundle.abstentions.map((item, index) => ({ item, collection: 'abstentions' as const, index })),
  ];
  for (const { item, collection, index } of items) {
    if (item.taskId !== bundle.taskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [collection, index, 'taskId'],
        message: `${collection} taskId must match bundle taskId`,
      });
    }
    if (item.extractionSnapshotId !== bundle.run.extractionSnapshotId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [collection, index, 'extractionSnapshotId'],
        message: `${collection} extractionSnapshotId must match bundle run`,
      });
    }
  }
});

export const ForgewingColumnMappingProposalBundleSchema = z.object({
  schemaVersion: z.literal(FORGEWING_COLUMN_MAPPING_PROPOSAL_SCHEMA_VERSION),
  authority: z.literal('non_authoritative'),
  run: ForgewingRunIdentitySchema,
  taskId: boundedIdentifier,
  taskType: z.literal('column_mapping'),
  proposals: z.array(ForgewingColumnMappingProposalSchema),
  abstentions: z.array(columnMappingAbstentionSchema),
}).strict().superRefine((bundle, context) => {
  if (bundle.proposals.length + bundle.abstentions.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['proposals'],
      message: 'Forgewing bundle must contain at least one proposal or abstention',
    });
  }
  const items = [
    ...bundle.proposals.map((item, index) => ({ item, collection: 'proposals' as const, index })),
    ...bundle.abstentions.map((item, index) => ({ item, collection: 'abstentions' as const, index })),
  ];
  for (const { item, collection, index } of items) {
    if (item.taskId !== bundle.taskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [collection, index, 'taskId'],
        message: `${collection} taskId must match bundle taskId`,
      });
    }
    if (item.extractionSnapshotId !== bundle.run.extractionSnapshotId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [collection, index, 'extractionSnapshotId'],
        message: `${collection} extractionSnapshotId must match bundle run`,
      });
    }
  }
});

export const ForgewingProposalBundleSchema = z.union([
  ForgewingRegionProposalBundleSchema,
  ForgewingTableContinuationProposalBundleSchema,
  ForgewingColumnMappingProposalBundleSchema,
]);

export type ForgewingTaskType = z.infer<typeof ForgewingTaskTypeSchema>;
export type ForgewingProposalState = z.infer<typeof ForgewingProposalStateSchema>;
export type ForgewingRegionLabel = z.infer<typeof ForgewingRegionLabelSchema>;
export type ForgewingTableContinuationRelation = z.infer<
  typeof ForgewingTableContinuationRelationSchema
>;
export type ForgewingTableContinuationRationaleCode = z.infer<
  typeof ForgewingTableContinuationRationaleCodeSchema
>;
export type ForgewingSemanticColumnRole = z.infer<typeof ForgewingSemanticColumnRoleSchema>;
export type ForgewingProposedSemanticColumnRole = z.infer<
  typeof ForgewingProposedSemanticColumnRoleSchema
>;
export type ForgewingColumnMappingRationaleCode = z.infer<
  typeof ForgewingColumnMappingRationaleCodeSchema
>;
export type ForgewingEvidenceRef = z.infer<typeof ForgewingEvidenceRefSchema>;
export type ForgewingMissingEvidence = z.infer<typeof ForgewingMissingEvidenceSchema>;
export type ForgewingRunIdentity = z.infer<typeof ForgewingRunIdentitySchema>;
export type ForgewingAbstentionReason = z.infer<typeof ForgewingAbstentionReasonSchema>;
export type ForgewingAbstention = z.infer<typeof ForgewingAbstentionSchema>;
export type ForgewingProposal = z.infer<typeof ForgewingProposalSchema>;
export type ForgewingRegionProposal = z.infer<typeof ForgewingRegionProposalSchema>;
export type ForgewingTableContinuationProposal = z.infer<
  typeof ForgewingTableContinuationProposalSchema
>;
export type ForgewingColumnMappingEntry = z.infer<typeof ForgewingColumnMappingEntrySchema>;
export type ForgewingColumnMappingProposal = z.infer<
  typeof ForgewingColumnMappingProposalSchema
>;
export type ForgewingRegionProposalBundle = z.infer<
  typeof ForgewingRegionProposalBundleSchema
>;
export type ForgewingTableContinuationProposalBundle = z.infer<
  typeof ForgewingTableContinuationProposalBundleSchema
>;
export type ForgewingColumnMappingProposalBundle = z.infer<
  typeof ForgewingColumnMappingProposalBundleSchema
>;
export type ForgewingProposalBundle = z.infer<typeof ForgewingProposalBundleSchema>;
