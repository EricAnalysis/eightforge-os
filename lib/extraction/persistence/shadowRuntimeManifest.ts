import {
  buildLegacyShadowParserManifest,
  type ParserManifest,
} from '@/lib/extraction/domain/parserManifest';

export function buildRuntimeShadowParserManifest(
  analysisMode: string,
  verificationPolicy: 'step0_gap' | 'step1_span_verified' = 'step0_gap',
): ParserManifest {
  const openAiAvailable =
    typeof process.env.OPENAI_API_KEY === 'string'
    && process.env.OPENAI_API_KEY.trim().length > 0;
  const instructorConfigured = process.env.EIGHTFORGE_INSTRUCTOR_ENABLED !== '0';
  const implementationBuild =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim()
    || process.env.GIT_COMMIT_SHA?.trim()
    || process.env.EIGHTFORGE_BUILD_DIGEST?.trim();
  if (!implementationBuild) {
    throw new Error(
      'VERCEL_GIT_COMMIT_SHA, GIT_COMMIT_SHA, or EIGHTFORGE_BUILD_DIGEST is required for compliance publication',
    );
  }

  return buildLegacyShadowParserManifest({
    analysisMode,
    unstructuredEnabled:
      typeof process.env.UNSTRUCTURED_API_KEY === 'string'
      && process.env.UNSTRUCTURED_API_KEY.trim().length > 0,
    visionEnabled: openAiAvailable,
    typedAiEnabled: instructorConfigured && openAiAvailable,
    implementationBuild,
    unstructured: {
      apiUrl:
        process.env.UNSTRUCTURED_API_URL?.trim()
        || 'https://api.unstructuredapp.io/general/v0/general',
      strategy: process.env.UNSTRUCTURED_PARTITION_STRATEGY?.trim() || 'hi_res',
      splitConcurrency:
        process.env.UNSTRUCTURED_SPLIT_PDF_CONCURRENCY?.trim() || '8',
      timeoutMs: Number(process.env.UNSTRUCTURED_API_TIMEOUT_MS) > 0
        ? Number(process.env.UNSTRUCTURED_API_TIMEOUT_MS)
        : 45_000,
    },
    visionModel: process.env.EIGHTFORGE_VISION_MODEL ?? 'gpt-4o',
    typedAiModel: process.env.EIGHTFORGE_INSTRUCTOR_EXTRACTION_MODEL ?? 'gpt-4o-mini',
    instructorEnabled: instructorConfigured && openAiAvailable,
    instructorMaxRetries: Number(process.env.EIGHTFORGE_INSTRUCTOR_MAX_RETRIES) >= 0
      ? Number(process.env.EIGHTFORGE_INSTRUCTOR_MAX_RETRIES)
      : 2,
    verificationPolicy,
  });
}
