// lib/server/documentAiEnrichment.ts
// Server-only document AI enrichment with provider selection per-organization.

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export type AiEnrichmentResult = {
  classification: string | null;
  key_clauses: string[];
  pricing_summary: string | null;
  scope_summary: string | null;
  eligibility_risks: string[];
  termination_flags: string[];
  confidence_note: string | null;
  provider: 'claude' | 'openai' | 'openai_mini' | 'gemini' | 'none' | 'error';
  enriched_at: string;
};

type OrgAnalysisMode = 'disabled' | 'deterministic' | 'ai_enriched';
type OrgAiProvider = 'none' | 'claude' | 'openai' | 'openai_mini' | 'gemini';

type EnrichmentInput = {
  organizationId: string;
  documentMetadata: { id: string; title: string | null; name: string; document_type: string | null };
  extractedText: string | null;
  heuristicFields: Record<string, unknown>;
};

function makeBase(provider: AiEnrichmentResult['provider']): AiEnrichmentResult {
  return {
    classification: null,
    key_clauses: [],
    pricing_summary: null,
    scope_summary: null,
    eligibility_risks: [],
    termination_flags: [],
    confidence_note: null,
    provider,
    enriched_at: new Date().toISOString(),
  };
}

function clampString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
}

function normalizeStringArray(value: unknown, opts: { maxItems: number; maxItemLen: number }): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = clampString(v, opts.maxItemLen);
    if (s) out.push(s);
    if (out.length >= opts.maxItems) break;
  }
  return out;
}

function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Try to recover a JSON object embedded in extra text.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = text.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeModelOutput(raw: unknown): Omit<AiEnrichmentResult, 'provider' | 'enriched_at'> {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    classification: clampString(obj.classification, 200),
    key_clauses: normalizeStringArray(obj.key_clauses, { maxItems: 40, maxItemLen: 500 }),
    pricing_summary: clampString(obj.pricing_summary, 2000),
    scope_summary: clampString(obj.scope_summary, 2000),
    eligibility_risks: normalizeStringArray(obj.eligibility_risks, { maxItems: 40, maxItemLen: 500 }),
    termination_flags: normalizeStringArray(obj.termination_flags, { maxItems: 40, maxItemLen: 500 }),
    confidence_note: clampString(obj.confidence_note, 1000),
  };
}

function buildPrompt(params: EnrichmentInput) {
  const text = clampString(params.extractedText, 12000);
  const title = clampString(params.documentMetadata.title, 200) ?? null;
  const name = clampString(params.documentMetadata.name, 200) ?? null;
  const documentType = clampString(params.documentMetadata.document_type, 200) ?? null;

  return [
    `You are an AI assistant performing contract/document enrichment for operational signals.`,
    `Return STRICT JSON ONLY (no markdown, no backticks, no commentary).`,
    `Your JSON MUST match this schema exactly:`,
    `{`,
    `  "classification": string | null,`,
    `  "key_clauses": string[],`,
    `  "pricing_summary": string | null,`,
    `  "scope_summary": string | null,`,
    `  "eligibility_risks": string[],`,
    `  "termination_flags": string[],`,
    `  "confidence_note": string | null`,
    `}`,
    ``,
    `Guidance: identify operationally relevant contract/document signals including: document type/category, eligibility risks, termination/remedy language, pricing/rate structure summary, scope summary, and important clauses. Keep outputs concise and actionable.`,
    ``,
    `Document metadata:`,
    `- id: ${params.documentMetadata.id}`,
    `- title: ${title ?? '(none)'}`,
    `- name: ${name ?? '(none)'}`,
    `- document_type: ${documentType ?? '(none)'}`,
    ``,
    `Extracted text (may be truncated; if missing, infer from metadata + heuristic fields):`,
    text ?? '(no extracted text provided)',
    ``,
    `Heuristic fields (JSON, may be empty):`,
    JSON.stringify(params.heuristicFields ?? {}),
  ].join('\n');
}

async function getOrgConfig(organizationId: string): Promise<{
  analysis_mode: OrgAnalysisMode | null;
  ai_provider: OrgAiProvider | null;
} | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from('organizations')
    .select('analysis_mode, ai_provider')
    .eq('id', organizationId)
    .single();

  if (error || !data) return null;
  return {
    analysis_mode: (data.analysis_mode ?? null) as OrgAnalysisMode | null,
    ai_provider: (data.ai_provider ?? null) as OrgAiProvider | null,
  };
}

async function runClaudeEnrichment(params: EnrichmentInput): Promise<AiEnrichmentResult> {
  const base = makeBase('claude');
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return { ...base, confidence_note: 'AI enrichment skipped: ANTHROPIC_API_KEY is not set.' };
    }

    const client = new Anthropic({ apiKey: key });
    const prompt = buildPrompt(params);

    const res = await client.messages.create({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 800,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n')
      .trim();

    const parsed = typeof text === 'string' ? extractJsonObject(text) : null;
    const normalized = normalizeModelOutput(parsed);

    if (!parsed) {
      console.warn('[ai-enrichment] claude: JSON parse failed; using normalized defaults');
      return {
        ...base,
        ...normalized,
        confidence_note:
          normalized.confidence_note ??
          'AI enrichment: Claude returned non-JSON output; normalized to safe defaults.',
      };
    }

    return { ...base, ...normalized };
  } catch (e) {
    console.error('[ai-enrichment] claude: provider call failed:', e);
    return {
      ...base,
      confidence_note: `AI enrichment error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function runOpenAiEnrichment(params: EnrichmentInput): Promise<AiEnrichmentResult> {
  const base = makeBase('openai');
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return { ...base, confidence_note: 'AI enrichment skipped: OPENAI_API_KEY is not set.' };
    }

    const client = new OpenAI({ apiKey: key });
    const prompt = buildPrompt(params);

    const res = await client.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Return STRICT JSON ONLY that matches the requested schema.',
        },
        { role: 'user', content: prompt },
      ],
    });

    const content = res.choices?.[0]?.message?.content ?? '';
    const parsed = typeof content === 'string' ? extractJsonObject(content) : null;
    const normalized = normalizeModelOutput(parsed);

    if (!parsed) {
      console.warn('[ai-enrichment] openai: JSON parse failed; using normalized defaults');
      return {
        ...base,
        ...normalized,
        confidence_note:
          normalized.confidence_note ??
          'AI enrichment: OpenAI returned non-JSON output; normalized to safe defaults.',
      };
    }

    return { ...base, ...normalized };
  } catch (e) {
    console.error('[ai-enrichment] openai: provider call failed:', e);
    return {
      ...base,
      confidence_note: `AI enrichment error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function runOpenAiMiniEnrichment(params: EnrichmentInput): Promise<AiEnrichmentResult> {
  const base = makeBase('openai_mini');
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return { ...base, confidence_note: 'AI enrichment skipped: OPENAI_API_KEY is not set.' };
    }

    const client = new OpenAI({ apiKey: key });
    const prompt = buildPrompt(params);

    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Return STRICT JSON ONLY that matches the requested schema.',
        },
        { role: 'user', content: prompt },
      ],
    });

    const content = res.choices?.[0]?.message?.content ?? '';
    const parsed = typeof content === 'string' ? extractJsonObject(content) : null;
    const normalized = normalizeModelOutput(parsed);

    if (!parsed) {
      console.warn('[ai-enrichment] openai_mini: JSON parse failed; using normalized defaults');
      return {
        ...base,
        ...normalized,
        confidence_note:
          normalized.confidence_note ??
          'AI enrichment: OpenAI mini returned non-JSON output; normalized to safe defaults.',
      };
    }

    return { ...base, ...normalized };
  } catch (e) {
    console.error('[ai-enrichment] openai_mini: provider call failed:', e);
    return {
      ...base,
      confidence_note: `AI enrichment error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function runGeminiEnrichmentStub(_params: EnrichmentInput): Promise<AiEnrichmentResult> {
  const base = makeBase('gemini');
  const hasKey = !!process.env.GEMINI_API_KEY;
  return {
    ...base,
    confidence_note: hasKey
      ? 'Gemini integration not implemented yet.'
      : 'Gemini integration not implemented yet (GEMINI_API_KEY not set).',
  };
}

export async function runAiEnrichment(params: EnrichmentInput): Promise<AiEnrichmentResult> {
  try {
    const { organizationId } = params;
    if (!organizationId) {
      console.warn('[ai-enrichment] skipped: missing organizationId');
      return { ...makeBase('none'), confidence_note: 'AI enrichment skipped: missing organizationId.' };
    }

    const org = await getOrgConfig(organizationId);
    if (!org) {
      console.warn('[ai-enrichment] skipped: unable to load org config');
      return {
        ...makeBase('error'),
        confidence_note: 'AI enrichment error: unable to load organization AI configuration.',
      };
    }

    const analysisMode = org.analysis_mode ?? 'deterministic';
    const provider = org.ai_provider ?? 'none';

    if (analysisMode !== 'ai_enriched') {
      console.info('[ai-enrichment] skipped: analysis_mode not ai_enriched');
      return { ...makeBase('none'), confidence_note: 'AI enrichment skipped: analysis_mode not ai_enriched.' };
    }

    if (provider === 'none') {
      console.info('[ai-enrichment] skipped: ai_provider none');
      return { ...makeBase('none'), confidence_note: 'AI enrichment skipped: ai_provider is none.' };
    }

    console.info('[ai-enrichment] provider selected:', provider);

    switch (provider) {
      case 'claude':
        return await runClaudeEnrichment(params);
      case 'openai':
        return await runOpenAiEnrichment(params);
      case 'openai_mini':
        return await runOpenAiMiniEnrichment(params);
      case 'gemini':
        return await runGeminiEnrichmentStub(params);
      default:
        console.warn('[ai-enrichment] skipped: unknown ai_provider');
        return { ...makeBase('none'), confidence_note: 'AI enrichment skipped: unknown ai_provider.' };
    }
  } catch (err) {
    return {
      classification: null,
      key_clauses: [],
      pricing_summary: null,
      scope_summary: null,
      eligibility_risks: [],
      termination_flags: [],
      confidence_note: `AI enrichment error: ${err instanceof Error ? err.message : String(err)}`,
      provider: 'error',
      enriched_at: new Date().toISOString(),
    };
  }
}
