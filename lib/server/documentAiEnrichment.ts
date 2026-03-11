// lib/server/documentAiEnrichment.ts
// Placeholder for AI enrichment; full implementation pending OPENAI integration.

export type AiEnrichmentResult = {
  classification: string | null;
  key_clauses: string[];
  pricing_summary: string | null;
  scope_summary: string | null;
  eligibility_risks: string[];
  termination_flags: string[];
  confidence_note: string;
  provider: string;
  enriched_at: string;
};

export async function runAiEnrichment(params: {
  documentMetadata: { id: string; title: string | null; name: string; document_type: string | null };
  extractedText: string | null;
  heuristicFields: Record<string, unknown>;
}): Promise<AiEnrichmentResult> {
  const hasKey = !!process.env.OPENAI_API_KEY;
  return {
    classification: null,
    key_clauses: [],
    pricing_summary: null,
    scope_summary: null,
    eligibility_risks: [],
    termination_flags: [],
    confidence_note: hasKey
      ? 'AI enrichment is configured. Full implementation coming soon.'
      : 'AI enrichment not configured. Set OPENAI_API_KEY to enable.',
    provider: hasKey ? 'openai_pending' : 'none',
    enriched_at: new Date().toISOString(),
  };
}
