// lib/server/ruleEngine.ts
// Deterministic rule evaluator for the EightForge decision backbone.
//
// Responsibilities:
//   1. Load normalized facts from document_extractions (delegates to documentExtractions)
//   2. Load applicable rules by organization_id, domain, document_type
//   3. Evaluate each rule against facts using the constrained v1 condition grammar
//
// All evaluation functions (evaluateCondition, evaluateRule) are pure — no I/O,
// no side effects — and can be called from both server and client code for
// testing and preview purposes.

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  loadFactsFromExtractions,
  loadExtractionRows,
} from '@/lib/server/documentExtractions';
import { computeDerivedFacts } from '@/lib/server/derivedFacts';
import { evaluateCondition, evaluateRule } from '@/lib/ruleEvaluation';
import type {
  Facts,
  RuleRow,
  ConditionResult,
  RuleEvalResult,
} from '@/lib/types/rules';

export type { Facts, RuleRow, RuleEvalResult, ConditionResult };
export { evaluateCondition, evaluateRule };

// ---------------------------------------------------------------------------
// 1. Fact Loading (delegates to documentExtractions — single source of truth)
// ---------------------------------------------------------------------------

/**
 * Load normalized facts from document_extractions for a given document.
 * Only loads rows that have a field_key set (normalized fact rows) and
 * status = 'active'. Returns a flat key→typed-value map.
 *
 * This is a thin wrapper around documentExtractions.loadFactsFromExtractions
 * so callers don't need to import from two modules.
 */
export async function loadFacts(documentId: string): Promise<Facts> {
  return loadFactsFromExtractions(documentId);
}

// ---------------------------------------------------------------------------
// Facts with derived layer (for evaluation route)
// ---------------------------------------------------------------------------

export type LoadFactsWithDerivedResult = {
  facts: Facts;
  derived_facts: Facts;
  extraction_row_count: number;
};

/**
 * Load facts from document_extractions, compute derived facts, and merge.
 * Use this for document evaluation so rules can reference derived_* keys.
 */
export async function loadFactsWithDerived(params: {
  documentId: string;
  domain: string;
  documentType: string;
}): Promise<LoadFactsWithDerivedResult> {
  const [baseFacts, rows] = await Promise.all([
    loadFactsFromExtractions(params.documentId),
    loadExtractionRows(params.documentId),
  ]);

  const derived_facts = computeDerivedFacts({
    rows,
    facts: baseFacts,
    domain: params.domain,
    documentType: params.documentType,
  });

  const facts: Facts = { ...baseFacts, ...derived_facts };

  return {
    facts,
    derived_facts,
    extraction_row_count: rows.length,
  };
}

// ---------------------------------------------------------------------------
// 2. Rule Loading
// ---------------------------------------------------------------------------

/**
 * Load applicable rules for a document based on domain and document_type.
 * Merges organization-specific rules with global rules (organization_id IS NULL).
 * Returns rules ordered by priority ASC (lowest number = highest priority).
 */
export async function loadRules(params: {
  organizationId: string;
  domain: string;
  documentType: string;
}): Promise<RuleRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const { data, error } = await admin
    .from('rules')
    .select('*')
    .eq('domain', params.domain)
    .eq('document_type', params.documentType)
    .eq('status', 'active')
    .or(
      `organization_id.eq.${params.organizationId},organization_id.is.null`,
    )
    .order('priority', { ascending: true });

  if (error) {
    console.error('[ruleEngine] loadRules error:', error);
    return [];
  }

  return (data ?? []) as RuleRow[];
}

// ---------------------------------------------------------------------------
// 3. Full Document Evaluation (I/O: loads facts + rules, then evaluates)
// ---------------------------------------------------------------------------

/**
 * Evaluate all applicable rules for a document.
 * Loads facts and rules in parallel, then evaluates each rule.
 * Returns every evaluation result (matched and unmatched) for full transparency.
 */
export async function evaluateDocument(params: {
  documentId: string;
  organizationId: string;
  domain: string;
  documentType: string;
}): Promise<{
  facts: Facts;
  results: RuleEvalResult[];
  matched: RuleEvalResult[];
}> {
  const [facts, rules] = await Promise.all([
    loadFacts(params.documentId),
    loadRules({
      organizationId: params.organizationId,
      domain: params.domain,
      documentType: params.documentType,
    }),
  ]);

  const results = rules.map((rule) => evaluateRule(rule, facts));
  const matched = results.filter((r) => r.matched);

  return { facts, results, matched };
}

// ---------------------------------------------------------------------------
// Test Examples (pure function verification — no I/O needed)
// ---------------------------------------------------------------------------
//
// import { evaluateCondition, evaluateRule } from '@/lib/server/ruleEngine';
// import type { Facts, RuleRow } from '@/lib/types/rules';
//
// const facts: Facts = {
//   invoice_number: 'INV-2025-001',
//   vendor_name: 'Acme Debris Hauling',
//   amount: 75000,
//   rate_amount: 125,
//   disposal_site: 'Approved Site Alpha',
// };
//
// // exists → true (invoice_number has a value)
// evaluateCondition({ field_key: 'invoice_number', operator: 'exists', value: null }, facts);
//
// // not_exists → true (po_number is not in facts)
// evaluateCondition({ field_key: 'po_number', operator: 'not_exists', value: null }, facts);
//
// // greater_than → true (75000 > 50000)
// evaluateCondition({ field_key: 'amount', operator: 'greater_than', value: 50000 }, facts);
//
// // contains → true ('approved site alpha' includes 'alpha')
// evaluateCondition({ field_key: 'disposal_site', operator: 'contains', value: 'alpha' }, facts);
//
// // in → true ('acme debris hauling' is in the list)
// evaluateCondition({ field_key: 'vendor_name', operator: 'in', value: ['Acme Debris Hauling', 'Beta Corp'] }, facts);
//
// // Full rule evaluation with match_type = 'all':
// const rule = {
//   condition_json: {
//     match_type: 'all' as const,
//     conditions: [
//       { field_key: 'amount', operator: 'greater_than' as const, value: 50000 },
//       { field_key: 'po_number', operator: 'not_exists' as const, value: null },
//     ],
//   },
// } as RuleRow;
// evaluateRule(rule, facts);
// // → { matched: true, condition_results: [{ passed: true }, { passed: true }] }
