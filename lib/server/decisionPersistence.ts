// lib/server/decisionPersistence.ts
// Persists evaluated decision findings into public.decisions with upsert and rule lookup.
// Server-only; use getSupabaseAdmin().

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DocumentDecision } from '@/lib/types/decisions';

/** Normalized shape for one decision to persist (before rule lookup). */
export type PersistedDecisionInput = {
  decision_type: string;
  title: string;
  summary: string | null;
  severity: string;
  confidence: number | null;
  details: Record<string, unknown>;
  rule_key?: string | null;
};

const SEVERITY_HIGH_TYPES = new Set([
  'compliance_alert',
  'compliance_risk',
  'critical_finding',
  'eligibility_risk',
  'fema_eligibility_gap',
]);
const SEVERITY_LOW_TYPES = new Set([
  'extraction_mode',
  'rate_detected',
  'classification_confidence',
  'contract_completeness',
  'invoice_completeness',
]);

function humanizeLabel(value: string | null): string {
  if (!value) return '';
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Maps engine output (DocumentDecision[]) to PersistedDecisionInput[] for persistence.
 * Derives title, summary, severity, details, and rule_key from decision_type and decision_value.
 */
export function documentDecisionsToPersisted(
  decisions: DocumentDecision[],
  context?: { document_type?: string | null }
): PersistedDecisionInput[] {
  return decisions.map((d) => {
    const rule_key = `${d.decision_type}::${d.decision_value ?? ''}`.trimEnd();
    const summary = d.decision_value ? humanizeLabel(d.decision_value) : null;
    let title = humanizeLabel(d.decision_type);
    if (d.decision_value && d.decision_value.length <= 80) {
      title = `${title}: ${humanizeLabel(d.decision_value)}`;
    } else if (d.decision_value) {
      title = `${title}: ${d.decision_value.slice(0, 80)}`;
    }
    let severity = 'medium';
    if (SEVERITY_HIGH_TYPES.has(d.decision_type)) severity = 'high';
    else if (SEVERITY_LOW_TYPES.has(d.decision_type)) severity = 'low';

    const details: Record<string, unknown> = {
      decision_value: d.decision_value,
      source: d.source,
      matched_rule_key: rule_key || undefined,
    };
    if (context?.document_type) details.document_type = context.document_type;

    return {
      decision_type: d.decision_type,
      title,
      summary,
      severity,
      confidence: d.confidence,
      details,
      rule_key: rule_key || undefined,
    };
  });
}

export type PersistDecisionsParams = {
  organization_id: string;
  document_id: string;
  decisions: PersistedDecisionInput[];
  source?: string;
};

/** Resolve decision_rule_id from public.decision_rules by organization_id and rule_key. */
async function getRuleIdsByKey(
  admin: SupabaseClient,
  organizationId: string,
  ruleKeys: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(ruleKeys)].filter(Boolean);
  if (unique.length === 0) return new Map();

  const { data, error } = await admin
    .from('decision_rules')
    .select('id, rule_key')
    .eq('organization_id', organizationId)
    .in('rule_key', unique);

  if (error) return new Map();
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const key = (row as { rule_key?: string }).rule_key;
    const id = (row as { id: string }).id;
    if (key && id) map.set(key, id);
  }
  return map;
}

/** Find most recent active/open decision for (org, document, decision_type). */
async function findExistingActive(
  admin: SupabaseClient,
  organizationId: string,
  documentId: string,
  decisionType: string
): Promise<{ id: string } | null> {
  const { data, error } = await admin
    .from('decisions')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('document_id', documentId)
    .eq('decision_type', decisionType)
    .eq('status', 'open')
    .order('last_detected_at', { ascending: false })
    .limit(1);

  if (error || !data?.length) return null;
  const row = data[0] as { id: string };
  return row?.id ? { id: row.id } : null;
}

/** Persist decisions to public.decisions: upsert by (org, document, decision_type), link decision_rule_id when rule_key matches. */
export async function persistDecisions(
  admin: SupabaseClient,
  params: PersistDecisionsParams
): Promise<{ persisted: number; errors: number }> {
  const source = params.source ?? 'system';
  const now = new Date().toISOString();
  const ruleKeys = params.decisions.map((d) => d.rule_key).filter(Boolean) as string[];
  const ruleIdByKey = await getRuleIdsByKey(admin, params.organization_id, ruleKeys);

  let persisted = 0;
  let errors = 0;

  for (const d of params.decisions) {
    const decision_rule_id = d.rule_key ? ruleIdByKey.get(d.rule_key) ?? null : null;

    const existing = await findExistingActive(
      admin,
      params.organization_id,
      params.document_id,
      d.decision_type
    );

    if (existing) {
      const { error } = await admin
        .from('decisions')
        .update({
          title: d.title,
          summary: d.summary,
          severity: d.severity,
          confidence: d.confidence,
          details: d.details,
          last_detected_at: now,
          updated_at: now,
          ...(decision_rule_id != null && { decision_rule_id }),
        })
        .eq('id', existing.id);

      if (error) {
        errors += 1;
        continue;
      }
      persisted += 1;
    } else {
      const { error } = await admin.from('decisions').insert({
        organization_id: params.organization_id,
        document_id: params.document_id,
        decision_rule_id,
        decision_type: d.decision_type,
        title: d.title,
        summary: d.summary,
        severity: d.severity,
        status: 'open',
        confidence: d.confidence,
        details: d.details,
        source,
        first_detected_at: now,
        last_detected_at: now,
        created_at: now,
        updated_at: now,
      });

      if (error) {
        errors += 1;
        continue;
      }
      persisted += 1;
    }
  }

  return { persisted, errors };
}
