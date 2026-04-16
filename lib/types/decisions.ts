export type DecisionSource = 'deterministic' | 'ai_enriched' | 'manual';

export type DocumentDecision = {
  id: string;
  document_id: string;
  organization_id: string;
  decision_type: string;
  decision_value: string | null;
  confidence: number | null;
  source: DecisionSource;
  created_at: string;
};

