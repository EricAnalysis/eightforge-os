// lib/server/documentAiEnrichment.ts
// Server-only legacy document AI enrichment, selected per organization.
//
// DISABLED as a provider path (census D4, 2026-10-15). The legacy enrichment
// sent document text to Claude (a hardcoded, unqualified legacy model) or
// OpenAI with no entitlement, no data-policy approval, no durable budget and
// no qualified model. It could not meet that gate chain with a small change:
// OpenAI is not an approvable data-policy provider and the Claude model has
// no qualification evidence. So no provider is called. The organization
// settings and the result shape are kept, so existing payloads and historical
// `ai_enrichment` evidence read unchanged; re-enabling is a governed project
// (qualified model, entitlement, text_excerpts data policy, durable budget).
// Its output was evidence only and never authority (S1).

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

export const LEGACY_ENRICHMENT_DISABLED_NOTE =
  'AI enrichment disabled: the legacy provider path is not governed (no qualified model, data-policy approval or durable budget).';

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

/** Never calls a provider: reports why no enrichment ran. */
export async function runAiEnrichment(params: EnrichmentInput): Promise<AiEnrichmentResult> {
  try {
    const { organizationId } = params;
    if (!organizationId) {
      return { ...makeBase('none'), confidence_note: 'AI enrichment skipped: missing organizationId.' };
    }

    const org = await getOrgConfig(organizationId);
    if (!org) {
      return {
        ...makeBase('error'),
        confidence_note: 'AI enrichment error: unable to load organization AI configuration.',
      };
    }

    if ((org.analysis_mode ?? 'deterministic') !== 'ai_enriched') {
      return { ...makeBase('none'), confidence_note: 'AI enrichment skipped: analysis_mode not ai_enriched.' };
    }
    if ((org.ai_provider ?? 'none') === 'none') {
      return { ...makeBase('none'), confidence_note: 'AI enrichment skipped: ai_provider is none.' };
    }

    // The organization asked for enrichment, but no governed provider path
    // exists: fail closed, auditable in the stored payload.
    console.info('[ai-enrichment] disabled: legacy provider path not governed');
    return { ...makeBase('none'), confidence_note: LEGACY_ENRICHMENT_DISABLED_NOTE };
  } catch (err) {
    return {
      ...makeBase('error'),
      confidence_note: `AI enrichment error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
