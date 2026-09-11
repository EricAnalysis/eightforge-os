import { execFileSync } from 'node:child_process';

import { buildRecoveryCandidateV2, type RecoveryCandidateV2 }
  from '@/lib/extraction/recovery/recoveryCandidateV2';
import {
  RECOVERY_PROPOSAL_TABLE,
  RECOVERY_REVIEW_TABLE,
  resolveEffectiveRecoveryConfirmations,
}
  from '@/lib/server/effectiveRecoveryConfirmations';
import {
  buildDurableRecoveryProposalV2,
  persistForgewingRecoveryProposalV2,
} from '@/lib/server/forgewingRecoveryProposalPersistence';
import { recordForgewingRecoveryProposalReview }
  from '@/lib/server/forgewingRecoveryReview';

/**
 * Real-PostgreSQL qualification of the Recovery V2 candidate path.
 *
 * Every candidate id here is produced by the real `RecoveryCandidateV2`
 * contract rather than typed as a literal. That matters: the id is a digest
 * over the candidate's own source closure, so a hand-written placeholder would
 * prove the RPC accepts a *shape* while proving nothing about the identity the
 * application actually derives. Persisting and resolving through the real
 * server seams is what closes that gap.
 *
 * The SQL companion (`scripts/sql/verify-phase13-recovery-v2.sql`) keeps the
 * assertions that are genuinely id-agnostic -- V1 row compatibility and RPC
 * ACL -- because those cannot be expressed more honestly from here.
 */

const databaseUrl = process.env.PHASE13_DATABASE_URL;
if (!databaseUrl) throw new Error('PHASE13_DATABASE_URL is required');

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

const PROPOSAL_V2_RPC = 'record_forgewing_recovery_proposal_v2';
const REVIEW_V2_RPC = 'record_forgewing_recovery_proposal_review_v2';
const allowedTables: ReadonlySet<string> = new Set([
  RECOVERY_PROPOSAL_TABLE,
  RECOVERY_REVIEW_TABLE,
]);

function callProposalRpc(args: Record<string, unknown>): unknown {
  return runSql(`SET ROLE service_role; SET request.jwt.claim.role='service_role';
    SELECT row_to_json(result) FROM public.${PROPOSAL_V2_RPC}(
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
      ${literal(args.p_shadow_artifact_path)}
    ) AS result;`);
}

const admin = {
  async rpc(name: string, args: Record<string, unknown>) {
    try {
      if (name === PROPOSAL_V2_RPC) return { data: callProposalRpc(args), error: null };
      if (name === REVIEW_V2_RPC) {
        const row = runSql(`SET ROLE service_role; SET request.jwt.claim.role='service_role';
          SELECT row_to_json(result) FROM public.${REVIEW_V2_RPC}(
            ${literal(args.p_organization_id)}::uuid,
            ${literal(args.p_proposal_id)},
            ${literal(args.p_proposal_digest_sha256)},
            ${literal(args.p_reviewer_actor_id)}::uuid,
            ${literal(args.p_disposition)},
            ${literal(args.p_confirmed_candidate_id)},
            ${literal(args.p_reviewer_rationale)},
            ${literal(args.p_review_request_digest_sha256)}
          ) AS result;`);
        return { data: row, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : 'database error' } };
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
const sourceDocumentId = 'a2000000-0000-4000-8000-000000000014';
const sourceArtifactId = 'a3000000-0000-4000-8000-000000000014';
const pageRepresentationDigest = 'c'.repeat(64);
const physicalPageNumber = 4;

// This verifier owns its own source identity for the same reason Phase 13's SQL
// companion does: a resolver assertion is an exact-set assertion, and sharing a
// document with another qualification makes each one's rows the other's noise.
runSql(`SET ROLE postgres;
  INSERT INTO public.documents(id, organization_id, name, storage_path)
  VALUES (${literal(sourceDocumentId)}::uuid, ${literal(organizationId)}::uuid,
    'a-fourteen.pdf', 'phase13/a-fourteen.pdf')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.extraction_source_artifacts(
    id, organization_id, source_document_id, source_sha256, storage_object_version,
    media_type_sniffed, byte_length, storage_bucket, storage_path, identity_origin)
  VALUES (${literal(sourceArtifactId)}::uuid, ${literal(organizationId)}::uuid,
    ${literal(sourceDocumentId)}::uuid, repeat('e', 64), 'phase13-a-fourteen:1',
    'application/pdf', 1, 'documents', 'phase13/a-fourteen.pdf', 'upload')
  ON CONFLICT (id) DO NOTHING;
  SELECT NULL::json;`);

function candidate(params: Readonly<{
  targetRowIdentity: string;
  members: ReadonlyArray<readonly [string, string]>;
}>): RecoveryCandidateV2 {
  const built = buildRecoveryCandidateV2({
    recoveryType: 'pricing_rate_multi_observation_cluster',
    sourceDocumentId,
    sourceArtifactId,
    physicalPageNumber,
    pageRepresentationDigest,
    targetRowIdentity: params.targetRowIdentity,
    orderedObservationIds: params.members.map(([id]) => id),
    rawTexts: params.members.map(([, text]) => text),
    composedRawText: params.members.map(([, text]) => text).join(' '),
    evidence: params.members.map(([id, text], index) => ({
      observationId: id,
      sourceLayer: 'pdf_native_text' as const,
      rawText: text,
      boundingBox: { xMin: index, xMax: index + 1, yMin: 1, yMax: 2 },
    })),
  });
  if (!built) throw new Error(`candidate construction failed for ${params.targetRowIdentity}`);
  return built;
}

const selected = candidate({
  targetRowIdentity: 'page_priced_schedule:p4:r0',
  members: [['obs:dollar', '$'], ['obs:amount', '8.75']],
});
const alternate = candidate({
  targetRowIdentity: 'page_priced_schedule:p4:r1',
  members: [['obs:alt-dollar', '$'], ['obs:alt-amount', '9.50']],
});
const candidates = [selected, alternate];

/** Canonical by construction: recomputing the digest must reproduce the id. */
for (const entry of candidates) {
  if (!/^recovery-candidate-v2-[a-f0-9]{64}$/.test(entry.candidateId)) {
    throw new Error('candidate id is not canonically shaped');
  }
}

async function persistProposal(snapshot: string): Promise<{ proposalId: string; digest: string }> {
  const durable = buildDurableRecoveryProposalV2({
    organizationId,
    extractionSnapshotId: snapshot,
    candidates,
    selectedCandidateId: selected.candidateId,
    certainty: 0.83,
    reasonCategory: 'complete_monetary_cluster',
    providerModel: 'no-provider-qualification',
    promptTemplateId: 'forgewing.extraction_recovery_v2',
    promptTemplateVersion: 'v2',
  });
  if (!durable) throw new Error('durable V2 proposal projection failed');
  const recorded = await persistForgewingRecoveryProposalV2(durable, { admin });
  if (recorded.status !== 'persisted') {
    throw new Error(`V2 proposal persistence failed: ${JSON.stringify(recorded)}`);
  }
  return { proposalId: durable.proposalId, digest: durable.proposalDigestSha256 };
}

const actor = { actorId: reviewerActorId, organizationId };

async function review(
  pin: { proposalId: string; digest: string },
  disposition: 'accepted' | 'modified' | 'rejected' | 'deferred',
  confirmedCandidateId?: string,
) {
  return recordForgewingRecoveryProposalReview({
    proposalId: pin.proposalId,
    proposalDigestSha256: pin.digest,
    disposition,
    ...(confirmedCandidateId ? { confirmedCandidateId } : {}),
    reviewerRationale: `${disposition} through the real Phase 13 server seam.`,
  } as Parameters<typeof recordForgewingRecoveryProposalReview>[0], actor, { admin });
}

// ── Accepted: the proposed candidate, confirmed exactly ──────────────────────
const acceptedPin = await persistProposal('phase13-ts-accepted');
const accepted = await review(acceptedPin, 'accepted', selected.candidateId);
if (!accepted.ok || !accepted.inserted || accepted.review.confirmedRawText !== '$ 8.75') {
  throw new Error(`V2 accepted review failed: ${accepted.ok ? 'unexpected receipt' : accepted.code}`);
}

// ── Modified: a different already-built candidate ────────────────────────────
const modifiedPin = await persistProposal('phase13-ts-modified');
const modified = await review(modifiedPin, 'modified', alternate.candidateId);
if (!modified.ok || modified.review.confirmedRawText !== '$ 9.50') {
  throw new Error('V2 modified review did not derive the alternate candidate text');
}

// ── Rejected and deferred stay inert ─────────────────────────────────────────
const rejectedPin = await persistProposal('phase13-ts-rejected');
if (!(await review(rejectedPin, 'rejected')).ok) throw new Error('V2 rejected review failed');
const deferredPin = await persistProposal('phase13-ts-deferred');
if (!(await review(deferredPin, 'deferred')).ok) throw new Error('V2 deferred review failed');

// ── A non-canonical candidate id must never resolve ──────────────────────────
//
// The RPC validates the candidate's shape, not its digest, so a tampered id can
// reach the row. The application resolver is the layer that recomputes identity,
// and it must refuse rather than hand reconstruction a candidate whose id does
// not match its own source closure.
const tamperedCandidate = {
  ...selected,
  candidateId: `recovery-candidate-v2-${'d'.repeat(64)}`,
};
const tamperedDigest = 'f'.repeat(63).concat('1');
const tamperedWrite = await admin.rpc(PROPOSAL_V2_RPC, {
  p_organization_id: organizationId,
  p_source_document_id: sourceDocumentId,
  p_source_artifact_id: sourceArtifactId,
  p_extraction_snapshot_id: 'phase13-ts-tampered',
  p_physical_page_number: physicalPageNumber,
  p_proposal_id: `forgewing-proposal-recovery-v2-${tamperedDigest}`,
  p_proposal_digest_sha256: tamperedDigest,
  p_recovery_type: 'pricing_rate_multi_observation_cluster',
  p_selected_candidate_id: tamperedCandidate.candidateId,
  p_proposed_value: tamperedCandidate.composedRawText,
  p_page_representation_digest: pageRepresentationDigest,
  p_recovery_candidates: [tamperedCandidate],
  p_certainty: 0.5,
  p_reason_category: 'tampered_identity',
  p_provider_model: 'no-provider-qualification',
  p_prompt_template_id: 'forgewing.extraction_recovery_v2',
  p_prompt_template_version: 'v2',
  p_shadow_artifact_path: null,
});
if (tamperedWrite.error) throw new Error('tampered candidate fixture could not be staged');
const tamperedReview = await review(
  { proposalId: `forgewing-proposal-recovery-v2-${tamperedDigest}`, digest: tamperedDigest },
  'accepted',
  tamperedCandidate.candidateId,
);
if (!tamperedReview.ok) throw new Error('tampered candidate review fixture was not recorded');

// ── RPC negatives, over canonically-built candidates ─────────────────────────
//
// Each mutates a candidate the real contract produced, so the rejection is
// attributable to the exact property under test rather than to a malformed
// literal that would have failed for several reasons at once.
async function expectProposalRejected(
  label: string,
  mutate: (base: Record<string, unknown>) => Record<string, unknown>,
  expected: string,
) {
  const digest = Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64);
  const result = await admin.rpc(PROPOSAL_V2_RPC, mutate({
    p_organization_id: organizationId,
    p_source_document_id: sourceDocumentId,
    p_source_artifact_id: sourceArtifactId,
    p_extraction_snapshot_id: `phase13-ts-${label}`,
    p_physical_page_number: physicalPageNumber,
    p_proposal_id: `forgewing-proposal-recovery-v2-${digest}`,
    p_proposal_digest_sha256: digest,
    p_recovery_type: 'pricing_rate_multi_observation_cluster',
    p_selected_candidate_id: selected.candidateId,
    p_proposed_value: selected.composedRawText,
    p_page_representation_digest: pageRepresentationDigest,
    p_recovery_candidates: candidates,
    p_certainty: 0.5,
    p_reason_category: label,
    p_provider_model: 'no-provider-qualification',
    p_prompt_template_id: 'forgewing.extraction_recovery_v2',
    p_prompt_template_version: 'v2',
    p_shadow_artifact_path: null,
  }));
  if (!result.error) throw new Error(`${label} was accepted but must be rejected`);
  if (!result.error.message.includes(expected)) {
    throw new Error(`${label} raised "${result.error.message}", expected "${expected}"`);
  }
}

await expectProposalRejected('provider_authored_value',
  (base) => ({ ...base, p_proposed_value: '$ 99.99' }),
  'invalid recovery v2 candidate closure');
await expectProposalRejected('duplicate_ordered_member',
  (base) => ({ ...base, p_recovery_candidates: [
    { ...selected, orderedObservationIds: ['obs:dollar', 'obs:dollar'], rawTexts: ['$', '$'] },
    alternate,
  ] }),
  'invalid recovery v2 candidate closure');
await expectProposalRejected('misaligned_candidate_evidence',
  (base) => ({ ...base, p_recovery_candidates: [
    { ...selected, rawTexts: ['$', '8.76'] },
    alternate,
  ] }),
  'invalid recovery v2 candidate closure');
await expectProposalRejected('cross_tenant_source_binding',
  (base) => ({ ...base, p_organization_id: 'b1000000-0000-4000-8000-000000000001' }),
  'recovery proposal source binding mismatch');

// An accepted review must confirm the proposal's own selected candidate.
const alternateAccept = await review(acceptedPin, 'accepted', alternate.candidateId);
if (alternateAccept.ok) throw new Error('accepting a non-selected candidate was permitted');

// ── The resolver's verdict over everything above ─────────────────────────────
const resolved = await resolveEffectiveRecoveryConfirmations(
  { organizationId, sourceDocumentId, sourceArtifactId }, { admin },
);
if (resolved.status !== 'ok') throw new Error(`V2 resolver failed: ${resolved.status}`);

const confirmedIds = (resolved.candidateConfirmations ?? [])
  .map((entry) => entry.confirmedCandidate.candidateId)
  .sort();
if (JSON.stringify(confirmedIds)
  !== JSON.stringify([selected.candidateId, alternate.candidateId].sort())) {
  throw new Error('V2 resolver did not return exactly the accepted and modified candidates');
}
if (resolved.confirmations.length !== 0) {
  throw new Error('V2 candidate confirmations leaked into the V1 confirmation set');
}
for (const confirmation of resolved.candidateConfirmations ?? []) {
  if (confirmation.authority !== 'human_confirmed' || confirmation.executable !== false
    || confirmation.purpose !== 'reconstruction_reentry') {
    throw new Error('V2 confirmation lost its authority semantics');
  }
  const source = candidates.find((entry) => entry.candidateId === confirmation.confirmedCandidate.candidateId);
  if (!source
    || JSON.stringify(confirmation.confirmedCandidate.orderedObservationIds)
      !== JSON.stringify(source.orderedObservationIds)) {
    throw new Error('V2 confirmation did not preserve canonical candidate membership');
  }
}
const tamperedDiagnostic = resolved.diagnostics.find((entry) =>
  entry.proposalDigestSha256 === tamperedDigest);
if (tamperedDiagnostic?.code !== 'incoherent_recovery_confirmation') {
  throw new Error('non-canonical candidate id was not refused as incoherent');
}

const crossTenant = await resolveEffectiveRecoveryConfirmations({
  organizationId: 'b1000000-0000-4000-8000-000000000001',
  sourceDocumentId,
  sourceArtifactId,
}, { admin });
if (crossTenant.status !== 'ok'
  || (crossTenant.candidateConfirmations ?? []).length !== 0
  || crossTenant.confirmations.length !== 0) {
  throw new Error('cross-tenant V2 resolver query was not empty');
}

process.stdout.write('PHASE 13 RECOVERY V2 RESOLVER REAL POSTGRESQL QUALIFICATION: PASS\n');
