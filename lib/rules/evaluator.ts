// lib/rules/evaluator.ts
// Deterministic rule evaluator for EightForge Rule System v1.0.
// Pure function: same inputs always produce the same outputs.
// No server imports — client-safe.

import type {
  RuleContext,
  RuleOutput,
  RuleEvaluationResult,
  ExtractedFacts,
  RelatedDocFacts,
} from './types.ts';
import { getRulesForDocumentType, RULE_PACK_VERSION } from './registry.ts';

// ─── Context builder ─────────────────────────────────────────────────────────

export interface BuildRuleContextParams {
  documentType: string;
  documentName: string;
  documentTitle: string | null;
  projectName: string | null;
  extractionData: Record<string, unknown> | null;
  relatedDocs: Array<{
    id: string;
    document_type: string | null;
    name: string;
    title?: string | null;
    extraction: Record<string, unknown> | null;
  }>;
}

function extractTypedFields(data: Record<string, unknown> | null): ExtractedFacts {
  if (!data) return {};
  const fields = data.fields as Record<string, unknown> | null;
  const typed = fields?.typed_fields as Record<string, unknown> | null;
  return typed ?? {};
}

function extractTextPreview(data: Record<string, unknown> | null): string {
  if (!data) return '';
  const extraction = data.extraction as Record<string, unknown> | null;
  return (extraction?.text_preview as string) ?? '';
}

export function buildRuleContext(params: BuildRuleContextParams): RuleContext {
  const relatedDocs: RelatedDocFacts[] = params.relatedDocs.map(d => ({
    id: d.id,
    documentType: d.document_type,
    name: d.name,
    title: d.title ?? null,
    facts: extractTypedFields(d.extraction),
    textPreview: extractTextPreview(d.extraction),
  }));

  return {
    documentType: params.documentType ?? '',
    documentName: params.documentName,
    documentTitle: params.documentTitle,
    projectName: params.projectName,
    facts: extractTypedFields(params.extractionData),
    textPreview: extractTextPreview(params.extractionData),
    relatedDocs,
  };
}

// ─── Evaluator ───────────────────────────────────────────────────────────────

export function evaluateRules(ctx: RuleContext): RuleEvaluationResult {
  const docType = ctx.documentType.toLowerCase().replace('debris_', '');
  const applicableRules = getRulesForDocumentType(docType);
  const outputs: RuleOutput[] = [];

  for (const rule of applicableRules) {
    const isCrossDoc = rule.scope === 'cross_document';
    if (isCrossDoc && ctx.relatedDocs.length === 0) continue;

    try {
      const result = rule.evaluate(ctx);
      if (result) {
        outputs.push(result);
      }
    } catch {
      // Rule evaluation failure is non-fatal; skip this rule.
    }
  }

  // Deterministic sort: by severity desc, then decision type, then ruleId
  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const decisionOrder = { BLOCK: 0, WARN: 1, MISSING: 2, INFO: 3, PASS: 4 };

  outputs.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const decDiff = decisionOrder[a.decision] - decisionOrder[b.decision];
    if (decDiff !== 0) return decDiff;
    return a.ruleId.localeCompare(b.ruleId);
  });

  return {
    outputs,
    ruleVersion: RULE_PACK_VERSION,
    evaluatedAt: new Date().toISOString(),
    documentType: ctx.documentType,
    rulesEvaluated: applicableRules.length,
    rulesMatched: outputs.length,
  };
}

// ─── Convenience: evaluate from raw params ───────────────────────────────────

export function evaluateDocument(params: BuildRuleContextParams): RuleEvaluationResult {
  const ctx = buildRuleContext(params);
  return evaluateRules(ctx);
}
