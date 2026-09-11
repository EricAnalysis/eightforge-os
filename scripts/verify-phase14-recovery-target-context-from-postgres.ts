import { execFileSync } from 'node:child_process';

import { buildRecoveryCandidateV2, type RecoveryCandidateV2 }
  from '@/lib/extraction/recovery/recoveryCandidateV2';
import {
  RECOVERY_PROPOSAL_TABLE,
  RECOVERY_REVIEW_TABLE,
  resolveEffectiveRecoveryConfirmations,
} from '@/lib/server/effectiveRecoveryConfirmations';
import {
  buildDurableRecoveryProposalV2,
  persistForgewingRecoveryProposalV2,
} from '@/lib/server/forgewingRecoveryProposalPersistence';
import { recordForgewingRecoveryProposalReview }
  from '@/lib/server/forgewingRecoveryReview';

/**
 * Phase 14 real-PostgreSQL qualification for the additive target context.
 *
 * This verifier owns a source identity separate from every earlier replay
 * probe. It drives both historical and enriched candidates through the real
 * persistence, review, and resolver seams, then asks PostgreSQL itself to
 * assert SQLSTATE 22023 for a target-context closure violation.
 */

const databaseUrl = process.env.PHASE14_DATABASE_URL;
if (!databaseUrl) throw new Error('PHASE14_DATABASE_URL is required');

function runSql(statement: string): unknown {
  const common = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '--dbname', databaseUrl!];
  const output = process.platform === 'win32'
    ? execFileSync('wsl.exe', [
      '-u', 'root', '-e', '/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/bin/psql', ...common,
    ], { input: statement, encoding: 'utf8' })
    : execFileSync('psql', common, { input: statement, encoding: 'utf8' });
  const text = output.trim();
  return text.length === 0 ? null : JSON.parse(text);
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

const PROPOSAL_RPC = 'record_forgewing_recovery_proposal_v2';
const REVIEW_RPC = 'record_forgewing_recovery_proposal_review_v2';
const allowedTables: ReadonlySet<string> = new Set([
  RECOVERY_PROPOSAL_TABLE,
  RECOVERY_REVIEW_TABLE,
]);

function proposalInvocation(args: Record<string, unknown>): string {
  return `public.${PROPOSAL_RPC}(
    ${literal(args.p_organization_id)}::uuid,
    ${literal(args.p_source_document_id)}::uuid,
    ${literal(args.p_source_artifact_id)}::uuid,
    ${literal(args.p_extraction_snapshot_id)},
    ${Number(args.p_physical_page_number)},
    ${literal(args.p_proposal_id)},
    ${literal(args.p_proposal_digest_sha256)},
    ${literal(args.p_recovery_type)},
    ${literal(args.p_selected_candidate_id)},
    ${literal(args.p_proposed_value)},
    ${literal(args.p_page_representation_digest)},
    ${literal(JSON.stringify(args.p_recovery_candidates))}::jsonb,
    ${Number(args.p_certainty)},
    ${literal(args.p_reason_category)},
    ${literal(args.p_provider_model)},
    ${literal(args.p_prompt_template_id)},
    ${literal(args.p_prompt_template_version)},
    ${literal(args.p_shadow_artifact_path)})`;
}

const admin = {
  async rpc(name: string, args: Record<string, unknown>) {
    try {
      if (name === PROPOSAL_RPC) {
        const row = runSql(`SET ROLE service_role;
          SET request.jwt.claim.role='service_role';
          SELECT row_to_json(result) FROM ${proposalInvocation(args)} AS result;`);
        return { data: row, error: null };
      }
      if (name === REVIEW_RPC) {
        const row = runSql(`SET ROLE service_role;
          SET request.jwt.claim.role='service_role';
          SELECT row_to_json(result) FROM public.${REVIEW_RPC}(
            ${literal(args.p_organization_id)}::uuid,
            ${literal(args.p_proposal_id)},
            ${literal(args.p_proposal_digest_sha256)},
            ${literal(args.p_reviewer_actor_id)}::uuid,
            ${literal(args.p_disposition)},
            ${literal(args.p_confirmed_candidate_id)},
            ${literal(args.p_reviewer_rationale)},
            ${literal(args.p_review_request_digest_sha256)}) AS result;`);
        return { data: row, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    } catch (error) {
      return {
        data: null,
        error: { message: error instanceof Error ? error.message : 'database error' },
      };
    }
  },
  from(table: string) {
    if (!allowedTables.has(table)) throw new Error(`unexpected table ${table}`);
    let selectedColumns = '';
    const filters: string[] = [];
    const chain = {
      select(columns: string) {
        if (!/^[a-z0-9_, ]+$/.test(columns)) throw new Error('unsafe verifier columns');
        selectedColumns = columns;
        return chain;
      },
      eq(column: string, value: unknown) {
        if (!/^[a-z0-9_]+$/.test(column)) throw new Error('unsafe verifier column');
        filters.push(`${column}=${literal(value)}`);
        return chain;
      },
      in(column: string, values: readonly unknown[]) {
        if (!/^[a-z0-9_]+$/.test(column) || values.length === 0) {
          throw new Error('unsafe verifier IN filter');
        }
        filters.push(`${column} IN (${values.map(literal).join(',')})`);
        return chain;
      },
      then<R>(onfulfilled: (value: { data: unknown; error: null }) => R) {
        if (selectedColumns.length === 0) throw new Error('verifier query is missing select');
        const where = filters.length === 0 ? 'TRUE' : filters.join(' AND ');
        const data = runSql(`SELECT coalesce(json_agg(result), '[]'::json)
          FROM (SELECT ${selectedColumns} FROM public.${table} WHERE ${where}) AS result;`);
        return Promise.resolve(onfulfilled({ data, error: null }));
      },
    };
    return chain;
  },
};

const organizationId = 'a1000000-0000-4000-8000-000000000001';
const reviewerActorId = 'a6000000-0000-4000-8000-000000000001';
const sourceDocumentId = 'a2000000-0000-4000-8000-000000000015';
const sourceArtifactId = 'a3000000-0000-4000-8000-000000000015';
const pageRepresentationDigest = '1'.repeat(64);
const physicalPageNumber = 106;

runSql(`SET ROLE postgres;
  INSERT INTO public.documents(id, organization_id, name, storage_path)
  VALUES (${literal(sourceDocumentId)}::uuid, ${literal(organizationId)}::uuid,
    'phase14-target-context.pdf', 'phase14/target-context.pdf');
  INSERT INTO public.extraction_source_artifacts(
    id, organization_id, source_document_id, source_sha256, storage_object_version,
    media_type_sniffed, byte_length, storage_bucket, storage_path, identity_origin)
  VALUES (${literal(sourceArtifactId)}::uuid, ${literal(organizationId)}::uuid,
    ${literal(sourceDocumentId)}::uuid, repeat('2', 64), 'phase14-target-context:1',
    'application/pdf', 1, 'documents', 'phase14/target-context.pdf', 'upload');
  SELECT NULL::json;`);

function requireCandidate(
  input: Parameters<typeof buildRecoveryCandidateV2>[0],
): RecoveryCandidateV2 {
  const built = buildRecoveryCandidateV2(input);
  if (!built) throw new Error(`candidate construction failed for ${input.targetRowIdentity}`);
  return built;
}

const legacy = requireCandidate({
  recoveryType: 'priced_schedule_continuation_attribution',
  sourceDocumentId,
  sourceArtifactId,
  physicalPageNumber,
  pageRepresentationDigest,
  targetRowIdentity: 'page_priced_schedule:p106:r10',
  orderedObservationIds: ['obs:phase14:legacy-fragment'],
  rawTexts: ['Disposal'],
  composedRawText: 'Inert Debris Removal and Disposal',
  evidence: [{
    observationId: 'obs:phase14:legacy-fragment',
    sourceLayer: 'pdf_native_text',
    rawText: 'Disposal',
    boundingBox: { xMin: 72, xMax: 116, yMin: 318, yMax: 329 },
  }],
});

const enriched = requireCandidate({
  recoveryType: 'priced_schedule_continuation_attribution',
  sourceDocumentId,
  sourceArtifactId,
  physicalPageNumber,
  pageRepresentationDigest,
  targetRowIdentity: 'page_priced_schedule:p106:r11',
  orderedObservationIds: ['obs:phase14:enriched-fragment'],
  rawTexts: ['Disposal'],
  composedRawText: 'Vegetative Debris Removal and Disposal',
  evidence: [{
    observationId: 'obs:phase14:enriched-fragment',
    sourceLayer: 'pdf_native_text',
    rawText: 'Disposal',
    boundingBox: { xMin: 74, xMax: 118, yMin: 336, yMax: 347 },
  }],
  targetContextEvidence: {
    targetRowIdentity: 'page_priced_schedule:p106:r11',
    orderedObservationIds: ['obs:phase14:target-description', 'obs:phase14:target-unit'],
    rawTexts: ['Vegetative Debris Removal and', 'CY'],
    composedRawText: 'Vegetative Debris Removal and CY',
    evidence: [
      {
        observationId: 'obs:phase14:target-description',
        sourceLayer: 'pdf_native_text',
        rawText: 'Vegetative Debris Removal and',
        boundingBox: { xMin: 48, xMax: 240, yMin: 330, yMax: 341 },
      },
      {
        observationId: 'obs:phase14:target-unit',
        sourceLayer: 'pdf_native_text',
        rawText: 'CY',
        boundingBox: { xMin: 310, xMax: 326, yMin: 330, yMax: 341 },
      },
    ],
  },
});

async function persistAndAccept(
  candidate: RecoveryCandidateV2,
  snapshot: string,
): Promise<void> {
  const durable = buildDurableRecoveryProposalV2({
    organizationId,
    extractionSnapshotId: snapshot,
    candidates: [candidate],
    selectedCandidateId: candidate.candidateId,
    certainty: 0.84,
    reasonCategory: 'deterministic_continuation_candidate',
    providerModel: 'no-provider-qualification',
    promptTemplateId: 'forgewing.extraction_recovery_v2',
    promptTemplateVersion: 'v2',
  });
  if (!durable) throw new Error(`${snapshot}: durable proposal projection failed`);
  const persisted = await persistForgewingRecoveryProposalV2(durable, { admin });
  if (persisted.status !== 'persisted') {
    throw new Error(`${snapshot}: proposal persistence failed: ${JSON.stringify(persisted)}`);
  }
  const reviewed = await recordForgewingRecoveryProposalReview({
    proposalId: durable.proposalId,
    proposalDigestSha256: durable.proposalDigestSha256,
    disposition: 'accepted',
    confirmedCandidateId: candidate.candidateId,
    reviewerRationale: `${snapshot}: accepted through the real Phase 14 server seam.`,
  }, { actorId: reviewerActorId, organizationId }, { admin });
  if (!reviewed.ok || !reviewed.inserted
    || reviewed.review.confirmedRawText !== candidate.composedRawText) {
    throw new Error(`${snapshot}: proposal review failed`);
  }
}

await persistAndAccept(legacy, 'phase14-legacy-no-context');
await persistAndAccept(enriched, 'phase14-enriched-target-context');

function expectTargetContextRejected22023(
  label: string,
  malformed: Record<string, unknown>,
): void {
  const invalidDigest = Buffer.from(`phase14-${label}`)
    .toString('hex').padEnd(64, '0').slice(0, 64);
  const malformedArgs = {
    p_organization_id: organizationId,
    p_source_document_id: sourceDocumentId,
    p_source_artifact_id: sourceArtifactId,
    p_extraction_snapshot_id: `phase14-${label}`,
    p_physical_page_number: physicalPageNumber,
    p_proposal_id: `forgewing-proposal-recovery-v2-${invalidDigest}`,
    p_proposal_digest_sha256: invalidDigest,
    p_recovery_type: enriched.recoveryType,
    p_selected_candidate_id: enriched.candidateId,
    p_proposed_value: enriched.composedRawText,
    p_page_representation_digest: pageRepresentationDigest,
    p_recovery_candidates: [malformed],
    p_certainty: 0.5,
    p_reason_category: label,
    p_provider_model: 'no-provider-qualification',
    p_prompt_template_id: 'forgewing.extraction_recovery_v2',
    p_prompt_template_version: 'v2',
    p_shadow_artifact_path: null,
  };
  runSql(`SET ROLE service_role;
    SET request.jwt.claim.role='service_role';
    DO $phase14$
    BEGIN
      PERFORM * FROM ${proposalInvocation(malformedArgs)};
      RAISE EXCEPTION '${label} was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN
      NULL;
    END $phase14$;
    SELECT NULL::json;`);
}

expectTargetContextRejected22023('misaligned-target-context', {
  ...enriched,
  targetContextEvidence: {
    ...enriched.targetContextEvidence!,
    rawTexts: ['different target text', 'CY'],
  },
});
expectTargetContextRejected22023('partial-target-context', {
  ...enriched,
  targetContextEvidence: {
    targetRowIdentity: enriched.targetContextEvidence!.targetRowIdentity,
    orderedObservationIds: enriched.targetContextEvidence!.orderedObservationIds,
    rawTexts: enriched.targetContextEvidence!.rawTexts,
    evidence: enriched.targetContextEvidence!.evidence,
  },
});

const resolved = await resolveEffectiveRecoveryConfirmations(
  { organizationId, sourceDocumentId, sourceArtifactId }, { admin },
);
if (resolved.status !== 'ok') throw new Error(`Phase 14 resolver failed: ${resolved.status}`);
const confirmations = resolved.candidateConfirmations ?? [];
const confirmedIds = confirmations
  .map((entry) => entry.confirmedCandidate.candidateId)
  .sort();
if (JSON.stringify(confirmedIds)
  !== JSON.stringify([legacy.candidateId, enriched.candidateId].sort())) {
  throw new Error('resolver did not return exactly the legacy and enriched confirmations');
}
for (const candidate of [legacy, enriched]) {
  const confirmation = confirmations.find((entry) =>
    entry.confirmedCandidate.candidateId === candidate.candidateId);
  if (!confirmation
    || JSON.stringify(confirmation.confirmedCandidate) !== JSON.stringify(candidate)) {
    throw new Error(`${candidate.candidateId}: persisted candidate did not resolve byte-exactly`);
  }
}

process.stdout.write(
  'PHASE 14 RECOVERY TARGET CONTEXT REAL POSTGRESQL QUALIFICATION: PASS\n',
);
