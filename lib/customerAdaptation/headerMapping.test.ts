import { describe, expect, it } from 'vitest';
import {
  buildReviewedCustomerHeaderMappingRevision as build,
  resolveCustomerHeaderMapping as resolve,
  ReviewedCustomerHeaderMappingRevisionSchema,
} from './headerMapping';
import { PRICED_SCHEDULE_ASSEMBLY_ROLES } from '@/lib/extraction/pdf/pricedScheduleRoles';

const organizationId = '11111111-1111-4111-8111-111111111111';
const scope = { interpretationBoundary: 'priced_schedule_assembly_header' as const,
  documentType: 'rate_schedule', sourceSchemaIdentity: 'rate-export-v1' };
const envelope = () => ({
  domain: 'eightforge.reviewed-customer-header-mapping' as const, schemaVersion: 1 as const,
  organizationId, revisionId: '22222222-2222-4222-8222-222222222222', scope: { ...scope },
  mappings: [{ sourceLabel: 'Billing Rate', targetRole: 'rate' as const, supportingEvidenceRef: 'verified_field:header-1' }],
  humanApproval: { actorId: '33333333-3333-4333-8333-333333333333', approvedAt: '2026-10-11T12:00:00Z' },
  supersedesRevisionId: null,
});
const request = () => ({ organizationId, scope, mappingRevision: build(envelope()),
  observedHeaderLabel: 'Billing Rate', existingRecognition: [] as (typeof PRICED_SCHEDULE_ASSEMBLY_ROLES)[number][] });

describe('reviewed customer header mapping contract', () => {
  it('reuses every existing assembly role and validates constructed revisions', () => {
    for (const targetRole of PRICED_SCHEDULE_ASSEMBLY_ROLES) {
      const revision = build({ ...envelope(), mappings: [{ ...envelope().mappings[0]!, targetRole }] });
      expect(ReviewedCustomerHeaderMappingRevisionSchema.safeParse(revision).success).toBe(true);
      expect(resolve({ ...request(), mappingRevision: revision }).role).toBe(targetRole);
    }
  });
  it('has deterministic key-order-independent identity and binds evidence, approval, scope and supersession', () => {
    const original = envelope();
    expect(build({ ...original, scope: { sourceSchemaIdentity: scope.sourceSchemaIdentity,
      documentType: scope.documentType, interpretationBoundary: scope.interpretationBoundary } }).digest).toBe(build(original).digest);
    for (const changed of [
      { ...original, mappings: [{ ...original.mappings[0]!, supportingEvidenceRef: 'verified_field:other' }] },
      { ...original, humanApproval: { ...original.humanApproval, approvedAt: '2026-10-12T12:00:00Z' } },
      { ...original, scope: { ...scope, sourceSchemaIdentity: 'v2' } },
      { ...original, supersedesRevisionId: '44444444-4444-4444-8444-444444444444' },
    ]) expect(build(changed).digest).not.toBe(build(original).digest);
  });
  it('maps exact labels, preserving label, evidence and revision for replay', () => {
    const input = request();
    expect(resolve(input)).toMatchObject({ status: 'mapped', role: 'rate', sourceLabel: 'Billing Rate',
      mappingRevisionId: input.mappingRevision.revisionId, mappingDigest: input.mappingRevision.digest,
      supportingEvidenceRefs: ['verified_field:header-1'] });
  });
  it.each(['billing rate', 'Billing Rate ', ' Billing Rate', 'Billing  Rate', 'Billing Rat', 'Billing\nRate'])
    ('does not normalize or fuzzy-match %j', (observedHeaderLabel) => {
      expect(resolve({ ...request(), observedHeaderLabel, existingRecognition: ['description'] }))
        .toMatchObject({ status: 'unchanged', role: 'description', sourceLabel: observedHeaderLabel });
    });
  it('preserves missing, empty and unmatched mapping behavior, including existing ambiguity', () => {
    for (const mappingRevision of [null, build({ ...envelope(), mappings: [] })]) {
      expect(resolve({ ...request(), mappingRevision, existingRecognition: ['rate'] }))
        .toMatchObject({ status: 'unchanged', role: 'rate', existingRecognition: ['rate'] });
      expect(resolve({ ...request(), mappingRevision, existingRecognition: ['rate', 'unit'] }))
        .toMatchObject({ status: 'unchanged', role: null, existingRecognition: ['rate', 'unit'] });
    }
  });
  it('rejects cross-tenant use even when no label matches', () => {
    expect(resolve({ ...request(), organizationId: '44444444-4444-4444-8444-444444444444', observedHeaderLabel: 'Other' }))
      .toMatchObject({ status: 'rejected', reason: 'tenant_mismatch', role: null, mappingRevisionId: null });
  });
  it('rejects mismatched scope and unknown scope properties', () => {
    expect(resolve({ ...request(), scope: { ...scope, sourceSchemaIdentity: 'other' } }).reason).toBe('scope_mismatch');
    expect(resolve({ ...request(), scope: { ...scope, documentType: 'invoice' } }).reason).toBe('scope_mismatch');
    expect(resolve({ ...request(), scope: { ...scope, extra: true } as typeof scope }).reason).toBe('invalid_input');
  });
  it.each(['new_role', 'amount', 'quantity', 'item_code', 'category'])('rejects unsupported target %s', (targetRole) => {
    const revision = { ...request().mappingRevision, mappings: [{ ...envelope().mappings[0], targetRole }] };
    expect(resolve({ ...request(), mappingRevision: revision }).reason).toBe('invalid_revision');
    expect(() => build({ ...envelope(), mappings: revision.mappings } as unknown as Parameters<typeof build>[0])).toThrow();
  });
  it('rejects tampering, unknown fields and self-supersession', () => {
    expect(resolve({ ...request(), mappingRevision: { ...request().mappingRevision, digest: '0'.repeat(64) } }).reason).toBe('invalid_revision');
    expect(resolve({ ...request(), mappingRevision: { ...request().mappingRevision, value: 500 } }).reason).toBe('invalid_revision');
    expect(() => build({ ...envelope(), supersedesRevisionId: envelope().revisionId })).toThrow();
  });
  it.each(['rate', 'unit'] as const)('fails closed on duplicate or contradictory mappings (%s)', (targetRole) => {
    const revision = build({ ...envelope(), mappings: [envelope().mappings[0]!, { ...envelope().mappings[0]!, targetRole }] });
    expect(resolve({ ...request(), mappingRevision: revision, observedHeaderLabel: 'Other' }))
      .toMatchObject({ status: 'review_required', role: null,
        reason: targetRole === 'rate' ? 'duplicate_mapping' : 'contradictory_mapping' });
  });
  it('never chooses a winner over conflicting or ambiguous existing recognition', () => {
    for (const existingRecognition of [['unit'], ['amount'], ['rate', 'unit']] as const) {
      expect(resolve({ ...request(), existingRecognition })).toMatchObject({ status: 'review_required',
        reason: 'recognition_conflict', role: null, existingRecognition });
    }
    expect(resolve({ ...request(), existingRecognition: ['rate'] }).status).toBe('mapped');
    expect(resolve({ ...request(), mappingRevision: null, existingRecognition: ['amount'] }))
      .toMatchObject({ status: 'unchanged', role: 'amount', existingRecognition: ['amount'] });
  });
  it('clones and deeply freezes revision/result without mutating or freezing caller input', () => {
    const original = envelope();
    const before = JSON.stringify(original);
    const revision = build(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(Object.isFrozen(original.scope)).toBe(false);
    expect(Object.isFrozen(revision.mappings[0])).toBe(true);
    const input = { ...request(), mappingRevision: revision, existingRecognition: ['rate'] as const };
    const snapshot = JSON.stringify(input);
    const output = resolve(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(output.existingRecognition)).toBe(true);
  });
});
