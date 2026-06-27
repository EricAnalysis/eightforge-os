import { NextResponse } from 'next/server';
import {
  EXTRACTOR_REQUESTED_MODES,
  EXTRACTOR_TARGET_AGENTS,
  generateExtractorDiagnostic,
  type ExtractorDiagnosticInput,
  type ExtractorRequestedMode,
  type ExtractorTargetAgent,
} from '@/lib/server/ai/extractorDiagnosticAgent';

export const runtime = 'nodejs';

const MAX_PAYLOAD_CHARACTERS = 60_000;
const AI_NOT_CONFIGURED_CODE = 'ai_not_configured';
const AI_NOT_CONFIGURED_MESSAGE = 'AI assistance is not configured.';
const JSON_RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isTargetAgent(value: unknown): value is ExtractorTargetAgent {
  return EXTRACTOR_TARGET_AGENTS.includes(value as ExtractorTargetAgent);
}

function isRequestedMode(value: unknown): value is ExtractorRequestedMode {
  return EXTRACTOR_REQUESTED_MODES.includes(value as ExtractorRequestedMode);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const secretValues = [process.env.ANTHROPIC_API_KEY].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return secretValues.reduce((current, secret) => current.replaceAll(secret, '[redacted]'), message);
}

function isAiNotConfiguredError(): boolean {
  return !process.env.ANTHROPIC_API_KEY?.trim();
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...init?.headers,
      ...JSON_RESPONSE_HEADERS,
    },
  });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > MAX_PAYLOAD_CHARACTERS) {
    return jsonResponse(
      { error: `Payload must be ${MAX_PAYLOAD_CHARACTERS} characters or fewer` },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isRecord(body)) {
    return jsonResponse({ error: 'Body must be a JSON object' }, { status: 400 });
  }

  if (!hasValue(body.expectedOutput)) {
    return jsonResponse({ error: 'expectedOutput is required' }, { status: 400 });
  }

  if (!hasValue(body.actualOutput)) {
    return jsonResponse({ error: 'actualOutput is required' }, { status: 400 });
  }

  if (!isTargetAgent(body.targetAgent)) {
    return jsonResponse(
      { error: `targetAgent must be one of: ${EXTRACTOR_TARGET_AGENTS.join(', ')}` },
      { status: 400 },
    );
  }

  if (!isRequestedMode(body.requestedMode)) {
    return jsonResponse(
      { error: `requestedMode must be one of: ${EXTRACTOR_REQUESTED_MODES.join(', ')}` },
      { status: 400 },
    );
  }

  const input: ExtractorDiagnosticInput = {
    title: readOptionalString(body.title),
    documentName: readOptionalString(body.documentName),
    documentType: readOptionalString(body.documentType),
    projectId: readOptionalString(body.projectId),
    expectedOutput: body.expectedOutput,
    actualOutput: body.actualOutput,
    rawExtraction: body.rawExtraction,
    operatorNotes: readOptionalString(body.operatorNotes),
    targetAgent: body.targetAgent,
    requestedMode: body.requestedMode,
  };

  try {
    const diagnostic = await generateExtractorDiagnostic(input);
    return jsonResponse(diagnostic);
  } catch (error) {
    console.error('[extractor-diagnostics] generation failed', sanitizeError(error));
    if (isAiNotConfiguredError()) {
      return jsonResponse(
        { error: AI_NOT_CONFIGURED_MESSAGE, code: AI_NOT_CONFIGURED_CODE },
        { status: 500 },
      );
    }
    return jsonResponse({ error: 'Failed to generate extractor diagnostic' }, { status: 500 });
  }
}
