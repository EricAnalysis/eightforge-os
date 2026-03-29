import { DECISION_OPEN_STATUSES, TASK_OPEN_STATUSES } from '@/lib/overdue';
import type {
  ProjectDecisionRow,
  ProjectDocumentRow,
  ProjectTaskRow,
} from '@/lib/projectOverview';

export const FORGE_STAGE_KEYS = [
  'intake',
  'extract',
  'structure',
  'decide',
  'act',
  'audit',
] as const;

export type ForgeStageKey = (typeof FORGE_STAGE_KEYS)[number];

export type ForgeStageCounts = Record<ForgeStageKey, number>;

/**
 * Derives per-stage counts from the same project-scoped rows as the overview model.
 * Mapping is structural (pipeline-oriented), not a second source of truth.
 */
export function buildForgeStageCounts(params: {
  documents: ProjectDocumentRow[];
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
  /** Use the same audit tail as the overview (e.g. model.audit.length or activity rows). */
  auditSurfaceCount: number;
  /** Optional override for generated, read-only Forge decisions. */
  decisionCountOverride?: number;
}): ForgeStageCounts {
  const { documents, decisions, tasks, auditSurfaceCount, decisionCountOverride } = params;

  let intake = 0;
  let extract = 0;
  let structure = 0;

  for (const document of documents) {
    switch (document.processing_status) {
      case 'uploaded':
        intake += 1;
        break;
      case 'processing':
        extract += 1;
        break;
      case 'extracted':
        structure += 1;
        break;
      case 'failed':
        extract += 1;
        break;
      default:
        break;
    }
  }

  const decide =
    typeof decisionCountOverride === 'number'
      ? Math.max(0, decisionCountOverride)
      : decisions.filter((d) => DECISION_OPEN_STATUSES.includes(d.status)).length;
  const act = tasks.filter((t) => TASK_OPEN_STATUSES.includes(t.status)).length;

  return {
    intake,
    extract,
    structure,
    decide,
    act,
    audit: Math.max(0, auditSurfaceCount),
  };
}

export const FORGE_STAGE_LABELS: Record<ForgeStageKey, string> = {
  intake: 'Intake',
  extract: 'Extract',
  structure: 'Structure',
  decide: 'Decide',
  act: 'Act',
  audit: 'Audit',
};
