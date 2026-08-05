import { gzipSync } from 'node:zlib';
import { after } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { ProjectValidatorInput } from '@/lib/validator/shared';
import type {
  ValidationEvidence,
  ValidationFinding,
  ValidationTriggerSource,
  ValidatorResult,
} from '@/types/validator';
import {
  CANONICAL_PROJECT_TRUTH_SCHEMA_VERSION,
  PROJECT_TRUTH_PUBLICATION_SCHEMA_VERSION,
  type ProjectTruthPublicationManifest,
} from './projectTruthPublication';
import {
  buildProjectTruthPublicationIdentity,
  canonicalJson,
  hashCanonicalJson,
  publicationObjectPrefix,
  sha256Hex,
} from './projectTruthPublicationIdentity';
import type { ProjectTruthPublicationSource } from './projectTruthPublicationSource';
import { buildProjectTruthParityReport } from './projectTruthParityReport';
import { adaptProjectTruthPublicationSource } from './projectTruthShadowAdapter';
import {
  writeShadowArtifactParts,
  type ShadowArtifactDestination,
  type ShadowArtifactPart,
} from './shadowArtifactDestination';
import { isCanonicalShadowPublicationEnabled } from './shadowPublicationFlag';

export type CanonicalProjectTruthShadowPublicationInput = {
  readonly projectId: string;
  readonly runId: string;
  readonly triggerSource: ValidationTriggerSource;
  readonly inputsSnapshotHash: string;
  readonly validatorInput: ProjectValidatorInput;
  readonly effectiveResult: ValidatorResult;
  readonly persistedFindings: readonly (ValidationFinding & {
    readonly evidence?: readonly ValidationEvidence[];
  })[];
};

type ValidationRunSnapshot = {
  readonly id: string;
  readonly status: string;
  readonly run_at: string;
  readonly completed_at: string | null;
  readonly triggered_by: string;
  readonly triggered_by_user_id: string | null;
  readonly rule_version: string | null;
  readonly inputs_snapshot_hash: string | null;
};

type PublicationFailureStage = 'source_run' | 'adaptation' | 'destination';

export type PublishProjectTruthShadowResult =
  | { readonly status: 'published' | 'duplicate_suppressed'; readonly publicationId: string; readonly manifestPath: string }
  | { readonly status: 'failed'; readonly stage: PublicationFailureStage; readonly error: string };

export type PublishProjectTruthShadowDependencies = {
  readonly loadValidationRun?: (
    projectId: string,
    runId: string,
  ) => Promise<ValidationRunSnapshot>;
  readonly destination?: Pick<ShadowArtifactDestination, 'writeShadowArtifactParts'>;
  readonly adaptSource?: typeof adaptProjectTruthPublicationSource;
  readonly buildParity?: typeof buildProjectTruthParityReport;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadValidationRun(
  projectId: string,
  runId: string,
): Promise<ValidationRunSnapshot> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');
  const { data, error } = await admin
    .from('project_validation_runs')
    .select('id, status, run_at, completed_at, triggered_by, triggered_by_user_id, rule_version, inputs_snapshot_hash')
    .eq('id', runId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(`Validation run snapshot unavailable: ${error?.message ?? 'run not found'}`);
  }
  return data as ValidationRunSnapshot;
}

function sourceFromInput(input: CanonicalProjectTruthShadowPublicationInput): ProjectTruthPublicationSource {
  return {
    project: input.validatorInput.project,
    documents: input.validatorInput.documents,
    governingDocumentIds: input.validatorInput.governingDocumentIds,
    assembledContractPricingRows: input.validatorInput.assembledContractPricingRows,
    pricingContext: {
      documentId: input.validatorInput.contractValidationContext?.document_id ?? null,
    },
    invoices: input.validatorInput.invoices,
    invoiceLines: input.validatorInput.invoiceLines,
    invoiceLineToRateMap: input.validatorInput.invoiceLineToRateMap,
    transactionData: input.validatorInput.transactionData,
    persistedFindings: input.persistedFindings,
    // This is the immutable snapshot retained during validator-input construction.
    // Publication never queries documents or extraction_source_artifacts.
    sourceArtifactSnapshot: input.validatorInput.sourceArtifactSnapshot,
    effectiveResult: input.effectiveResult,
    // The exact frozen registry that governed validation, when canonical
    // authority was established. Publication derives evidence from this object
    // instead of assembling a competing one.
    authoritativeRegistry: input.validatorInput.projectTruthAuthority?.registry ?? null,
  };
}

function gzipPart(path: string, value: unknown): ShadowArtifactPart {
  const body = new Uint8Array(gzipSync(Buffer.from(canonicalJson(value)), { level: 9 }));
  const expectedByteDigest = sha256Hex(body);
  return {
    path,
    contentType: 'application/json',
    contentEncoding: 'gzip',
    expectedByteDigest,
    bodyFactory: () => ({ body }),
  };
}

function jsonPart(path: string, value: unknown): ShadowArtifactPart {
  const body = new TextEncoder().encode(canonicalJson(value));
  return {
    path,
    contentType: 'application/json',
    expectedByteDigest: sha256Hex(body),
    bodyFactory: () => ({ body }),
  };
}

function gapsPart(path: string, gaps: readonly unknown[]): ShadowArtifactPart {
  const ndjson = gaps.map((gap) => canonicalJson(gap)).join('\n') + (gaps.length > 0 ? '\n' : '');
  const body = new Uint8Array(gzipSync(Buffer.from(ndjson), { level: 9 }));
  return {
    path,
    contentType: 'application/x-ndjson',
    contentEncoding: 'gzip',
    expectedByteDigest: sha256Hex(body),
    bodyFactory: () => ({ body }),
  };
}

function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${stage} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}

function errorCategory(stage: PublicationFailureStage, error: unknown): string {
  const message = errorMessage(error).toLowerCase();
  if (message.includes('timed out')) return 'timeout';
  if (stage === 'source_run') return 'source_unavailable';
  if (stage === 'adaptation') return 'adaptation_error';
  if (message.includes('idempotency_conflict') || message.includes('immutable path')) {
    return 'idempotency_conflict';
  }
  if (
    message.includes('storage_status=404')
    || (message.includes('bucket') && (message.includes('not found') || message.includes('does not exist')))
  ) {
    return 'missing_bucket';
  }
  if (message.includes('unauthorized') || message.includes('forbidden') || message.includes('permission')) {
    return 'access_denied';
  }
  if (message.includes('client is not configured')) return 'client_unavailable';
  if (message.includes('upload')) return 'upload_error';
  if (message.includes('stream') || message.includes('gzip') || message.includes('digest')) {
    return 'stream_error';
  }
  return 'destination_error';
}

function logFailure(params: {
  input: CanonicalProjectTruthShadowPublicationInput;
  stage: PublicationFailureStage;
  error: unknown;
}): PublishProjectTruthShadowResult {
  const message = errorMessage(params.error);
  console.error('[canonicalProjectTruthShadow] publication failed', {
    mode: 'shadow',
    blocking: false,
    projectId: params.input.projectId,
    runId: params.input.runId,
    stage: params.stage,
    errorCategory: errorCategory(params.stage, params.error),
  });
  return { status: 'failed', stage: params.stage, error: message };
}

async function publishProjectTruthShadowInternal(
  input: CanonicalProjectTruthShadowPublicationInput,
  dependencies: PublishProjectTruthShadowDependencies = {},
  controller?: AbortController,
  reportFailure: typeof logFailure = logFailure,
): Promise<PublishProjectTruthShadowResult> {
  const startedAt = Date.now();
  console.info('[canonicalProjectTruthShadow] publication started', {
    mode: 'shadow',
    blocking: false,
    projectId: input.projectId,
    runId: input.runId,
  });
  let run: ValidationRunSnapshot;
  try {
    run = await settleWithin(
      (dependencies.loadValidationRun ?? loadValidationRun)(input.projectId, input.runId),
      5_000,
      'source_run',
    );
    if (run.status !== 'complete' || run.inputs_snapshot_hash !== input.inputsSnapshotHash) {
      throw new Error('Validation run is not the completed source snapshot requested for publication.');
    }
  } catch (error) {
    return reportFailure({ input, stage: 'source_run', error });
  }

  const source = sourceFromInput(input);
  let adapted: ReturnType<typeof adaptProjectTruthPublicationSource>;
  let parity: ReturnType<typeof buildProjectTruthParityReport>;
  try {
    adapted = (dependencies.adaptSource ?? adaptProjectTruthPublicationSource)(source);
    parity = (dependencies.buildParity ?? buildProjectTruthParityReport)({ source, adapted });
  } catch (error) {
    return reportFailure({ input, stage: 'adaptation', error });
  }

  const pipelineVersion = process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.EIGHTFORGE_BUILD_DIGEST
    ?? null;
  const coreContentHash = hashCanonicalJson(adapted.core);
  const registryContentHash = hashCanonicalJson({
    coreContentHash,
    transactionCount: adapted.transactionPlan.count,
    transactionDigest: adapted.transactionPlan.digest,
  });
  const parityContentHash = hashCanonicalJson(parity);
  const gaps = [...adapted.gaps].sort((left, right) => left.gapKey.localeCompare(right.gapKey, 'en-US'));
  const gapContentHash = hashCanonicalJson(gaps);
  const identity = buildProjectTruthPublicationIdentity({
    projectId: input.projectId,
    inputsSnapshotHash: input.inputsSnapshotHash,
    registryContentHash,
    parityContentHash,
    gapContentHash,
    runId: input.runId,
    pipelineVersion,
    canonicalSchemaVersion: CANONICAL_PROJECT_TRUTH_SCHEMA_VERSION,
  });
  const prefix = publicationObjectPrefix({
    projectId: input.projectId,
    runId: input.runId,
    publicationId: identity.publicationId,
  });
  const parts: ShadowArtifactPart[] = [
    gzipPart(`${prefix}registry.core.json.gz`, adapted.core),
    {
      path: `${prefix}registry.transactions.ndjson.gz`,
      contentType: 'application/x-ndjson',
      contentEncoding: 'gzip',
      bodyFactory: () => {
        const transaction = adapted.transactionPlan.createGzipStream();
        return { body: transaction.stream, producerVerification: transaction.verification };
      },
      comparisonDigest: adapted.transactionPlan.digest,
    },
    gzipPart(`${prefix}parity.json.gz`, parity),
    gapsPart(`${prefix}gaps.ndjson.gz`, gaps),
  ];

  try {
    const destination = dependencies.destination?.writeShadowArtifactParts
      ?? writeShadowArtifactParts;
    const result = await settleWithin(destination({
      projectId: input.projectId,
      runId: input.runId,
      publicationId: identity.publicationId,
      parts,
      signal: controller?.signal,
      terminalManifestFactory: (writtenParts) => {
        if (writtenParts.length !== parts.length) {
          throw new Error('Not all canonical sections completed before manifest construction.');
        }
        const gapCounts = Object.fromEntries(gaps.map((gap) => gap.reason).map((reason) => [
          reason,
          gaps.filter((gap) => gap.reason === reason).length,
        ]));
        const sectionDigests = Object.fromEntries(writtenParts.map((part) => [
          part.path.slice(prefix.length),
          part.byteDigest,
        ]));
        const manifest: ProjectTruthPublicationManifest = {
          publicationId: identity.publicationId,
          projectId: input.projectId,
          organizationId: input.validatorInput.project.organization_id,
          sourceRun: {
            runId: run.id,
            runAt: run.run_at,
            completedAt: run.completed_at,
            triggeredBy: run.triggered_by,
            triggeredByUserId: run.triggered_by_user_id,
            ruleVersion: run.rule_version,
            inputsSnapshotHash: input.inputsSnapshotHash,
            rulesApplied: input.effectiveResult.rulesApplied ?? [],
          },
          sourceDocuments: adapted.sourceDocuments,
          pipelineVersion,
          canonicalSchemaVersion: CANONICAL_PROJECT_TRUTH_SCHEMA_VERSION,
          publicationSchemaVersion: PROJECT_TRUTH_PUBLICATION_SCHEMA_VERSION,
          generatedAt: run.completed_at ?? run.run_at,
          inputCounts: adapted.inputCounts,
          outputCounts: adapted.outputCounts,
          status: gaps.length > 0 ? 'partial' : 'complete',
          gapSummary: { counts: gapCounts, silentLossCount: 0 },
          parity: parity.comparisons.map(({ boundary, classification }) => ({ boundary, classification })),
          sectionDigests,
          supersedes: null,
          nonAuthoritative: true,
          mode: 'shadow_only',
          persisted: false,
        };
        return jsonPart(`${prefix}manifest.json`, manifest);
      },
    }), 60_000, 'destination', () => controller?.abort());
    const status = result.status === 'duplicate_suppressed'
      ? 'duplicate_suppressed'
      : 'published';
    console.info('[canonicalProjectTruthShadow] publication complete', {
      mode: 'shadow',
      blocking: false,
      projectId: input.projectId,
      runId: input.runId,
      publicationId: identity.publicationId,
      status,
      manifestPath: `${prefix}manifest.json`,
      gapCount: gaps.length,
      silentLossCount: 0,
      durationMs: Date.now() - startedAt,
      compressedByteCount: result.parts.reduce((sum, part) => sum + part.byteLength, 0),
      compressedSectionByteCounts: Object.fromEntries(result.parts.map((part) => [
        part.path.slice(prefix.length),
        part.byteLength,
      ])),
    });
    return { status, publicationId: identity.publicationId, manifestPath: `${prefix}manifest.json` };
  } catch (error) {
    return reportFailure({ input, stage: 'destination', error });
  }
}

export async function publishProjectTruthShadow(
  input: CanonicalProjectTruthShadowPublicationInput,
  dependencies: PublishProjectTruthShadowDependencies = {},
): Promise<PublishProjectTruthShadowResult> {
  const controller = new AbortController();
  let failureLogged = false;
  const reportFailure = (params: Parameters<typeof logFailure>[0]): PublishProjectTruthShadowResult => {
    if (failureLogged) {
      return { status: 'failed', stage: params.stage, error: errorMessage(params.error) };
    }
    failureLogged = true;
    return logFailure(params);
  };
  try {
    return await settleWithin(
      publishProjectTruthShadowInternal(input, dependencies, controller, reportFailure),
      90_000,
      'whole_publication',
      () => controller.abort(),
    );
  } catch (error) {
    controller.abort();
    return reportFailure({ input, stage: 'destination', error });
  }
}

export function scheduleCanonicalProjectTruthShadowPublication(
  input: CanonicalProjectTruthShadowPublicationInput,
): void {
  // Keep the disabled path synchronous and minimal; do not create a closure that
  // retains the validator input until the flag admits this project.
  if (!isCanonicalShadowPublicationEnabled(
    input.projectId,
    process.env.EIGHTFORGE_CANONICAL_SHADOW_PUBLISH,
    process.env.EIGHTFORGE_CANONICAL_SHADOW_PROJECT_IDS,
  )) return;

  const runDetached = async (): Promise<void> => {
    try {
      await publishProjectTruthShadow(input);
    } catch (error) {
      // Last-resort containment: publishProjectTruthShadow classifies all known
      // stages, and this prevents an unexpected defect from escaping after().
      logFailure({ input, stage: 'destination', error });
    }
  };
  try {
    after(runDetached);
  } catch (error) {
    console.warn('[canonicalProjectTruthShadow] lifecycle registration failed', {
      mode: 'shadow',
      blocking: false,
      projectId: input.projectId,
      runId: input.runId,
      stage: 'lifecycle_registration',
      errorCategory: 'lifecycle_registration_error',
    });
    void runDetached();
  }
}
