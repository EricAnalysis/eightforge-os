import type { SupabaseClient } from '@supabase/supabase-js';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  STEP0_ENTITY_RESOLVER_VERSION,
  STEP0_INTERPRETER_MANIFEST_HASH,
} from '@/lib/complianceFoundation/shadowVersions';

export {
  STEP0_ENTITY_RESOLVER_VERSION,
  STEP0_INTERPRETER_MANIFEST_HASH,
} from '@/lib/complianceFoundation/shadowVersions';

export type FreshnessAuditCode =
  | 'STALE_EXTRACTION_SNAPSHOT'
  | 'MISSING_EXTRACTION_SNAPSHOT'
  | 'UNSUPPORTED_ARTIFACT_SCHEMA'
  | 'EXTRACTION_GAP'
  | 'INTERPRETATION_SNAPSHOT_MISMATCH';

export const SUPPORTED_EXTRACTION_ARTIFACT_SCHEMA_VERSIONS =
  new Set(['extraction-artifact-v1'] as const);

export interface FreshnessAuditInput {
  readonly sourceDocumentId: string;
  readonly currentSourceArtifactId: string | null;
  readonly assignedSourceArtifactId: string | null;
  readonly currentSourceSha256: string | null;
  readonly desiredParserManifestHash: string | null;
  readonly desiredArtifactSchemaVersion: string | null;
  readonly activationMode: 'shadow' | 'fresh_only' | null;
  readonly extractionSnapshot: {
    readonly id: string;
    readonly sourceArtifactId: string;
    readonly sourceSha256: string;
    readonly parserManifestHash: string;
    readonly artifactSchemaVersion: string;
    readonly status: 'complete' | 'partial';
    readonly invalidated: boolean;
    readonly dependencyRootValid: boolean;
    readonly hasGapMember: boolean;
  } | null;
  readonly interpretationSnapshot: {
    readonly id: string;
    readonly extractionSnapshotId: string;
    readonly status: 'complete' | 'partial' | 'blocked';
    readonly interpreterManifestHash: string;
    readonly entityResolverVersion: string;
  } | null;
}

export interface FreshnessAuditResult {
  readonly sourceDocumentId: string;
  readonly mode: 'shadow';
  readonly fresh: boolean;
  readonly codes: readonly FreshnessAuditCode[];
  readonly expected: {
    readonly sourceArtifactId: string | null;
    readonly sourceSha256: string | null;
    readonly parserManifestHash: string | null;
    readonly artifactSchemaVersion: string | null;
  };
  readonly actual: {
    readonly extractionSnapshotId: string | null;
    readonly sourceArtifactId: string | null;
    readonly sourceSha256: string | null;
    readonly parserManifestHash: string | null;
    readonly artifactSchemaVersion: string | null;
    readonly interpretationSnapshotId: string | null;
  };
}

export function evaluateFreshnessShadow(input: FreshnessAuditInput): FreshnessAuditResult {
  const codes = new Set<FreshnessAuditCode>();
  const snapshot = input.extractionSnapshot;
  if (!snapshot || !input.currentSourceArtifactId || !input.desiredParserManifestHash) {
    codes.add('MISSING_EXTRACTION_SNAPSHOT');
  } else {
    if (
      snapshot.invalidated
      || !snapshot.dependencyRootValid
      || input.assignedSourceArtifactId !== input.currentSourceArtifactId
      || snapshot.sourceArtifactId !== input.currentSourceArtifactId
      || snapshot.sourceSha256 !== input.currentSourceSha256
      || snapshot.parserManifestHash !== input.desiredParserManifestHash
    ) {
      codes.add('STALE_EXTRACTION_SNAPSHOT');
    }
    if (
      snapshot.artifactSchemaVersion !== input.desiredArtifactSchemaVersion
      || !SUPPORTED_EXTRACTION_ARTIFACT_SCHEMA_VERSIONS.has(
        snapshot.artifactSchemaVersion as 'extraction-artifact-v1',
      )
      || !SUPPORTED_EXTRACTION_ARTIFACT_SCHEMA_VERSIONS.has(
        input.desiredArtifactSchemaVersion as 'extraction-artifact-v1',
      )
    ) {
      codes.add('UNSUPPORTED_ARTIFACT_SCHEMA');
    }
    if (snapshot.status !== 'complete' || snapshot.hasGapMember) {
      codes.add('EXTRACTION_GAP');
    }
    if (
      !input.interpretationSnapshot
      || input.interpretationSnapshot.extractionSnapshotId !== snapshot.id
      || input.interpretationSnapshot.status !== 'complete'
      || input.interpretationSnapshot.interpreterManifestHash !== STEP0_INTERPRETER_MANIFEST_HASH
      || input.interpretationSnapshot.entityResolverVersion !== STEP0_ENTITY_RESOLVER_VERSION
    ) {
      codes.add('INTERPRETATION_SNAPSHOT_MISMATCH');
    }
  }

  return {
    sourceDocumentId: input.sourceDocumentId,
    mode: 'shadow',
    fresh: codes.size === 0,
    codes: [...codes],
    expected: {
      sourceArtifactId: input.currentSourceArtifactId,
      sourceSha256: input.currentSourceSha256,
      parserManifestHash: input.desiredParserManifestHash,
      artifactSchemaVersion: input.desiredArtifactSchemaVersion,
    },
    actual: {
      extractionSnapshotId: snapshot?.id ?? null,
      sourceArtifactId: snapshot?.sourceArtifactId ?? null,
      sourceSha256: snapshot?.sourceSha256 ?? null,
      parserManifestHash: snapshot?.parserManifestHash ?? null,
      artifactSchemaVersion: snapshot?.artifactSchemaVersion ?? null,
      interpretationSnapshotId: input.interpretationSnapshot?.id ?? null,
    },
  };
}

function asRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

async function queryRows(
  query: PromiseLike<{ data: unknown; error: { message?: string } | null }>,
  label: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message ?? 'unknown database error'}`);
  return asRows(data);
}

export async function auditProjectFreshnessShadow(
  admin: SupabaseClient,
  projectId: string,
): Promise<readonly FreshnessAuditResult[]> {
  const projects = await queryRows(
    admin.from('projects').select('organization_id').eq('id', projectId).limit(1),
    'load project organization for freshness shadow',
  );
  const organizationId =
    typeof projects[0]?.organization_id === 'string'
      ? projects[0].organization_id
      : null;
  if (!organizationId) return [];
  const documents = await queryRows(
    admin
      .from('documents')
      .select('id')
      .eq('project_id', projectId)
      .eq('organization_id', organizationId),
    'load project documents for freshness shadow',
  );
  const documentIds = documents.map((document) => String(document.id));
  if (documentIds.length === 0) return [];

  const [sources, assignments] = await Promise.all([
    queryRows(
      admin
        .from('extraction_source_artifacts')
        .select('id, source_document_id, source_sha256, created_at')
        .eq('organization_id', organizationId)
        .in('source_document_id', documentIds)
        .order('created_at', { ascending: false }),
      'load current source artifacts for freshness shadow',
    ),
    queryRows(
      admin
        .from('document_extraction_snapshot_assignments')
        .select(
          'source_document_id, source_artifact_id, desired_parser_manifest_hash, artifact_schema_version, extraction_snapshot_id, activation_mode',
        )
        .eq('organization_id', organizationId)
        .in('source_document_id', documentIds),
      'load extraction assignments for freshness shadow',
    ),
  ]);

  const currentSourceByDocument = new Map<string, Record<string, unknown>>();
  for (const source of sources) {
    const documentId = String(source.source_document_id);
    if (!currentSourceByDocument.has(documentId)) currentSourceByDocument.set(documentId, source);
  }
  const assignmentByDocument = new Map(
    assignments.map((assignment) => [String(assignment.source_document_id), assignment]),
  );
  const extractionSnapshotIds = assignments
    .map((assignment) => assignment.extraction_snapshot_id)
    .filter((id): id is string => typeof id === 'string');

  const snapshots = extractionSnapshotIds.length > 0
    ? await queryRows(
        admin
          .from('extraction_snapshots')
          .select(
            'id, source_artifact_id, source_sha256, parser_manifest_hash, artifact_schema_version, status, artifact_root_hash',
          )
          .eq('organization_id', organizationId)
          .in('id', extractionSnapshotIds),
        'load extraction snapshots for freshness shadow',
      )
    : [];
  const snapshotById = new Map(snapshots.map((snapshot) => [String(snapshot.id), snapshot]));
  const members = extractionSnapshotIds.length > 0
    ? await queryRows(
        admin
          .from('extraction_snapshot_members')
          .select(
            'extraction_snapshot_id, member_kind, dependency_hash, sequence, processing_gap_id',
          )
          .eq('organization_id', organizationId)
          .in('extraction_snapshot_id', extractionSnapshotIds)
          .order('sequence', { ascending: true }),
        'load extraction snapshot dependency members for freshness shadow',
      )
    : [];
  const membersBySnapshot = new Map<string, Array<Record<string, unknown>>>();
  for (const member of members) {
    const snapshotId = String(member.extraction_snapshot_id);
    const existing = membersBySnapshot.get(snapshotId) ?? [];
    existing.push(member);
    membersBySnapshot.set(snapshotId, existing);
  }
  const gapIds = members
    .map((member) => member.processing_gap_id)
    .filter((id): id is string => typeof id === 'string');
  const gaps = gapIds.length > 0
    ? await queryRows(
        admin
          .from('extraction_processing_gaps')
          .select('id, gap_key, page, stage, reason, retryable, attempts, detail')
          .eq('organization_id', organizationId)
          .in('id', gapIds),
        'load extraction gaps for freshness dependency verification',
      )
    : [];
  const gapById = new Map(gaps.map((gap) => [String(gap.id), gap]));
  const invalidations = extractionSnapshotIds.length > 0
    ? await queryRows(
        admin
          .from('extraction_snapshot_invalidations')
          .select('extraction_snapshot_id')
          .eq('organization_id', organizationId)
          .in('extraction_snapshot_id', extractionSnapshotIds),
        'load extraction invalidations for freshness shadow',
      )
    : [];
  const invalidatedIds = new Set(invalidations.map((row) => String(row.extraction_snapshot_id)));
  const interpretations = extractionSnapshotIds.length > 0
    ? await queryRows(
        admin
          .from('document_interpretation_snapshots')
          .select(
            'id, extraction_snapshot_id, status, published_at, interpreter_manifest_hash, entity_resolver_version',
          )
          .eq('organization_id', organizationId)
          .in('extraction_snapshot_id', extractionSnapshotIds)
          .order('published_at', { ascending: false }),
        'load interpretation snapshots for freshness shadow',
      )
    : [];
  const interpretationByExtraction = new Map<string, Record<string, unknown>>();
  for (const interpretation of interpretations) {
    const snapshotId = String(interpretation.extraction_snapshot_id);
    if (!interpretationByExtraction.has(snapshotId)) {
      interpretationByExtraction.set(snapshotId, interpretation);
    }
  }

  return documentIds.map((sourceDocumentId) => {
    const source = currentSourceByDocument.get(sourceDocumentId) ?? null;
    const assignment = assignmentByDocument.get(sourceDocumentId) ?? null;
    const snapshotId =
      typeof assignment?.extraction_snapshot_id === 'string'
        ? assignment.extraction_snapshot_id
        : null;
    const snapshot = snapshotId ? snapshotById.get(snapshotId) ?? null : null;
    const interpretation = snapshotId
      ? interpretationByExtraction.get(snapshotId) ?? null
      : null;
    return evaluateFreshnessShadow({
      sourceDocumentId,
      currentSourceArtifactId: source ? String(source.id) : null,
      assignedSourceArtifactId:
        typeof assignment?.source_artifact_id === 'string'
          ? assignment.source_artifact_id
          : null,
      currentSourceSha256: source ? String(source.source_sha256) : null,
      desiredParserManifestHash:
        typeof assignment?.desired_parser_manifest_hash === 'string'
          ? assignment.desired_parser_manifest_hash
          : null,
      desiredArtifactSchemaVersion:
        typeof assignment?.artifact_schema_version === 'string'
          ? assignment.artifact_schema_version
          : null,
      activationMode:
        assignment?.activation_mode === 'shadow' || assignment?.activation_mode === 'fresh_only'
          ? assignment.activation_mode
          : null,
      extractionSnapshot: snapshot
        ? {
            id: String(snapshot.id),
            sourceArtifactId: String(snapshot.source_artifact_id),
            sourceSha256: String(snapshot.source_sha256),
            parserManifestHash: String(snapshot.parser_manifest_hash),
            artifactSchemaVersion: String(snapshot.artifact_schema_version),
            status: snapshot.status === 'complete' ? 'complete' : 'partial',
            invalidated: invalidatedIds.has(String(snapshot.id)),
            dependencyRootValid: (() => {
              const orderedMembers = membersBySnapshot.get(String(snapshot.id)) ?? [];
              if (orderedMembers.length === 0) return false;
              const dependenciesValid = orderedMembers.every((member) => {
                if (member.member_kind !== 'gap' || typeof member.processing_gap_id !== 'string') {
                  // Step 0 publishes only explicitly unresolved legacy gaps.
                  // Future complete artifact kinds stay stale until their
                  // content-hash verifier is added before live activation.
                  return false;
                }
                const gap = gapById.get(member.processing_gap_id);
                if (!gap) return false;
                return String(member.dependency_hash) === hashCanonical({
                  gap_key: String(gap.gap_key),
                  page: gap.page == null ? null : Number(gap.page),
                  stage: String(gap.stage),
                  reason: String(gap.reason),
                  retryable: Boolean(gap.retryable),
                  attempts: Number(gap.attempts),
                  detail: String(gap.detail),
                });
              });
              if (!dependenciesValid) return false;
              return String(snapshot.artifact_root_hash) === hashCanonical({
                artifact_schema_version: String(snapshot.artifact_schema_version),
                members: orderedMembers.map((member) => ({
                  kind: String(member.member_kind),
                  dependency_hash: String(member.dependency_hash),
                })),
              });
            })(),
            hasGapMember: (membersBySnapshot.get(String(snapshot.id)) ?? [])
              .some((member) => member.member_kind === 'gap'),
          }
        : null,
      interpretationSnapshot: interpretation
        ? {
            id: String(interpretation.id),
            extractionSnapshotId: String(interpretation.extraction_snapshot_id),
            status:
              interpretation.status === 'complete'
                ? 'complete'
                : interpretation.status === 'partial'
                  ? 'partial'
                : 'blocked',
            interpreterManifestHash: String(interpretation.interpreter_manifest_hash),
            entityResolverVersion: String(interpretation.entity_resolver_version),
          }
        : null,
    });
  });
}
