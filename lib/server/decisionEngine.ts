import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { DecisionSource, DocumentDecision } from '@/lib/types/decisions';

type ExtractionShape = {
  fields: {
    rate_mentions?: string[];
    material_mentions?: string[];
    scope_mentions?: string[];
    compliance_mentions?: string[];
    detected_keywords?: string[];
    detected_document_type?: string | null;
    file_name?: string;
    title?: string | null;
  };
  extraction?: {
    mode: string;
    text_preview: string | null;
  };
  ai_enrichment?: {
    classification?: string | null;
    key_clauses?: string[];
    pricing_summary?: string | null;
    scope_summary?: string | null;
    eligibility_risks?: string[];
    termination_flags?: string[];
    confidence_note?: string;
    provider?: string;
  };
};

function norm(s: string): string {
  return s.toLowerCase().trim();
}

function mentionsIncludeAny(mentions: string[] | undefined, needles: string[]): boolean {
  if (!mentions || mentions.length === 0) return false;
  const m = mentions.map((x) => norm(x));
  return needles.some((needle) => m.some((v) => v.includes(norm(needle))));
}

function mentionsInclude(mentions: string[] | undefined, needle: string): boolean {
  return mentionsIncludeAny(mentions, [needle]);
}

type DecisionInsertRow = {
  document_id: string;
  organization_id: string;
  decision_type: string;
  decision_value: string | null;
  confidence: number | null;
  source: DecisionSource;
};

function addDecision(out: DecisionInsertRow[], seen: Set<string>, d: DecisionInsertRow) {
  const key = `${d.decision_type}::${d.decision_value ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(d);
}

export async function runDecisionEngine(params: {
  documentId: string;
  organizationId: string;
  extraction: ExtractionShape;
}): Promise<DocumentDecision[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  // Re-analysis should produce a clean, current decision set.
  // Delete-before-insert is the primary dedupe mechanism; DB constraint is a safety net.
  try {
    await admin.from('document_decisions').delete().eq('document_id', params.documentId);
  } catch (e) {
    console.error('[decisionEngine] pre-delete exception:', e);
  }

  const decisions: DecisionInsertRow[] = [];
  const seen = new Set<string>();

  const scope = params.extraction.fields?.scope_mentions ?? [];
  const rate = params.extraction.fields?.rate_mentions ?? [];
  const material = params.extraction.fields?.material_mentions ?? [];
  const compliance = params.extraction.fields?.compliance_mentions ?? [];

  // Deterministic rules: contract_type
  if (mentionsIncludeAny(scope, ['debris', 'removal', 'hauling', 'disposal', 'collection'])) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'contract_type',
      decision_value: 'debris_contract',
      confidence: 0.85,
      source: 'deterministic',
    });
  }
  if (mentionsIncludeAny(scope, ['monitoring', 'inspection', 'survey'])) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'contract_type',
      decision_value: 'monitoring_contract',
      confidence: 0.8,
      source: 'deterministic',
    });
  }
  if (mentionsIncludeAny(scope, ['invoice', 'billing', 'payment'])) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'contract_type',
      decision_value: 'invoice',
      confidence: 0.8,
      source: 'deterministic',
    });
  }

  // Deterministic rules: rate_structure
  if (rate.length > 0) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'rate_detected',
      decision_value: 'true',
      confidence: 0.9,
      source: 'deterministic',
    });
  }
  if (mentionsIncludeAny(rate, ['per ton', 'per cubic yard'])) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'rate_structure',
      decision_value: 'unit_rate',
      confidence: 0.9,
      source: 'deterministic',
    });
  }
  if (mentionsIncludeAny(rate, ['hourly', 'per hour'])) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'rate_structure',
      decision_value: 'hourly',
      confidence: 0.88,
      source: 'deterministic',
    });
  }

  // Deterministic rules: material_category
  if (mentionsInclude(material, 'vegetative')) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'material_category',
      decision_value: 'vegetative',
      confidence: 0.88,
      source: 'deterministic',
    });
  }
  if (mentionsIncludeAny(material, ['c&d', 'construction'])) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'material_category',
      decision_value: 'c_and_d',
      confidence: 0.88,
      source: 'deterministic',
    });
  }
  if (mentionsInclude(material, 'hazardous')) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'material_category',
      decision_value: 'hazardous',
      confidence: 0.9,
      source: 'deterministic',
    });
  }

  // Deterministic rules: compliance_risk
  if (compliance.length > 0) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'compliance_mentions_detected',
      decision_value: 'true',
      confidence: 0.8,
      source: 'deterministic',
    });
  }
  if (!mentionsInclude(compliance, 'equal opportunity')) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'compliance_risk',
      decision_value: 'missing_equal_opportunity_clause',
      confidence: 0.75,
      source: 'deterministic',
    });
  }
  if (mentionsIncludeAny(compliance, ['fema', 'eligibility', 'ineligible'])) {
    addDecision(decisions, seen, {
      document_id: params.documentId,
      organization_id: params.organizationId,
      decision_type: 'fema_reference',
      decision_value: 'true',
      confidence: 0.9,
      source: 'deterministic',
    });
  }

  // Deterministic rules: document_mode
  addDecision(decisions, seen, {
    document_id: params.documentId,
    organization_id: params.organizationId,
    decision_type: 'extraction_mode',
    decision_value: params.extraction.extraction?.mode ?? 'unknown',
    confidence: 1.0,
    source: 'deterministic',
  });

  // AI-enriched rules (only when real provider is present)
  const ai = params.extraction.ai_enrichment;
  const provider = typeof ai?.provider === 'string' ? ai.provider : 'none';
  if (ai && provider !== 'none' && provider !== 'openai_pending') {
    if (ai.classification != null) {
      addDecision(decisions, seen, {
        document_id: params.documentId,
        organization_id: params.organizationId,
        decision_type: 'ai_classification',
        decision_value: ai.classification,
        confidence: 0.85,
        source: 'ai_enriched',
      });
    }

    const risks = Array.isArray(ai.eligibility_risks) ? ai.eligibility_risks : [];
    risks.slice(0, 3).forEach((item) => {
      if (!item) return;
      addDecision(decisions, seen, {
        document_id: params.documentId,
        organization_id: params.organizationId,
        decision_type: 'eligibility_risk',
        decision_value: item,
        confidence: 0.8,
        source: 'ai_enriched',
      });
    });

    const flags = Array.isArray(ai.termination_flags) ? ai.termination_flags : [];
    flags.slice(0, 3).forEach((item) => {
      if (!item) return;
      addDecision(decisions, seen, {
        document_id: params.documentId,
        organization_id: params.organizationId,
        decision_type: 'termination_flag',
        decision_value: item,
        confidence: 0.8,
        source: 'ai_enriched',
      });
    });
  }

  if (decisions.length === 0) return [];

  try {
    const { data, error } = await admin
      .from('document_decisions')
      .insert(decisions)
      .select('id, document_id, organization_id, decision_type, decision_value, confidence, source, created_at');

    if (error) {
      console.error('[decisionEngine] insert error:', error);
      return [];
    }
    return (data ?? []) as DocumentDecision[];
  } catch (e) {
    console.error('[decisionEngine] insert exception:', e);
    return [];
  }
}

