import { z } from 'zod';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { PRICED_SCHEDULE_ASSEMBLY_ROLES } from '@/lib/extraction/pdf/pricedScheduleRoles';
import type { PricedScheduleAssemblyRole } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { CustomerHeaderEvidenceBindingSchema, CustomerHeaderSchemaIdentitySchema,
  type CustomerHeaderEvidenceBinding } from '@/lib/customerAdaptation/headerEvidence';

// Reuse the existing runtime allowlist; this increment supports assembly headers
// only, not supporting columns, new roles, unit equivalence or business rules.
const role = z.custom<PricedScheduleAssemblyRole>((value) =>
  typeof value === 'string' && (PRICED_SCHEDULE_ASSEMBLY_ROLES as readonly string[]).includes(value));
const identity = z.string().uuid();
const exactText = z.string().min(1).max(512).refine((value) => value.trim().length > 0);
export const CustomerHeaderMappingScopeSchema = z.object({
  interpretationBoundary: z.literal('priced_schedule_assembly_header'),
  documentType: exactText,
  sourceSchemaIdentity: CustomerHeaderSchemaIdentitySchema,
}).strict();

const envelopeObject = z.object({
  domain: z.literal('eightforge.reviewed-customer-header-mapping'),
  schemaVersion: z.literal(2),
  organizationId: identity,
  revisionId: identity,
  scope: CustomerHeaderMappingScopeSchema,
  mappings: z.array(z.object({
    sourceLabel: exactText,
    targetRole: role,
    supportingEvidence: CustomerHeaderEvidenceBindingSchema,
  }).strict()).max(100),
  humanApproval: z.object({ actorId: identity, approvedAt: z.string().datetime({ offset: true }) }).strict(),
  supersedesRevisionId: identity.nullable(),
}).strict();
function evidenceMatchesEnvelope(value: z.infer<typeof envelopeObject>): boolean {
  return value.mappings.every((mapping) => mapping.supportingEvidence.organizationId === value.organizationId
    && mapping.supportingEvidence.documentType === value.scope.documentType
    && mapping.supportingEvidence.observedHeaderLabel === mapping.sourceLabel
    && mapping.supportingEvidence.sourceSchemaIdentity === value.scope.sourceSchemaIdentity);
}
const envelopeSchema = envelopeObject.refine((value) => value.revisionId !== value.supersedesRevisionId
  && evidenceMatchesEnvelope(value), 'Invalid supersession or evidence scope');

export const ReviewedCustomerHeaderMappingRevisionSchema = envelopeObject.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((value, ctx) => {
  const { digest, ...envelope } = value;
  if (value.revisionId === value.supersedesRevisionId || !evidenceMatchesEnvelope(value) || hashCanonical(envelope) !== digest) {
    ctx.addIssue({ code: 'custom', message: 'Invalid revision identity or digest' });
  }
});

function parseRevision(value: unknown) {
  const parsed = ReviewedCustomerHeaderMappingRevisionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type Envelope = z.infer<typeof envelopeSchema>;
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type ReviewedCustomerHeaderMappingRevision = DeepReadonly<Envelope & { digest: string }>;
export type CustomerHeaderMappingScope = z.infer<typeof CustomerHeaderMappingScopeSchema>;

function immutable<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Contract construction only: approval metadata is declared, not authenticated.
 * No activation or approval authority is granted by constructing this object. */
export function buildReviewedCustomerHeaderMappingRevision(input: Envelope): ReviewedCustomerHeaderMappingRevision {
  const envelope = envelopeSchema.parse(input); // Zod clones; never freeze caller-owned objects.
  return immutable({ ...envelope, digest: hashCanonical(envelope) });
}

type Resolution = Readonly<{
  status: 'unchanged' | 'mapped' | 'review_required' | 'rejected';
  reason: 'no_mapping' | 'exact_match' | 'duplicate_mapping' | 'contradictory_mapping'
    | 'recognition_conflict' | 'invalid_input' | 'invalid_revision' | 'tenant_mismatch' | 'scope_mismatch';
  sourceLabel: string;
  // Unchanged upstream recognition is opaque and may include supporting roles.
  // Only a 'mapped' result creates recognition, from the reused allowlist.
  role: string | null;
  existingRecognition: readonly string[];
  mappingRevisionId: string | null;
  mappingDigest: string | null;
  supportingEvidence: readonly CustomerHeaderEvidenceBinding[];
}>;

/** Pure, exact recognition only. Caller supplies all context, including existing
 * recognition (multiple roles preserve ambiguity). No configuration lookup. */
export function resolveCustomerHeaderMapping(input: Readonly<{
  organizationId: string;
  scope: CustomerHeaderMappingScope;
  mappingRevision: unknown | null;
  observedHeaderLabel: string;
  existingRecognition: readonly string[];
}>): Resolution {
  const base = {
    sourceLabel: input.observedHeaderLabel,
    existingRecognition: [...input.existingRecognition],
    mappingRevisionId: null as string | null,
    mappingDigest: null as string | null,
    supportingEvidence: [] as CustomerHeaderEvidenceBinding[],
  };
  const result = (status: Resolution['status'], reason: Resolution['reason'], resolvedRole: Resolution['role']): Resolution =>
    immutable({ ...base, status, reason, role: resolvedRole });
  if (!identity.safeParse(input.organizationId).success || !CustomerHeaderMappingScopeSchema.safeParse(input.scope).success
    || typeof input.observedHeaderLabel !== 'string'
    || !z.array(z.string().min(1)).safeParse(input.existingRecognition).success) return result('rejected', 'invalid_input', null);
  const unchangedRole = input.existingRecognition.length === 1 ? input.existingRecognition[0]! : null;
  if (input.mappingRevision === null) return result('unchanged', 'no_mapping', unchangedRole);
  const revision = parseRevision(input.mappingRevision);
  if (!revision) return result('rejected', 'invalid_revision', null);
  if (revision.organizationId !== input.organizationId) return result('rejected', 'tenant_mismatch', null);
  if (hashCanonical(revision.scope) !== hashCanonical(input.scope)) return result('rejected', 'scope_mismatch', null);
  base.mappingRevisionId = revision.revisionId;
  base.mappingDigest = revision.digest;

  // Reject ambiguity anywhere in the supplied revision, not just on this label.
  const byLabel = new Map<string, PricedScheduleAssemblyRole>();
  for (const mapping of revision.mappings) {
    const previous = byLabel.get(mapping.sourceLabel);
    if (previous) return result('review_required', previous === mapping.targetRole ? 'duplicate_mapping' : 'contradictory_mapping', null);
    byLabel.set(mapping.sourceLabel, mapping.targetRole);
  }
  const match = revision.mappings.find((mapping) => mapping.sourceLabel === input.observedHeaderLabel);
  if (!match) return result('unchanged', 'no_mapping', unchangedRole);
  base.supportingEvidence = [match.supportingEvidence];
  if (input.existingRecognition.length > 1 || (unchangedRole !== null && unchangedRole !== match.targetRole)) {
    return result('review_required', 'recognition_conflict', null);
  }
  return result('mapped', 'exact_match', match.targetRole);
}
