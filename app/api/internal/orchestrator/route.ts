import { NextResponse } from 'next/server';
import { getInternalOrchestratorAccess } from '@/lib/server/internalOrchestratorAccess';
import {
  runOrchestrator,
  type OrchestratorStructuredFields,
} from '@/lib/server/ai/runOrchestrator';
import { writeOrchestratorPromptFile } from '@/lib/server/ai/orchestratorPromptFiles';
import {
  isOrchestratorRootCauseCategoryKey,
  type OrchestratorRootCauseCategoryKey,
} from '@/lib/shared/orchestratorTaxonomy';

const MAX_DIAGNOSTIC_CHARACTERS = 20_000;
const AI_NOT_CONFIGURED_CODE = 'ai_not_configured';
const AI_NOT_CONFIGURED_MESSAGE = 'AI assistance is not configured.';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const secretValues = [
    process.env.ANTHROPIC_API_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  return secretValues.reduce(
    (current, secret) => current.replaceAll(secret, '[redacted]'),
    message,
  );
}

function isAiNotConfiguredError(): boolean {
  return !process.env.ANTHROPIC_API_KEY?.trim();
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse(null, { status: 404 });
  }

  const access = await getInternalOrchestratorAccess(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = await request.json().catch(() => ({}));
  const diagnostic = readString(body?.diagnostic);

  if (!diagnostic) {
    return NextResponse.json({ error: 'diagnostic is required' }, { status: 400 });
  }

  if (diagnostic.length > MAX_DIAGNOSTIC_CHARACTERS) {
    return NextResponse.json(
      { error: `diagnostic must be ${MAX_DIAGNOSTIC_CHARACTERS} characters or fewer` },
      { status: 400 },
    );
  }

  const rawRootCauseCategory = readString(body?.rootCauseCategory);
  if (rawRootCauseCategory && !isOrchestratorRootCauseCategoryKey(rawRootCauseCategory)) {
    return NextResponse.json(
      { error: 'rootCauseCategory must be one of the fixed orchestrator taxonomy keys' },
      { status: 400 },
    );
  }

  const rootCauseCategory = rawRootCauseCategory as OrchestratorRootCauseCategoryKey | undefined;
  const structuredFields: OrchestratorStructuredFields = {
    rootCauseCategory,
    affectedFiles: readString(body?.affectedFiles),
    evidenceLinks: readString(body?.evidenceLinks),
  };

  try {
    const result = await runOrchestrator({ diagnostic, structuredFields });
    const file = await writeOrchestratorPromptFile({
      diagnostic,
      generatedPrompt: result.generatedPrompt,
      model: result.model,
      rootCauseCategory,
      structuredFields,
    });

    return NextResponse.json({
      generatedPrompt: result.generatedPrompt,
      model: result.model,
      filePath: file.relativePath,
    });
  } catch (error) {
    console.error('[internal-orchestrator] generation failed', sanitizeError(error));
    if (isAiNotConfiguredError()) {
      return NextResponse.json(
        { error: AI_NOT_CONFIGURED_MESSAGE, code: AI_NOT_CONFIGURED_CODE },
        { status: 500 },
      );
    }

    return NextResponse.json({ error: 'Failed to generate orchestrator prompt' }, { status: 500 });
  }
}
