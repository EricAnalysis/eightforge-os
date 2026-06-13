// lib/rules/index.ts
// EightForge Rule System v1.0 — barrel export.

export type {
  DecisionType,
  Severity,
  Priority,
  RuleFamily,
  DocumentScope,
  TaskType,
  Role,
  RuleOutput,
  RuleDefinition,
  RuleContext,
  ExtractedFacts,
  RelatedDocFacts,
  RuleEvaluationResult,
} from './types.ts';

export { TASK_TITLES } from './types.ts';

export {
  RULE_PACK_VERSION,
  getRulePack,
  getRuleById,
  getRulesForDocumentType,
  getRuleCount,
} from './registry.ts';

export {
  buildRuleContext,
  evaluateRules,
  evaluateDocument,
  type BuildRuleContextParams,
} from './evaluator.ts';

export {
  mapRuleOutputs,
  buildRuleSummary,
  buildRuleChips,
  resetIdCounter,
} from './adapter.ts';

export {
  getRerunTargets,
  shouldRerunForDocumentType,
} from './rerun.ts';
