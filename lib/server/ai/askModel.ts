/**
 * Project Ask's own model qualification (census D3). Fail closed.
 *
 * Ask is a separate production capability with its own request contract
 * (`project_ask_v1`: the system prompt in askProject.ts, the project context,
 * 1,200 output tokens, model-aware sampling, 45 s / no retries). It does NOT
 * use the Forgewing qualified-model allowlist (FORGEWING_QUALIFIED_MODELS):
 * Ask may legitimately run a different model than FORGEWING_MODEL.
 *
 * Ask calls only a model listed here for its contract. An unqualified model
 * is refused before any context is built, budget reserved or provider called;
 * there is no fallback to another model.
 *
 * Model selection is explicit configuration, in order:
 * 1. FORGEWING_PROJECT_ASK_MODEL, an Ask-specific pin, so Ask can run its
 *    qualified model without changing the shared ANTHROPIC_MODEL;
 * 2. ANTHROPIC_MODEL, the shared model Ask has always used;
 * 3. the shared default.
 */

import { DEFAULT_CLAUDE_MODEL } from '@/lib/server/ai/claudeClient';

/**
 * Provenance: Ask's gate policy was declared `production_qualified` with the
 * `project_ask_v1` request contract on `claude-sonnet-4-6`, the shared default
 * (commit 273f531, 2026-10-06). The later Claude 5 sampling change (d98d066)
 * is request-shape compatibility, not qualification evidence, and production
 * has recorded no Ask call on any model. A further model is added here only
 * with its own Ask qualification evidence.
 */
export const PROJECT_ASK_QUALIFIED_MODELS: readonly string[] = Object.freeze(['claude-sonnet-4-6']);

export type ProjectAskModelResolution = Readonly<{
  model: string;
  source: 'FORGEWING_PROJECT_ASK_MODEL' | 'ANTHROPIC_MODEL' | 'default';
  qualified: boolean;
}>;

export function resolveProjectAskModel(env: Readonly<Record<string, string | undefined>> = process.env): ProjectAskModelResolution {
  const pinned = env.FORGEWING_PROJECT_ASK_MODEL?.trim();
  const shared = env.ANTHROPIC_MODEL?.trim();
  const model = pinned || shared || DEFAULT_CLAUDE_MODEL;
  return {
    model,
    source: pinned ? 'FORGEWING_PROJECT_ASK_MODEL' : shared ? 'ANTHROPIC_MODEL' : 'default',
    qualified: PROJECT_ASK_QUALIFIED_MODELS.includes(model),
  };
}
