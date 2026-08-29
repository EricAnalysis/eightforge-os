import { describe, expect, it } from 'vitest';

import {
  V2_FIELD_LABEL_WORKSPACE_STORAGE_KEY,
  createBlankV2FieldLabelWorkspaceDraft,
  restoreV2FieldLabelWorkspaceDraft,
  setV2FieldExpectedContributionRole,
  setV2FieldExpectedInterpretationState,
  setV2FieldExpectedSemanticRole,
  setV2FieldReviewConfirmed,
  v2FieldLabelRecordIsReady,
  v2FieldLabelWorkspaceProgress,
  type V2FieldLabelWorkspaceSession,
} from '@/lib/evaluation/forgewing/pricingProposalV2HumanLabelWorkspace';

const session: V2FieldLabelWorkspaceSession = {
  freezeIdentity: {
    phaseBArtifactSha256: 'a'.repeat(64),
    phaseBReportDigestSha256: 'b'.repeat(64),
    implementationCommit: 'f13c815b2bdb386353f008f8d56c5622407d8aec',
    proposalVersion: 'forgewing-pricing-interpretation-proposal-v2',
    fieldSetDigestSha256: 'c'.repeat(64),
    sourceReplayDigestSha256: 'd'.repeat(64),
    orderingDeterministic: true,
  },
  fields: [{
    sourceFieldId: 'field-rate',
    sourceObservationIds: ['obs-currency', 'obs-value'],
    sourceDocumentId: 'document-1',
    sourceArtifactId: 'artifact-1',
    physicalPageNumber: 46,
    rowObservationId: 'page_priced_schedule:p46:r31',
    sourceFieldRole: 'rate',
    authoredRawTextDisplayOnly: '$ 1.00',
    primitiveEvidence: [
      { observationId: 'obs-currency', rawText: '$', sourceDocumentId: 'document-1',
        sourceArtifactId: 'artifact-1', physicalPageNumber: 46,
        sourceLayer: 'pdf_native_text', artifactLocalIndex: 1 },
      { observationId: 'obs-value', rawText: '1.00', sourceDocumentId: 'document-1',
        sourceArtifactId: 'artifact-1', physicalPageNumber: 46,
        sourceLayer: 'pdf_native_text', artifactLocalIndex: 1 },
    ],
  }],
};

function completeRateDraft() {
  const field = session.fields[0]!;
  let draft = createBlankV2FieldLabelWorkspaceDraft(session);
  draft = setV2FieldExpectedSemanticRole({
    draft, sourceFieldId: field.sourceFieldId, semanticRole: 'rate_like_amount',
  });
  draft = setV2FieldExpectedInterpretationState({
    draft, field, interpretationState: 'observed',
  });
  draft = setV2FieldExpectedContributionRole({
    draft, sourceFieldId: field.sourceFieldId,
    observationId: 'obs-currency', contributionRole: 'type_marker',
  });
  draft = setV2FieldExpectedContributionRole({
    draft, sourceFieldId: field.sourceFieldId,
    observationId: 'obs-value', contributionRole: 'value_token',
  });
  return draft;
}

describe('V2 human field-label workspace draft', () => {
  it('starts with no semantic or state prefill and no reviewed contributions', () => {
    const draft = createBlankV2FieldLabelWorkspaceDraft(session);
    expect(draft.records[0]).toEqual({
      sourceFieldId: 'field-rate',
      expectedSemanticRole: '',
      expectedInterpretationState: '',
      expectedContributions: [
        { observationId: 'obs-currency', contributionRole: '' },
        { observationId: 'obs-value', contributionRole: '' },
      ],
      confirmed: false,
    });
    expect(V2_FIELD_LABEL_WORKSPACE_STORAGE_KEY)
      .toBe('eightforge:pricing-v2-human-field-label-review:v1');
  });

  it('requires one explicit contribution role for every exact field member', () => {
    const field = session.fields[0]!;
    let draft = completeRateDraft();
    expect(v2FieldLabelRecordIsReady(draft.records[0]!, field)).toBe(true);
    draft = setV2FieldExpectedContributionRole({
      draft, sourceFieldId: field.sourceFieldId,
      observationId: 'obs-value', contributionRole: '',
    });
    expect(v2FieldLabelRecordIsReady(draft.records[0]!, field)).toBe(false);
    expect(setV2FieldReviewConfirmed({ draft, field, confirmed: true })).toMatchObject({
      error: 'FIELD REVIEW INCOMPLETE',
    });
  });

  it('implements abstention policy A with unknown semantics and no contributions', () => {
    const field = session.fields[0]!;
    let draft = completeRateDraft();
    draft = setV2FieldExpectedInterpretationState({
      draft, field, interpretationState: 'insufficient_evidence',
    });
    expect(draft.records[0]).toMatchObject({
      expectedSemanticRole: 'unknown',
      expectedInterpretationState: 'insufficient_evidence',
      expectedContributions: [],
      confirmed: false,
    });
    expect(v2FieldLabelRecordIsReady(draft.records[0]!, field)).toBe(true);
    draft = setV2FieldExpectedInterpretationState({
      draft, field, interpretationState: 'ambiguous',
    });
    expect(draft.records[0]).toMatchObject({
      expectedSemanticRole: '',
      expectedContributions: [
        { observationId: 'obs-currency', contributionRole: '' },
        { observationId: 'obs-value', contributionRole: '' },
      ],
    });
  });

  it('revokes confirmation after semantic, state, or contribution edits', () => {
    const field = session.fields[0]!;
    const confirmed = setV2FieldReviewConfirmed({
      draft: completeRateDraft(), field, confirmed: true,
    }).draft;
    expect(confirmed.records[0]!.confirmed).toBe(true);
    expect(setV2FieldExpectedSemanticRole({ draft: confirmed,
      sourceFieldId: field.sourceFieldId,
      semanticRole: 'quantity_like_amount' }).records[0]!.confirmed).toBe(false);
    expect(setV2FieldExpectedInterpretationState({ draft: confirmed, field,
      interpretationState: 'ambiguous' }).records[0]!.confirmed).toBe(false);
    expect(setV2FieldExpectedContributionRole({ draft: confirmed,
      sourceFieldId: field.sourceFieldId, observationId: 'obs-value',
      contributionRole: 'component_part' }).records[0]!.confirmed).toBe(false);
  });

  it('rejects stale identity and mutated exact membership on restore', () => {
    const saved = completeRateDraft();
    expect(restoreV2FieldLabelWorkspaceDraft({ saved, session }).status).toBe('restored');
    expect(restoreV2FieldLabelWorkspaceDraft({ saved: {
      ...saved,
      freezeIdentity: { ...saved.freezeIdentity, fieldSetDigestSha256: 'e'.repeat(64) },
    }, session }).status).toBe('invalid');
    expect(restoreV2FieldLabelWorkspaceDraft({ saved: {
      ...saved,
      records: [{ ...saved.records[0]!, expectedContributions: [
        { observationId: 'obs-currency', contributionRole: 'type_marker' },
        { observationId: 'foreign-observation', contributionRole: 'value_token' },
      ] }],
    }, session }).status).toBe('invalid');
  });

  it('counts only explicitly confirmed fields and human contribution labels', () => {
    const field = session.fields[0]!;
    const draft = setV2FieldReviewConfirmed({
      draft: completeRateDraft(), field, confirmed: true,
    }).draft;
    expect(v2FieldLabelWorkspaceProgress(draft)).toEqual({
      total: 1, complete: 1, incomplete: 0, contributionLabels: 2,
    });
  });
});
