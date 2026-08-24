import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { A3LinkageReviewWorkspace, HumanAttestationPanel } from
  '@/components/evaluation/forgewing/A3LinkageReviewWorkspace';
import { generateForgewingLabelLinkageManifestFromReview, parseForgewingLabelLinkageReviewPacket } from
  '@/lib/evaluation/forgewing/labelledPricingLinkageReview';
import {
  A3_LINKAGE_WORKSPACE_STORAGE_KEY,
  a3WorkspaceDomainReviewInput,
  a3WorkspaceProgress,
  createBlankA3WorkspaceDraft,
  moveA3WorkspaceLabel,
  restoreA3WorkspaceDraft,
  selectA3WorkspaceLabel,
  setA3WorkspaceDecision,
  toggleA3WorkspaceObservation,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace';
import {
  isA3WorkspaceEnabled,
  parseA3WorkspaceAttestationCompletionInput,
  preparedA3AttestationHumanFieldsAreBlank,
  type A3WorkspaceSession,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace.server';

const packet = parseForgewingLabelLinkageReviewPacket(JSON.parse(readFileSync(join(
  process.cwd(), 'scripts', 'evaluation', 'artifacts', 'tdot-a3-linkage-review-packet.json',
), 'utf8')));
const session: A3WorkspaceSession = {
  packet,
  freezeIdentity: createBlankA3WorkspaceDraft(packet).freezeIdentity,
  sourceUrl: '/api/evaluation/forgewing/a3-linkage/source',
};

function linkedDraft() {
  let draft = createBlankA3WorkspaceDraft(packet);
  for (const label of packet.labels) {
    draft = toggleA3WorkspaceObservation({
      draft, labelObservationId: label.label_observation_id,
      observationId: label.modern_pdf_layout_token_observations[0]!.observation_id,
    });
    draft = setA3WorkspaceDecision({
      draft, labelObservationId: label.label_observation_id, decision: 'linked',
    }).draft;
  }
  return draft;
}

describe('visual A3 linkage review workspace', () => {
  it('1. stays disabled without the feature flag and in production', () => {
    expect(isA3WorkspaceEnabled({ nodeEnv: 'development', featureFlag: undefined, host: 'localhost' })).toBe(false);
    expect(isA3WorkspaceEnabled({ nodeEnv: 'production', featureFlag: '1', host: 'localhost' })).toBe(false);
    expect(isA3WorkspaceEnabled({ nodeEnv: 'development', featureFlag: '1', host: 'example.com' })).toBe(false);
    expect(isA3WorkspaceEnabled({ nodeEnv: 'development', featureFlag: '1', host: '127.0.0.1:3000' })).toBe(true);
  });

  it('2. loads the six-label session from the existing packet', () => {
    expect(packet.labels).toHaveLength(6);
    expect(new Set(packet.labels.map((label) => label.candidate_row_id))).toHaveLength(2);
  });

  it('3. displays abbreviated source and extraction identities', () => {
    const html = renderToStaticMarkup(<A3LinkageReviewWorkspace session={session} />);
    expect(html).toContain(packet.source.source_pdf_sha256.slice(0, 12));
    expect(html).toContain(packet.source.extraction_snapshot_id.slice(0, 12));
  });

  it('4. displays the current legacy label value', () => {
    expect(renderToStaticMarkup(<A3LinkageReviewWorkspace session={session} />))
      .toContain(packet.labels[0]!.legacy_labelled_value);
  });

  it('5. displays the packet-derived candidate', () => {
    expect(renderToStaticMarkup(<A3LinkageReviewWorkspace session={session} />))
      .toContain(packet.labels[0]!.candidate_row_id);
  });

  it('6. renders all five candidate observations in the evidence list', () => {
    expect(packet.labels[0]!.modern_pdf_layout_token_observations).toHaveLength(5);
    const html = renderToStaticMarkup(<A3LinkageReviewWorkspace session={session} />);
    for (const observation of packet.labels[0]!.modern_pdf_layout_token_observations) {
      expect(html).toContain(`token-${observation.observation_id}`);
    }
  });

  it('7. starts every label with an empty selection and no decision', () => {
    const draft = createBlankA3WorkspaceDraft(packet);
    expect(draft.records.every((record) => record.selectedObservationIds.length === 0)).toBe(true);
    expect(draft.records.every((record) => record.decision === '')).toBe(true);
  });

  it('8. selecting a token records only its explicit observation id', () => {
    const label = packet.labels[0]!;
    const id = label.modern_pdf_layout_token_observations[0]!.observation_id;
    const draft = toggleA3WorkspaceObservation({
      draft: createBlankA3WorkspaceDraft(packet), labelObservationId: label.label_observation_id,
      observationId: id,
    });
    expect(draft.records[0]!.selectedObservationIds).toEqual([id]);
  });

  it('9. selecting the same token again deselects it', () => {
    const label = packet.labels[0]!;
    const id = label.modern_pdf_layout_token_observations[0]!.observation_id;
    let draft = createBlankA3WorkspaceDraft(packet);
    draft = toggleA3WorkspaceObservation({ draft, labelObservationId: label.label_observation_id, observationId: id });
    draft = toggleA3WorkspaceObservation({ draft, labelObservationId: label.label_observation_id, observationId: id });
    expect(draft.records[0]!.selectedObservationIds).toEqual([]);
  });

  it('10. supports visibly ordered multi-token selection', () => {
    const label = packet.labels[0]!;
    let draft = createBlankA3WorkspaceDraft(packet);
    for (const observation of label.modern_pdf_layout_token_observations.slice(0, 2).reverse()) {
      draft = toggleA3WorkspaceObservation({ draft, labelObservationId: label.label_observation_id, observationId: observation.observation_id });
    }
    expect(draft.records[0]!.selectedObservationIds).toHaveLength(2);
    expect(draft.records[0]!.selectedObservationIds).toEqual([...draft.records[0]!.selectedObservationIds].sort());
  });

  it('11. rejects LINKED with no selected evidence using the required copy', () => {
    const result = setA3WorkspaceDecision({ draft: createBlankA3WorkspaceDraft(packet), labelObservationId: packet.labels[0]!.label_observation_id, decision: 'linked' });
    expect(result.error).toBe('Select at least one source observation supporting this label.');
    expect(result.draft.records[0]!.decision).toBe('');
  });

  it('12. saves LINKED after explicit evidence selection', () => {
    const draft = linkedDraft();
    expect(draft.records.every((record) => record.decision === 'linked')).toBe(true);
  });

  it('13. requires confirmation before NOT LINKABLE clears selected evidence', () => {
    const label = packet.labels[0]!;
    let draft = toggleA3WorkspaceObservation({ draft: createBlankA3WorkspaceDraft(packet), labelObservationId: label.label_observation_id, observationId: label.modern_pdf_layout_token_observations[0]!.observation_id });
    const blocked = setA3WorkspaceDecision({ draft, labelObservationId: label.label_observation_id, decision: 'not_linkable' });
    expect(blocked.confirmationRequired).toBe(true);
    draft = setA3WorkspaceDecision({ draft, labelObservationId: label.label_observation_id, decision: 'not_linkable', clearSelectedEvidence: true }).draft;
    expect(draft.records[0]).toMatchObject({ decision: 'not_linkable', selectedObservationIds: [] });
  });

  it('14. preserves tentative evidence for NEEDS FOLLOW-UP in draft state', () => {
    const label = packet.labels[0]!;
    let draft = toggleA3WorkspaceObservation({ draft: createBlankA3WorkspaceDraft(packet), labelObservationId: label.label_observation_id, observationId: label.modern_pdf_layout_token_observations[0]!.observation_id });
    draft = setA3WorkspaceDecision({ draft, labelObservationId: label.label_observation_id, decision: 'needs_follow_up' }).draft;
    expect(draft.records[0]!.selectedObservationIds).toHaveLength(1);
    expect(a3WorkspaceDomainReviewInput(draft).records[0]!.selected_observation_ids).toEqual([]);
  });

  it('15. updates reviewed and decision progress counts', () => {
    const draft = linkedDraft();
    expect(a3WorkspaceProgress(draft)).toEqual({ total: 6, reviewed: 6, linked: 6, notLinkable: 0, needsFollowUp: 0, unreviewed: 0 });
  });

  it('16. next and previous navigation stay within the packet label order', () => {
    let draft = createBlankA3WorkspaceDraft(packet);
    draft = moveA3WorkspaceLabel(draft, packet, 1);
    expect(draft.activeLabelObservationId).toBe(packet.labels[1]!.label_observation_id);
    draft = moveA3WorkspaceLabel(draft, packet, -1);
    expect(draft.activeLabelObservationId).toBe(packet.labels[0]!.label_observation_id);
  });

  it('17. direct navigation accepts only a packet label id', () => {
    let draft = createBlankA3WorkspaceDraft(packet);
    draft = selectA3WorkspaceLabel(draft, packet, packet.labels[5]!.label_observation_id);
    expect(draft.activeLabelObservationId).toBe(packet.labels[5]!.label_observation_id);
    expect(selectA3WorkspaceLabel(draft, packet, 'foreign-label')).toBe(draft);
  });

  it('18. rejects stale locally saved state across every freeze identity', () => {
    const current = createBlankA3WorkspaceDraft(packet);
    const saved = {
      ...structuredClone(current),
      freezeIdentity: { ...current.freezeIdentity, extractionSnapshotId: 'stale-snapshot' },
    };
    expect(restoreA3WorkspaceDraft({ saved, packet }).status).toBe('invalid');
    expect(A3_LINKAGE_WORKSPACE_STORAGE_KEY).toBe('eightforge:a3-linkage-review:v1');
  });

  it('19. keeps an incomplete review ineligible for a manifest', () => {
    expect(generateForgewingLabelLinkageManifestFromReview({ packet, reviewInput: a3WorkspaceDomainReviewInput(createBlankA3WorkspaceDraft(packet)) }).status).not.toBe('manifest_ready');
  });

  it('20. makes a complete valid explicit review manifest-ready', () => {
    expect(generateForgewingLabelLinkageManifestFromReview({ packet, reviewInput: a3WorkspaceDomainReviewInput(linkedDraft()) }).status).toBe('manifest_ready');
  });

  it('21. manifest creation is delegated to the existing domain generator', () => {
    const result = generateForgewingLabelLinkageManifestFromReview({ packet, reviewInput: a3WorkspaceDomainReviewInput(linkedDraft()) });
    expect(result.manifest?.linkage_version).toBe('forgewing-label-linkage-v1');
    expect(result.manifest?.records).toHaveLength(packet.labels.length);
  });

  it('22. prepared attestation enforcement rejects populated human fields', () => {
    const blank = { reviewer: { stable_handle: '', reviewed_at: '' }, status: '', statement: '', attestation_digest_sha256: '' };
    expect(preparedA3AttestationHumanFieldsAreBlank(blank)).toBe(true);
    expect(preparedA3AttestationHumanFieldsAreBlank({ ...blank, status: 'human_verified' })).toBe(false);
  });

  it.each(['', '   '])('23. rejects an empty reviewer handle %j', (reviewer) => {
    expect(parseA3WorkspaceAttestationCompletionInput({ reviewer, confirmed: true }))
      .toEqual({ ok: false, code: 'REVIEWER_REQUIRED' });
  });

  it('24. rejects missing confirmation', () => {
    expect(parseA3WorkspaceAttestationCompletionInput({ reviewer: 'reviewer' }))
      .toEqual({ ok: false, code: 'VERIFICATION_CONFIRMATION_REQUIRED' });
  });

  it.each(['reviewed_at', 'digest'])('25. rejects browser-supplied %s', (field) => {
    expect(parseA3WorkspaceAttestationCompletionInput({
      reviewer: 'reviewer', confirmed: true, [field]: 'browser-value',
    })).toEqual({ ok: false, code: 'ATTESTATION_VALIDATION_FAILED' });
  });

  it('26. trims reviewer boundary whitespace without changing casing or content', () => {
    expect(parseA3WorkspaceAttestationCompletionInput({
      reviewer: '  Reviewer.Mixed-Case  ', confirmed: true,
    })).toEqual({ ok: true, reviewer: 'Reviewer.Mixed-Case' });
  });

  it('27. renders the prepared panel with blank reviewer, unchecked confirmation, and disabled completion', () => {
    const html = renderToStaticMarkup(<HumanAttestationPanel
      attestation={{
        state: 'prepared',
        statement: 'fixed contract statement',
        preparedArtifactPath: 'local/prepared.json',
      }}
      reviewer=""
      confirmed={false}
      busy={false}
      onReviewerChange={() => undefined}
      onConfirmationChange={() => undefined}
      onComplete={() => undefined}
    />);
    expect(html).toContain('data-testid="human-attestation-panel"');
    expect(html).toContain('value=""');
    expect(html).not.toContain('checked=""');
    expect(html).toContain('COMPLETE HUMAN ATTESTATION');
    expect(html).toContain('disabled=""');
    expect(html).toContain('fixed contract statement');
  });

  it('28. renders a validated completed attestation as evaluation-only and without an A3 action', () => {
    const html = renderToStaticMarkup(<HumanAttestationPanel
      attestation={{
        state: 'completed',
        statement: 'fixed contract statement',
        reviewer: 'reviewer-handle',
        reviewedAt: '2026-08-24T16:20:30.000Z',
        scopeKind: 'SCORING_SUBSET',
        scopeLabelCount: 6,
        linkageManifestSha256: 'a'.repeat(64),
        attestationDigestSha256: 'b'.repeat(64),
        authority: 'evaluation_ground_truth_only',
        promotionAuthorized: false,
      }}
      reviewer=""
      confirmed={false}
      busy={false}
      onReviewerChange={() => undefined}
      onConfirmationChange={() => undefined}
      onComplete={() => undefined}
    />);
    expect(html).toContain('HUMAN ATTESTATION COMPLETE');
    expect(html).toContain('reviewer-handle');
    expect(html).toContain('2026-08-24T16:20:30.000Z');
    expect(html).toContain('SCORING_SUBSET — 6 labels');
    expect(html).toContain('HUMAN VERIFIED — EVALUATION GROUND TRUTH ONLY');
    expect(html).toContain('does not authorize Forgewing promotion or canonical publication');
    expect(html).not.toContain('Run Forgewing');
    expect(html).not.toContain('Run A3');
  });
});
