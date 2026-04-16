// lib/server/decisionPersistence.ts
// Persists evaluated decision findings into public.decisions with upsert and rule lookup.
// Server-only; use getSupabaseAdmin().

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DocumentDecision } from '@/lib/types/decisions';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';

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
  project_id?: string | null;
  decisions: PersistedDecisionInput[];
  source?: string;
};

/**
 * Resolve rule id from public.rules by organization_id and decision_type.
 * rule_key format is "decision_type::value"; we match rules by decision_type.
 */
async function getRuleIdsByKey(
  admin: SupabaseClient,
  organizationId: string,
  ruleKeys: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(ruleKeys)].filter(Boolean);
  if (unique.length === 0) return new Map();

  const decisionTypes = [...new Set(unique.map((k) => k.split('::')[0]).filter(Boolean))];
  if (decisionTypes.length === 0) return new Map();

  const { data, error } = await admin
    .from('rules')
    .select('id, decision_type')
    .eq('organization_id', organizationId)
    .in('decision_type', decisionTypes);

  if (error) return new Map();
  const byDecisionType = new Map<string, string>();
  for (const row of data ?? []) {
    const dt = (row as { decision_type?: string }).decision_type;
    const id = (row as { id: string }).id;
    if (dt && id && !byDecisionType.has(dt)) byDecisionType.set(dt, id);
  }
  const map = new Map<string, string>();
  for (const ruleKey of unique) {
    const dt = ruleKey.split('::')[0];
    const id = dt ? byDecisionType.get(dt) : undefined;
    if (id) map.set(ruleKey, id);
  }
  return map;
}

/**
 * Find most recent non-terminal decision for (org, document, decision_type).
 * Matches 'open' and 'in_review' so that re-analysis updates the existing row
 * instead of creating a duplicate alongside one a human is actively reviewing.
 * Terminal statuses ('resolved', 'suppressed') are excluded intentionally —
 * a re-detection after resolution should create a fresh decision.
 */
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
    .in('status', ['open', 'in_review'])
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
      const { data: inserted, error } = await admin
        .from('decisions')
        .insert({
          organization_id: params.organization_id,
          document_id: params.document_id,
          project_id: params.project_id ?? null,
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
        })
        .select('id')
        .single();

      if (error) {
        errors += 1;
        continue;
      }
      persisted += 1;

      // Log creation event for audit trail. Non-blocking — decision row is
      // already committed. Pipeline decisions have no human actor, so changed_by is null.
      if (inserted?.id) {
        await logActivityEvent({
          organization_id: params.organization_id,
          entity_type: 'decision',
          entity_id: (inserted as { id: string }).id,
          event_type: 'created',
          changed_by: null,
        });
      }
    }
  }

  return { persisted, errors };
}
