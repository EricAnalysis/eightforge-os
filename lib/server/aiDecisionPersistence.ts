// lib/server/aiDecisionPersistence.ts
// Persists AI enrichment results to decision_detections, including one fallback row when AI fails or returns only an error.

export type AiEnrichmentResult = {
  classification: string | null;
  key_clauses: string[];
  pricing_summary: string | null;
  scope_summary: string | null;
  eligibility_risks: string[];
  termination_flags: string[];
  confidence_note: string | null;
  provider: string;
  enriched_at: string;
};

export type PersistAiEnrichmentDecisionsArgs = {
  supabase: any;
  organizationId: string;
  documentId: string;
  jobId: string;
  enrichment: AiEnrichmentResult;
};

export async function persistAiEnrichmentDecisions({
  supabase,
  organizationId,
  documentId,
  jobId,
  enrichment,
}: PersistAiEnrichmentDecisionsArgs): Promise<{
  inserted: number;
  skipped: boolean;
  error?: string;
}> {
  try {
    const metadata = {
      provider: enrichment.provider,
      enriched_at: enrichment.enriched_at,
      classification: enrichment.classification,
      pricing_summary: enrichment.pricing_summary,
      scope_summary: enrichment.scope_summary,
      key_clauses: enrichment.key_clauses,
      eligibility_risks: enrichment.eligibility_risks,
      termination_flags: enrichment.termination_flags,
      confidence_note: enrichment.confidence_note,
      job_id: jobId,
      document_id: documentId,
    };

    const hasRealSignals =
      !!enrichment.classification ||
      enrichment.key_clauses.length > 0 ||
      !!enrichment.pricing_summary ||
      !!enrichment.scope_summary ||
      enrichment.eligibility_risks.length > 0 ||
      enrichment.termination_flags.length > 0;

    const shouldInsertErrorRow =
      !hasRealSignals &&
      !!enrichment.confidence_note &&
      (
        enrichment.provider === "error" ||
        enrichment.confidence_note.toLowerCase().includes("quota") ||
        enrichment.confidence_note.toLowerCase().includes("billing") ||
        enrichment.confidence_note.toLowerCase().includes("credit") ||
        enrichment.confidence_note.toLowerCase().includes("api key") ||
        enrichment.confidence_note.toLowerCase().includes("authentication") ||
        enrichment.confidence_note.toLowerCase().includes("rate limit")
      );

    await supabase
      .from("decision_detections")
      .delete()
      .eq("document_id", documentId)
      .eq("source", "ai_enriched")
      .contains("metadata", { job_id: jobId });

    const rows: any[] = [];

    if (enrichment.classification) {
      rows.push({
        organization_id: organizationId,
        document_id: documentId,
        decision_type: "ai_classification",
        decision_value: enrichment.classification,
        confidence: null,
        source: "ai_enriched",
        reason: enrichment.confidence_note || "AI classified document",
        metadata,
      });
    }

    for (const risk of enrichment.eligibility_risks) {
      rows.push({
        organization_id: organizationId,
        document_id: documentId,
        decision_type: "eligibility_risk",
        decision_value: risk,
        confidence: null,
        source: "ai_enriched",
        reason: enrichment.confidence_note || "AI detected eligibility risk",
        metadata,
      });
    }

    for (const flag of enrichment.termination_flags) {
      rows.push({
        organization_id: organizationId,
        document_id: documentId,
        decision_type: "termination_flag",
        decision_value: flag,
        confidence: null,
        source: "ai_enriched",
        reason: enrichment.confidence_note || "AI detected termination language",
        metadata,
      });
    }

    if (enrichment.pricing_summary) {
      rows.push({
        organization_id: organizationId,
        document_id: documentId,
        decision_type: "pricing_summary",
        decision_value: enrichment.pricing_summary,
        confidence: null,
        source: "ai_enriched",
        reason: enrichment.confidence_note || "AI generated pricing summary",
        metadata,
      });
    }

    if (enrichment.scope_summary) {
      rows.push({
        organization_id: organizationId,
        document_id: documentId,
        decision_type: "scope_summary",
        decision_value: enrichment.scope_summary,
        confidence: null,
        source: "ai_enriched",
        reason: enrichment.confidence_note || "AI generated scope summary",
        metadata,
      });
    }

    for (const clause of enrichment.key_clauses) {
      rows.push({
        organization_id: organizationId,
        document_id: documentId,
        decision_type: "key_clause",
        decision_value: clause,
        confidence: null,
        source: "ai_enriched",
        reason: enrichment.confidence_note || "AI detected key clause",
        metadata,
      });
    }

    if (shouldInsertErrorRow) {
      rows.push({
        organization_id: organizationId,
        document_id: documentId,
        decision_type: "ai_enrichment_error",
        decision_value: enrichment.provider === "error"
          ? "AI enrichment unavailable"
          : `AI provider unavailable: ${enrichment.provider}`,
        confidence: null,
        source: "ai_enriched",
        reason: enrichment.confidence_note,
        metadata,
      });
    }

    if (rows.length === 0) {
      return { inserted: 0, skipped: true };
    }

    const { error } = await supabase.from("decision_detections").insert(rows);

    if (error) {
      return { inserted: 0, skipped: false, error: error.message };
    }

    return { inserted: rows.length, skipped: false };
  } catch (err) {
    return {
      inserted: 0,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
