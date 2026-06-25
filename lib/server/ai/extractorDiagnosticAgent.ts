// Server-only extractor diagnostic assistant. Generates diagnostic metadata and repair prompts only.

import { getClaudeClient, getClaudeExtractorModel } from '@/lib/server/ai/claudeClient';

export const EXTRACTOR_FAILURE_CLASSIFICATIONS = [
  'OCR failure',
  'table geometry failure',
  'row survival failure',
  'classification failure',
  'normalization failure',
  'canonical projection failure',
  'document relationship traversal failure',
  'UI visibility/filtering failure',
  'insufficient evidence',
] as const;

export const EXTRACTOR_TARGET_AGENTS = [
  'codex',
  'cursor',
  'claude-code',
  'grok',
  'generic',
] as const;

export const EXTRACTOR_REQUESTED_MODES = [
  'phase-a-audit',
  'phase-b-implementation',
  'full-plan',
] as const;

export type ExtractorFailureClassification = (typeof EXTRACTOR_FAILURE_CLASSIFICATIONS)[number];
export type ExtractorTargetAgent = (typeof EXTRACTOR_TARGET_AGENTS)[number];
export type ExtractorRequestedMode = (typeof EXTRACTOR_REQUESTED_MODES)[number];
export type ExtractorConfidence = 'low' | 'medium' | 'high';

export type ExtractorDiagnosticInput = {
  title?: string;
  documentName?: string;
  documentType?: string;
  projectId?: string;
  expectedOutput: unknown;
  actualOutput: unknown;
  rawExtraction?: unknown;
  operatorNotes?: string;
  targetAgent: ExtractorTargetAgent;
  requestedMode: ExtractorRequestedMode;
};

export type ExtractorDiscrepancyRow = {
  expected?: unknown;
  actual?: unknown;
  discrepancy: string;
  evidence?: string;
};

export type ExtractorDiagnosticResult = {
  failureClassification: ExtractorFailureClassification[];
  confidence: ExtractorConfidence;
  discrepancyMatrix: ExtractorDiscrepancyRow[];
  likelyFailingLayer: string;
  evidenceNeeded: string[];
  recommendedMode: ExtractorRequestedMode;
  implementationPrompt: string;
  stopConditions: string[];
  regressionGates: string[];
  prBoundary: string;
  limitations: string[];
};

const OUTPUT_SCHEMA = [
  '{',
  '  "failureClassification": string[],',
  '  "confidence": "low" | "medium" | "high",',
  '  "discrepancyMatrix": [{ "expected": unknown, "actual": unknown, "discrepancy": string, "evidence": string }],',
  '  "likelyFailingLayer": string,',
  '  "evidenceNeeded": string[],',
  '  "recommendedMode": "phase-a-audit" | "phase-b-implementation" | "full-plan",',
  '  "implementationPrompt": string,',
  '  "stopConditions": string[],',
  '  "regressionGates": string[],',
  '  "prBoundary": string,',
  '  "limitations": string[]',
  '}',
].join('\n');

export const EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT = [
  'You are the EightForge Extractor Diagnostic Agent.',
  'You diagnose extraction failures and draft engineering repair prompts only.',
  'You do not extract documents, produce canonical truth, validate business outcomes, execute workflows, mutate data, write code, alter schema, create branches, create commits, or open PRs.',
  '',
  'Governing Law',
  '- Surfaces READ canonical truth; they never PRODUCE it.',
  '- Operator-supplied expectedOutput is the gold review target.',
  '- Never decide expected extraction output on your own.',
  '- Never silently accept AI-proposed expected output as truth.',
  '- If you propose expected output in a limitation or prompt, label it exactly: AI-proposed expected output — requires operator confirmation.',
  '- Never treat AI-proposed expected output as a regression fixture without explicit operator approval.',
  '',
  'Required Expected-vs-Actual Discipline',
  '- Compare expectedOutput against actualOutput directly.',
  '- Identify missing rows/facts, extra rows/facts, mismatched values, category/unit/type errors, projection gaps, and visibility/filtering gaps from the supplied evidence.',
  '- Cite only evidence present in expectedOutput, actualOutput, rawExtraction, or operatorNotes.',
  '- If evidence is insufficient, classify insufficient evidence and name the smallest next evidence needed.',
  '',
  'Failure Classification Taxonomy',
  'Classify into one or more of these exact values and do not invent new labels:',
  ...EXTRACTOR_FAILURE_CLASSIFICATIONS.map((classification) => `- ${classification}`),
  '',
  'Pipeline Layer Diagnosis',
  '- Identify the likely failing pipeline layer and explain why using supplied evidence.',
  '- Keep extractor, normalization, canonical projection, relationship traversal, validator, UI visibility/filtering, and evidence/OCR layers distinct.',
  '- Do not recommend changing extractor logic unless the supplied evidence points there; include it as a stop condition when uncertain.',
  '',
  'Codex-Ready Prompt Requirements',
  '- Write implementationPrompt for the requested targetAgent.',
  '- Follow EightForge Phase A/B/C discipline.',
  '- Phase A - Audit: inspect current code paths, canonical owner, existing tests/fixtures, evidence, and stop conditions.',
  '- Phase B - Implementation: minimal safe change, reuse existing extractor architecture, no duplicate business logic, no schema churn, no dependency churn.',
  '- Phase C - Verification: include regression fixture recommendation, required gates, known invariants, and pass/fail criteria.',
  '- Include stop conditions and PR boundary.',
  '- Protect Williamson CYD 74,617 and Extended Cost $815,559.35 whenever transaction quantity, invoice, ticket, rate, or totals logic is in scope.',
  '',
  'Output Contract',
  'Return STRICT JSON ONLY. No markdown, no backticks, no commentary.',
  'Your JSON must match this schema:',
  OUTPUT_SCHEMA,
].join('\n');

function extractTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
}

function stringifyForPrompt(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return strings.length > 0 ? strings.map((item) => item.trim()) : fallback;
}

function normalizeFailureClassifications(value: unknown): ExtractorFailureClassification[] {
  if (!Array.isArray(value)) return ['insufficient evidence'];
  const allowed = new Set<string>(EXTRACTOR_FAILURE_CLASSIFICATIONS);
  const classifications = value.filter(
    (item): item is ExtractorFailureClassification => typeof item === 'string' && allowed.has(item),
  );
  return classifications.length > 0 ? classifications : ['insufficient evidence'];
}

function normalizeConfidence(value: unknown): ExtractorConfidence {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'low';
}

function normalizeRecommendedMode(value: unknown, requestedMode: ExtractorRequestedMode): ExtractorRequestedMode {
  return EXTRACTOR_REQUESTED_MODES.includes(value as ExtractorRequestedMode)
    ? (value as ExtractorRequestedMode)
    : requestedMode;
}

function normalizeDiscrepancyMatrix(value: unknown): ExtractorDiscrepancyRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((row) => ({
      expected: row.expected,
      actual: row.actual,
      discrepancy: typeof row.discrepancy === 'string' ? row.discrepancy : 'Unspecified discrepancy',
      evidence: typeof row.evidence === 'string' ? row.evidence : undefined,
    }));
}

function normalizeDiagnosticResult(
  raw: unknown,
  fallbackPrompt: string,
  requestedMode: ExtractorRequestedMode,
): ExtractorDiagnosticResult {
  if (!isRecord(raw)) {
    return {
      failureClassification: ['insufficient evidence'],
      confidence: 'low',
      discrepancyMatrix: [],
      likelyFailingLayer: 'Unparseable Claude response',
      evidenceNeeded: ['Retry with structured expectedOutput, actualOutput, and any raw extraction layer evidence.'],
      recommendedMode: requestedMode,
      implementationPrompt: fallbackPrompt,
      stopConditions: ['Stop if Claude output is unstructured or unparseable; do not invent diagnostic fields.'],
      regressionGates: ['Add or update a golden fixture only after operator approval of expected output.'],
      prBoundary: 'Diagnostic prompt only; no schema, data, extraction execution, branch, commit, or PR mutation.',
      limitations: ['Claude returned unstructured output; metadata is conservative and the raw text is preserved as implementationPrompt.'],
    };
  }

  return {
    failureClassification: normalizeFailureClassifications(raw.failureClassification),
    confidence: normalizeConfidence(raw.confidence),
    discrepancyMatrix: normalizeDiscrepancyMatrix(raw.discrepancyMatrix),
    likelyFailingLayer:
      typeof raw.likelyFailingLayer === 'string' && raw.likelyFailingLayer.trim()
        ? raw.likelyFailingLayer.trim()
        : 'Insufficient evidence',
    evidenceNeeded: stringArray(raw.evidenceNeeded, ['Provide raw extraction evidence if layer classification is uncertain.']),
    recommendedMode: normalizeRecommendedMode(raw.recommendedMode, requestedMode),
    implementationPrompt:
      typeof raw.implementationPrompt === 'string' && raw.implementationPrompt.trim()
        ? raw.implementationPrompt.trim()
        : fallbackPrompt,
    stopConditions: stringArray(raw.stopConditions, ['Stop if a schema change or extractor behavior change is required.']),
    regressionGates: stringArray(raw.regressionGates, ['Add or update a regression fixture for the operator-approved expected output.']),
    prBoundary:
      typeof raw.prBoundary === 'string' && raw.prBoundary.trim()
        ? raw.prBoundary.trim()
        : 'Diagnostic prompt only; no schema, data, extraction execution, branch, commit, or PR mutation.',
    limitations: stringArray(raw.limitations, ['Limited to supplied expected-vs-actual evidence.']),
  };
}

export function buildExtractorDiagnosticUserContent(input: ExtractorDiagnosticInput): string {
  return [
    `Title: ${input.title?.trim() || '(none)'}`,
    `Document: ${input.documentName?.trim() || '(none)'}`,
    `Document type: ${input.documentType?.trim() || '(none)'}`,
    `Project id: ${input.projectId?.trim() || '(none)'}`,
    `Target agent: ${input.targetAgent}`,
    `Requested mode: ${input.requestedMode}`,
    '',
    'Operator-supplied expected output (gold target; do not invent or replace):',
    stringifyForPrompt(input.expectedOutput),
    '',
    'EightForge actual output:',
    stringifyForPrompt(input.actualOutput),
    '',
    'Raw extraction layer, if available:',
    input.rawExtraction === undefined ? '(not provided)' : stringifyForPrompt(input.rawExtraction),
    '',
    'Operator notes:',
    input.operatorNotes?.trim() || '(none)',
  ].join('\n');
}

export async function generateExtractorDiagnostic(
  input: ExtractorDiagnosticInput,
): Promise<ExtractorDiagnosticResult> {
  const client = getClaudeClient();
  const model = getClaudeExtractorModel();

  const message = await client.messages.create({
    model,
    temperature: 0,
    max_tokens: 5000,
    system: EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildExtractorDiagnosticUserContent(input),
      },
    ],
  });

  const text = extractTextContent(message.content);
  return normalizeDiagnosticResult(extractJsonObject(text), text, input.requestedMode);
}
