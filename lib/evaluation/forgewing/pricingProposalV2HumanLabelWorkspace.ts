import type {
  ForgewingContributionRole,
  ForgewingSourceFieldRole,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import type { ForgewingPricingSemanticRole } from '@/lib/forgewing/proposal/schema';

export type V2ExpectedSemanticRole = ForgewingPricingSemanticRole;
export type V2ExpectedContributionRole = ForgewingContributionRole;

export const V2_FIELD_LABEL_WORKSPACE_STATE_VERSION =
  'forgewing-pricing-v2-human-label-workspace-state-v1' as const;
export const V2_FIELD_LABEL_WORKSPACE_STORAGE_KEY =
  'eightforge:pricing-v2-human-field-label-review:v1' as const;

export type V2ExpectedInterpretationState =
  | 'observed'
  | 'inferred'
  | 'ambiguous'
  | 'conflicting'
  | 'insufficient_evidence';

export type V2FieldLabelWorkspaceFreezeIdentity = Readonly<{
  phaseBArtifactSha256: string;
  phaseBReportDigestSha256: string;
  implementationCommit: string;
  proposalVersion: string;
  fieldSetDigestSha256: string;
  sourceReplayDigestSha256: string;
  orderingDeterministic: true;
}>;

export type V2FieldLabelPrimitive = Readonly<{
  observationId: string;
  rawText: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  physicalPageNumber: number;
  sourceLayer: string;
  artifactLocalIndex: number | null;
  boundingBox?: Readonly<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    rotation: 0 | 90 | 180 | 270;
  }>;
}>;

export type V2FieldLabelWorkspaceField = Readonly<{
  sourceFieldId: string;
  sourceObservationIds: readonly string[];
  sourceDocumentId: string;
  sourceArtifactId: string;
  physicalPageNumber: number;
  rowObservationId: string;
  sourceFieldRole: ForgewingSourceFieldRole;
  authoredRawTextDisplayOnly: string;
  primitiveEvidence: readonly V2FieldLabelPrimitive[];
}>;

export type V2FieldLabelWorkspaceSession = Readonly<{
  freezeIdentity: V2FieldLabelWorkspaceFreezeIdentity;
  fields: readonly V2FieldLabelWorkspaceField[];
  sourceUrls?: Readonly<Record<string, string>>;
}>;

export type V2ExpectedContributionDraft = Readonly<{
  observationId: string;
  contributionRole: ForgewingContributionRole | '';
}>;

export type V2FieldLabelReviewRecord = Readonly<{
  sourceFieldId: string;
  expectedSemanticRole: ForgewingPricingSemanticRole | '';
  expectedInterpretationState: V2ExpectedInterpretationState | '';
  expectedContributions: readonly V2ExpectedContributionDraft[];
  confirmed: boolean;
}>;

export type V2FieldLabelWorkspaceDraft = Readonly<{
  stateVersion: typeof V2_FIELD_LABEL_WORKSPACE_STATE_VERSION;
  freezeIdentity: V2FieldLabelWorkspaceFreezeIdentity;
  activeSourceFieldId: string;
  records: readonly V2FieldLabelReviewRecord[];
}>;

export type V2FieldLabelWorkspaceProgress = Readonly<{
  total: number;
  complete: number;
  incomplete: number;
  contributionLabels: number;
}>;

const SEMANTIC_ROLES = new Set<string>([
  'category_like_text',
  'description_like_text',
  'unit_like_text',
  'rate_like_amount',
  'quantity_like_amount',
  'item_number_like_text',
  'extended_amount_like_text',
  'unknown',
]);

const INTERPRETATION_STATES = new Set<string>([
  'observed',
  'inferred',
  'ambiguous',
  'conflicting',
  'insufficient_evidence',
]);

const CONTRIBUTION_ROLES = new Set<string>([
  'type_marker',
  'value_token',
  'component_part',
  'semantic_head',
  'semantic_modifier',
  'placeholder_absence',
  'connector',
  'structural_noise',
  'unknown_contribution',
]);

function exactStringRecordEqual(
  expected: V2FieldLabelWorkspaceFreezeIdentity,
  supplied: V2FieldLabelWorkspaceFreezeIdentity,
): boolean {
  return Object.keys(expected).every((key) =>
    expected[key as keyof V2FieldLabelWorkspaceFreezeIdentity]
      === supplied[key as keyof V2FieldLabelWorkspaceFreezeIdentity]);
}

function blankContributions(field: V2FieldLabelWorkspaceField): V2ExpectedContributionDraft[] {
  return field.sourceObservationIds.map((observationId) => ({ observationId, contributionRole: '' }));
}

export function createBlankV2FieldLabelWorkspaceDraft(
  session: V2FieldLabelWorkspaceSession,
): V2FieldLabelWorkspaceDraft {
  return {
    stateVersion: V2_FIELD_LABEL_WORKSPACE_STATE_VERSION,
    freezeIdentity: session.freezeIdentity,
    activeSourceFieldId: session.fields[0]?.sourceFieldId ?? '',
    records: session.fields.map((field) => ({
      sourceFieldId: field.sourceFieldId,
      expectedSemanticRole: '',
      expectedInterpretationState: '',
      expectedContributions: blankContributions(field),
      confirmed: false,
    })),
  };
}

function recordMatchesField(
  record: V2FieldLabelReviewRecord,
  field: V2FieldLabelWorkspaceField,
): boolean {
  if (record.sourceFieldId !== field.sourceFieldId
    || typeof record.confirmed !== 'boolean'
    || !SEMANTIC_ROLES.has(record.expectedSemanticRole)
      && record.expectedSemanticRole !== ''
    || !INTERPRETATION_STATES.has(record.expectedInterpretationState)
      && record.expectedInterpretationState !== ''
    || !Array.isArray(record.expectedContributions)) return false;

  if (record.expectedInterpretationState === 'insufficient_evidence') {
    return record.expectedSemanticRole === 'unknown'
      && record.expectedContributions.length === 0;
  }
  const expected = field.sourceObservationIds;
  return record.expectedContributions.length === expected.length
    && record.expectedContributions.every((contribution, index) =>
      contribution.observationId === expected[index]
      && (contribution.contributionRole === ''
        || CONTRIBUTION_ROLES.has(contribution.contributionRole)));
}

export function restoreV2FieldLabelWorkspaceDraft(params: {
  saved: unknown;
  session: V2FieldLabelWorkspaceSession;
}): Readonly<{ status: 'restored' | 'invalid'; draft: V2FieldLabelWorkspaceDraft }> {
  const blank = createBlankV2FieldLabelWorkspaceDraft(params.session);
  if (!params.saved || typeof params.saved !== 'object' || Array.isArray(params.saved)) {
    return { status: 'invalid', draft: blank };
  }
  const saved = params.saved as Partial<V2FieldLabelWorkspaceDraft>;
  if (saved.stateVersion !== V2_FIELD_LABEL_WORKSPACE_STATE_VERSION
    || !saved.freezeIdentity
    || !exactStringRecordEqual(params.session.freezeIdentity, saved.freezeIdentity)
    || !Array.isArray(saved.records)
    || saved.records.length !== params.session.fields.length) {
    return { status: 'invalid', draft: blank };
  }
  const fieldById = new Map(params.session.fields.map((field) => [field.sourceFieldId, field]));
  const recordIds = new Set(saved.records.map((record) => record.sourceFieldId));
  if (recordIds.size !== fieldById.size
    || [...recordIds].some((sourceFieldId) => !fieldById.has(sourceFieldId))) {
    return { status: 'invalid', draft: blank };
  }
  if (saved.records.some((record) => {
    const field = fieldById.get(record.sourceFieldId);
    return !field || !recordMatchesField(record, field);
  })) return { status: 'invalid', draft: blank };

  const records = params.session.fields.map((field) => saved.records!.find((record) =>
    record.sourceFieldId === field.sourceFieldId)!);
  if (records.some((record, index) => record.confirmed
    && !v2FieldLabelRecordIsReady(records[index]!, params.session.fields[index]!))) {
    return { status: 'invalid', draft: blank };
  }
  return {
    status: 'restored',
    draft: {
      ...blank,
      activeSourceFieldId: fieldById.has(saved.activeSourceFieldId ?? '')
        ? saved.activeSourceFieldId! : blank.activeSourceFieldId,
      records,
    },
  };
}

function updateRecord(
  draft: V2FieldLabelWorkspaceDraft,
  sourceFieldId: string,
  update: (record: V2FieldLabelReviewRecord) => V2FieldLabelReviewRecord,
): V2FieldLabelWorkspaceDraft {
  return {
    ...draft,
    records: draft.records.map((record) =>
      record.sourceFieldId === sourceFieldId ? update(record) : record),
  };
}

export function selectV2FieldLabel(
  draft: V2FieldLabelWorkspaceDraft,
  session: V2FieldLabelWorkspaceSession,
  sourceFieldId: string,
): V2FieldLabelWorkspaceDraft {
  return session.fields.some((field) => field.sourceFieldId === sourceFieldId)
    ? { ...draft, activeSourceFieldId: sourceFieldId } : draft;
}

export function setV2FieldExpectedSemanticRole(params: {
  draft: V2FieldLabelWorkspaceDraft;
  sourceFieldId: string;
  semanticRole: ForgewingPricingSemanticRole | '';
}): V2FieldLabelWorkspaceDraft {
  return updateRecord(params.draft, params.sourceFieldId, (record) => {
    if (record.expectedInterpretationState === 'insufficient_evidence') return record;
    return { ...record, expectedSemanticRole: params.semanticRole, confirmed: false };
  });
}

export function setV2FieldExpectedInterpretationState(params: {
  draft: V2FieldLabelWorkspaceDraft;
  field: V2FieldLabelWorkspaceField;
  interpretationState: V2ExpectedInterpretationState | '';
}): V2FieldLabelWorkspaceDraft {
  return updateRecord(params.draft, params.field.sourceFieldId, (record) => {
    if (params.interpretationState === 'insufficient_evidence') {
      return {
        ...record,
        expectedSemanticRole: 'unknown',
        expectedInterpretationState: 'insufficient_evidence',
        expectedContributions: [],
        confirmed: false,
      };
    }
    return {
      ...record,
      expectedSemanticRole: record.expectedInterpretationState === 'insufficient_evidence'
        ? '' : record.expectedSemanticRole,
      expectedInterpretationState: params.interpretationState,
      expectedContributions: record.expectedInterpretationState === 'insufficient_evidence'
        ? blankContributions(params.field) : record.expectedContributions,
      confirmed: false,
    };
  });
}

export function setV2FieldExpectedContributionRole(params: {
  draft: V2FieldLabelWorkspaceDraft;
  sourceFieldId: string;
  observationId: string;
  contributionRole: ForgewingContributionRole | '';
}): V2FieldLabelWorkspaceDraft {
  return updateRecord(params.draft, params.sourceFieldId, (record) => {
    if (record.expectedInterpretationState === 'insufficient_evidence') return record;
    return {
      ...record,
      expectedContributions: record.expectedContributions.map((contribution) =>
        contribution.observationId === params.observationId
          ? { ...contribution, contributionRole: params.contributionRole }
          : contribution),
      confirmed: false,
    };
  });
}

export function v2FieldLabelRecordIsReady(
  record: V2FieldLabelReviewRecord,
  field: V2FieldLabelWorkspaceField,
): boolean {
  if (record.sourceFieldId !== field.sourceFieldId
    || record.expectedInterpretationState === ''
    || record.expectedSemanticRole === '') return false;
  if (record.expectedInterpretationState === 'insufficient_evidence') {
    return record.expectedSemanticRole === 'unknown'
      && record.expectedContributions.length === 0;
  }
  const expectedIds = field.sourceObservationIds;
  return record.expectedContributions.length === expectedIds.length
    && new Set(record.expectedContributions.map((item) => item.observationId)).size
      === expectedIds.length
    && expectedIds.every((observationId) => record.expectedContributions.some((item) =>
      item.observationId === observationId && item.contributionRole !== ''));
}

export function setV2FieldReviewConfirmed(params: {
  draft: V2FieldLabelWorkspaceDraft;
  field: V2FieldLabelWorkspaceField;
  confirmed: boolean;
}): Readonly<{
  draft: V2FieldLabelWorkspaceDraft;
  error: string | null;
}> {
  const record = params.draft.records.find((item) =>
    item.sourceFieldId === params.field.sourceFieldId);
  if (!record) return { draft: params.draft, error: 'UNKNOWN FIELD' };
  if (params.confirmed && !v2FieldLabelRecordIsReady(record, params.field)) {
    return { draft: params.draft, error: 'FIELD REVIEW INCOMPLETE' };
  }
  return {
    draft: updateRecord(params.draft, params.field.sourceFieldId, (item) => ({
      ...item,
      confirmed: params.confirmed,
    })),
    error: null,
  };
}

export function v2FieldLabelWorkspaceProgress(
  draft: V2FieldLabelWorkspaceDraft,
): V2FieldLabelWorkspaceProgress {
  const complete = draft.records.filter((record) => record.confirmed).length;
  return {
    total: draft.records.length,
    complete,
    incomplete: draft.records.length - complete,
    contributionLabels: draft.records.flatMap((record) => record.expectedContributions)
      .filter((contribution) => contribution.contributionRole !== '').length,
  };
}
