// lib/server/decisionEngine.ts
// Creates or updates decisions from matched deterministic rules.
//
// Production schema (public.decisions):
//   id, organization_id, document_id, decision_rule_id, decision_type,
//   title, summary, severity, status, confidence, details, source,
//   first_detected_at, last_detected_at, resolved_at, created_at,
//   updated_at, assigned_to, assigned_at, assigned_by, due_at, rule_key
//
// Behaviors:
//   - New match → INSERT with first_detected_at = now, last_detected_at = now
//   - Re-detection of existing open/in_review → UPDATE last_detected_at + details
//   - source = 'rule_engine', confidence = 1.0
//   - details jsonb stores full evidence: rule context, matched conditions, fact snapshot

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { RuleEvalResult, ActionJson } from '@/lib/types/rules';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateDecisionsResult = {
  /** Number of new decision rows inserted */
  created: number;
  /** Number of existing decisions updated with new last_detected_at */
  updated: number;
  /** Number of matched rules that had no change needed */
  skipped: number;
  /** Created or updated decisions with rule context — used by workflowEngine */
  decisions: CreatedDecision[];
};

export type CreatedDecision = {
  decision_id: string;
  document_id: string;
  rule_id: string;
  decision_type: string;
  severity: string;
  title: string;
  action_json: ActionJson;
  is_new: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a stable rule_key from rule name for cross-reference. */
function toRuleKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 100);
}

/** Build the details/evidence jsonb payload. */
function buildDetails(
  result: RuleEvalResult,
  facts: Record<string, unknown>,
): Record<string, unknown> {
  return {
    rule_id: result.rule.id,
    rule_name: result.rule.name,
    rule_group: result.rule.rule_group,
    matched_conditions: result.condition_results
      .filter((c) => c.passed)
      .map((c) => ({
        field_key: c.field_key,
        operator: c.operator,
        expected: c.expected,
        actual: c.actual,
      })),
    fact_snapshot: facts,
    evaluated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main Function
// ---------------------------------------------------------------------------

/**
 * Create or update decisions from matched rule evaluation results.
 *
 * Key behaviors:
 * - Checks for existing open/in_review decisions by document_id + decision_rule_id.
 * - If found: updates last_detected_at and details (re-detection).
 * - If not found: inserts new decision row.
 * - Returns all affected decisions (new and updated) so the workflow engine
 *   can create tasks without extra round-trips.
 */
export async function createDecisionsFromRules(params: {
  documentId: string;
  organizationId: string;
  projectId?: string | null;
  matchedResults: RuleEvalResult[];
  facts: Record<string, unknown>;
}): Promise<CreateDecisionsResult> {
  const empty: CreateDecisionsResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    decisions: [],
  };

  const admin = getSupabaseAdmin();
  if (!admin) return empty;

  const { documentId, organizationId, projectId, matchedResults, facts } = params;
  if (matchedResults.length === 0) return empty;

  const now = new Date().toISOString();

  // ── Load existing open/in_review decisions for this document ─────────
  const { data: existingRows } = await admin
    .from('decisions')
    .select('id, decision_rule_id')
    .eq('document_id', documentId)
    .in('status', ['open', 'in_review'])
    .not('decision_rule_id', 'is', null);

  const existingByRuleId = new Map<string, string>();
  for (const row of existingRows ?? []) {
    const r = row as { id: string; decision_rule_id: string };
    existingByRuleId.set(r.decision_rule_id, r.id);
  }

  // ── Process each matched rule ───────────────────────────────────────
  const decisions: CreatedDecision[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const result of matchedResults) {
    const { rule } = result;
    const details = buildDetails(result, facts);
    const existingDecisionId = existingByRuleId.get(rule.id);

    if (existingDecisionId) {
      // ── Re-detection: update last_detected_at and details ─────────
      const { error: updateError } = await admin
        .from('decisions')
        .update({
          last_detected_at: now,
          details,
          confidence: 1.0,
        })
        .eq('id', existingDecisionId);

      if (updateError) {
        console.error('[decisionEngine] update error:', updateError);
        skipped++;
        continue;
      }

      updated++;
      decisions.push({
        decision_id: existingDecisionId,
        document_id: documentId,
        rule_id: rule.id,
        decision_type: rule.decision_type,
        severity: rule.severity,
        title: rule.name,
        action_json: rule.action_json as ActionJson,
        is_new: false,
      });
    } else {
      // ── New detection: insert ─────────────────────────────────────
      const { data: inserted, error: insertError } = await admin
        .from('decisions')
        .insert({
          organization_id: organizationId,
          document_id: documentId,
          project_id: projectId ?? null,
          decision_rule_id: rule.id,
          rule_id: rule.id,
          decision_type: rule.decision_type,
          severity: rule.severity,
          status: 'open',
          source: 'rule_engine',
          confidence: 1.0,
          title: rule.name,
          summary: rule.description ?? null,
          details,
          rule_key: toRuleKey(rule.name),
          first_detected_at: now,
          last_detected_at: now,
        })
        .select('id')
        .single();

      if (insertError || !inserted) {
        console.error('[decisionEngine] insert error:', insertError);
        skipped++;
        continue;
      }

      created++;
      decisions.push({
        decision_id: (inserted as { id: string }).id,
        document_id: documentId,
        rule_id: rule.id,
        decision_type: rule.decision_type,
        severity: rule.severity,
        title: rule.name,
        action_json: rule.action_json as ActionJson,
        is_new: true,
      });
    }
  }

  return { created, updated, skipped, decisions };
}
