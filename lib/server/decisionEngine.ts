import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { DecisionSource, DocumentDecision } from '@/lib/types/decisions';

type TypedFieldsShape = {
  schema_type?: string;
  // Contract fields
  vendor_name?: string | null;
  termination_clause?: string | null;
  insurance_requirements?: string | null;
  bonding_requirements?: string | null;
  fema_reference?: boolean;
  rate_table?: Array<{
    material_type: string | null;
    unit: string | null;
    rate_amount: number | null;
    rate_raw: string;
  }>;
  hauling_rates?: string[];
  tipping_fees?: string[];
  expiration_date?: string | null;
  // Invoice fields
  invoice_number?: string | null;
  invoice_date?: string | null;
  line_items?: Array<{
    description: string;
    quantity: number | null;
    unit: string | null;
    unit_price: number | null;
    total: number | null;
  }>;
  total_amount?: number | null;
  payment_terms?: string | null;
  po_number?: string | null;
  // Report fields
  report_type?: string | null;
  compliance_status?: string | null;
  findings?: Array<{ finding_text: string; severity: string | null }>;
};

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
    typed_fields?: TypedFieldsShape | null;
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

  // ── Typed-schema rules ───────────────────────────────────────────────────────
  const typed = params.extraction.fields?.typed_fields;
  const docId = params.documentId;
  const orgId = params.organizationId;

  // Contract rules
  if (typed?.schema_type === 'contract') {
    // Rate validation
    const rates = Array.isArray(typed.rate_table) ? typed.rate_table : [];
    for (const entry of rates) {
      if (entry.rate_amount == null) continue;
      const unitLower = (entry.unit ?? '').toLowerCase();
      if ((unitLower.includes('cubic yard') || unitLower.includes('cy')) && entry.rate_amount > 100) {
        addDecision(decisions, seen, {
          document_id: docId, organization_id: orgId,
          decision_type: 'rate_validation', decision_value: 'rate_high_cy',
          confidence: 0.7, source: 'deterministic',
        });
      }
      if (unitLower.includes('ton') && entry.rate_amount > 80) {
        addDecision(decisions, seen, {
          document_id: docId, organization_id: orgId,
          decision_type: 'rate_validation', decision_value: 'rate_high_ton',
          confidence: 0.7, source: 'deterministic',
        });
      }
      if (entry.rate_amount < 5) {
        addDecision(decisions, seen, {
          document_id: docId, organization_id: orgId,
          decision_type: 'rate_validation', decision_value: 'rate_suspiciously_low',
          confidence: 0.7, source: 'deterministic',
        });
      }
    }

    // Contract completeness
    const hasTermination = typed.termination_clause != null;
    const hasInsurance = typed.insurance_requirements != null;
    const hasBonding = typed.bonding_requirements != null;

    if (hasTermination && hasInsurance && hasBonding) {
      addDecision(decisions, seen, {
        document_id: docId, organization_id: orgId,
        decision_type: 'contract_completeness', decision_value: 'complete',
        confidence: 0.85, source: 'deterministic',
      });
    } else {
      if (!hasTermination) {
        addDecision(decisions, seen, {
          document_id: docId, organization_id: orgId,
          decision_type: 'contract_gap', decision_value: 'missing_termination_clause',
          confidence: 0.8, source: 'deterministic',
        });
      }
      if (!hasInsurance) {
        addDecision(decisions, seen, {
          document_id: docId, organization_id: orgId,
          decision_type: 'contract_gap', decision_value: 'missing_insurance_requirements',
          confidence: 0.8, source: 'deterministic',
        });
      }
      if (!hasBonding) {
        addDecision(decisions, seen, {
          document_id: docId, organization_id: orgId,
          decision_type: 'contract_gap', decision_value: 'missing_bonding_requirements',
          confidence: 0.8, source: 'deterministic',
        });
      }
    }

    // FEMA eligibility (granular)
    if (typed.fema_reference === true) {
      const femaChecks = [
        { present: hasInsurance, label: 'insurance' },
        { present: hasBonding, label: 'bonding' },
        { present: hasTermination, label: 'termination_for_convenience' },
      ];
      const allPresent = femaChecks.every((c) => c.present);

      addDecision(decisions, seen, {
        document_id: docId, organization_id: orgId,
        decision_type: 'fema_eligibility',
        decision_value: allPresent ? 'likely_eligible' : 'eligibility_risk',
        confidence: allPresent ? 0.8 : 0.75,
        source: 'deterministic',
      });

      for (const check of femaChecks) {
        if (!check.present) {
          addDecision(decisions, seen, {
            document_id: docId, organization_id: orgId,
            decision_type: 'fema_eligibility_gap',
            decision_value: `missing_${check.label}`,
            confidence: 0.75, source: 'deterministic',
          });
        }
      }
    }
  }

  // Invoice rules
  if (typed?.schema_type === 'invoice') {
    const fieldChecks = [
      { present: typed.invoice_number != null, label: 'invoice_number' },
      { present: typed.invoice_date != null, label: 'invoice_date' },
      { present: typed.vendor_name != null, label: 'vendor_name' },
      { present: Array.isArray(typed.line_items) && typed.line_items.length > 0, label: 'line_items' },
      { present: typed.total_amount != null, label: 'total_amount' },
    ];
    const presentCount = fieldChecks.filter((f) => f.present).length;

    const completeness = presentCount === 5 ? 'complete'
      : presentCount >= 3 ? 'partial'
      : 'incomplete';
    const conf = presentCount === 5 ? 0.9 : presentCount >= 3 ? 0.75 : 0.8;

    addDecision(decisions, seen, {
      document_id: docId, organization_id: orgId,
      decision_type: 'invoice_completeness', decision_value: completeness,
      confidence: conf, source: 'deterministic',
    });

    for (const check of fieldChecks) {
      if (!check.present) {
        addDecision(decisions, seen, {
          document_id: docId, organization_id: orgId,
          decision_type: 'missing_field', decision_value: check.label,
          confidence: 0.8, source: 'deterministic',
        });
      }
    }
  }

  // Report rules
  if (typed?.schema_type === 'report') {
    if (typed.compliance_status === 'non_compliant') {
      addDecision(decisions, seen, {
        document_id: docId, organization_id: orgId,
        decision_type: 'compliance_alert', decision_value: 'non_compliant',
        confidence: 0.85, source: 'deterministic',
      });
    }

    const findings = Array.isArray(typed.findings) ? typed.findings : [];
    for (const f of findings.slice(0, 5)) {
      if (f.severity === 'critical') {
        addDecision(decisions, seen, {
          document_id: docId, organization_id: orgId,
          decision_type: 'critical_finding',
          decision_value: f.finding_text.slice(0, 100),
          confidence: 0.8, source: 'deterministic',
        });
      }
    }
  }

  // Classification confidence (any typed schema)
  if (typed?.schema_type) {
    const detectedType = params.extraction.fields?.detected_document_type ?? null;
    if (detectedType === typed.schema_type) {
      addDecision(decisions, seen, {
        document_id: docId, organization_id: orgId,
        decision_type: 'classification_confidence', decision_value: 'confirmed',
        confidence: 0.9, source: 'deterministic',
      });
    } else if (detectedType && detectedType !== typed.schema_type) {
      addDecision(decisions, seen, {
        document_id: docId, organization_id: orgId,
        decision_type: 'classification_confidence', decision_value: 'mismatch',
        confidence: 0.7, source: 'deterministic',
      });
      addDecision(decisions, seen, {
        document_id: docId, organization_id: orgId,
        decision_type: 'suggested_document_type', decision_value: typed.schema_type,
        confidence: 0.7, source: 'deterministic',
      });
    }
  }

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

