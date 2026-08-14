import { z } from 'zod';

import { FORGEWING_PROPOSAL_SCHEMA_VERSION } from '@/lib/forgewing/proposal/schemaVersion';

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

/** Forgewing v0 is intentionally scoped to one task; new tasks require schema evolution. */
export const ForgewingTaskTypeSchema = z.literal('region_classification');

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

const evidenceReferences = (minimum: number) => z.array(ForgewingEvidenceRefSchema)
  .min(minimum)
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
  taskType: ForgewingTaskTypeSchema,
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

const proposalSchema = z.discriminatedUnion('state', [
  observedProposalSchema,
  inferredProposalSchema,
  ambiguousProposalSchema,
  unresolvedProposalSchema,
  conflictingProposalSchema,
  insufficientEvidenceProposalSchema,
]);

type ProposalWithEvidence = z.infer<typeof proposalSchema>;

function enforceProposalProvenanceCoherence(
  proposal: ProposalWithEvidence,
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

export const ForgewingProposalSchema = proposalSchema.superRefine(
  enforceProposalProvenanceCoherence,
);

export const ForgewingProposalBundleSchema = z.object({
  schemaVersion: z.literal(FORGEWING_PROPOSAL_SCHEMA_VERSION),
  authority: z.literal('non_authoritative'),
  run: ForgewingRunIdentitySchema,
  taskId: boundedIdentifier,
  taskType: ForgewingTaskTypeSchema,
  proposals: z.array(ForgewingProposalSchema),
  abstentions: z.array(ForgewingAbstentionSchema),
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

export type ForgewingTaskType = z.infer<typeof ForgewingTaskTypeSchema>;
export type ForgewingProposalState = z.infer<typeof ForgewingProposalStateSchema>;
export type ForgewingRegionLabel = z.infer<typeof ForgewingRegionLabelSchema>;
export type ForgewingEvidenceRef = z.infer<typeof ForgewingEvidenceRefSchema>;
export type ForgewingMissingEvidence = z.infer<typeof ForgewingMissingEvidenceSchema>;
export type ForgewingRunIdentity = z.infer<typeof ForgewingRunIdentitySchema>;
export type ForgewingAbstentionReason = z.infer<typeof ForgewingAbstentionReasonSchema>;
export type ForgewingAbstention = z.infer<typeof ForgewingAbstentionSchema>;
export type ForgewingProposal = z.infer<typeof ForgewingProposalSchema>;
export type ForgewingProposalBundle = z.infer<typeof ForgewingProposalBundleSchema>;
