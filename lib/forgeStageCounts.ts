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

export type ForgeStageFilterSummary = {
  reason: string;
  count: number;
};

export type ForgeStageRecordSet<T> = {
  visible: T[];
  filtered: ForgeStageFilterSummary[];
};

type ForgeQueueRecord = {
  status: string;
  details?: Record<string, unknown> | null;
  source_metadata?: Record<string, unknown> | null;
};

function summarizeForgeStageFilters(reasons: string[]): ForgeStageFilterSummary[] {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function forgeQueueFilterReason(
  record: ForgeQueueRecord,
  openStatuses: readonly string[],
): string | null {
  const detailsSupersededAt = record.details?.superseded_at;
  if (typeof detailsSupersededAt === 'string' && detailsSupersededAt.trim().length > 0) {
    return 'details.superseded_at present';
  }

  const sourceSupersededAt = record.source_metadata?.superseded_at;
  if (typeof sourceSupersededAt === 'string' && sourceSupersededAt.trim().length > 0) {
    return 'source_metadata.superseded_at present';
  }

  if (!openStatuses.includes(record.status)) {
    return `status=${record.status}`;
  }

  return null;
}

function buildForgeStageRecordSet<T extends ForgeQueueRecord>(
  records: T[],
  openStatuses: readonly string[],
): ForgeStageRecordSet<T> {
  const visible: T[] = [];
  const filteredReasons: string[] = [];

  for (const record of records) {
    const reason = forgeQueueFilterReason(record, openStatuses);
    if (reason) {
      filteredReasons.push(reason);
      continue;
    }
    visible.push(record);
  }

  return {
    visible,
    filtered: summarizeForgeStageFilters(filteredReasons),
  };
}

export function getForgeStructureDocuments(
  documents: ProjectDocumentRow[],
): ProjectDocumentRow[] {
  return documents.filter(
    (document) =>
      document.processing_status === 'extracted' || document.processing_status === 'decisioned',
  );
}

export function getForgeDecideStageRecords(
  decisions: ProjectDecisionRow[],
): ForgeStageRecordSet<ProjectDecisionRow> {
  return buildForgeStageRecordSet(decisions, DECISION_OPEN_STATUSES);
}

export function getForgeActStageRecords(
  tasks: ProjectTaskRow[],
): ForgeStageRecordSet<ProjectTaskRow> {
  return buildForgeStageRecordSet(tasks, TASK_OPEN_STATUSES);
}

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
}): ForgeStageCounts {
  const { documents, decisions, tasks, auditSurfaceCount } = params;

  let intake = 0;
  let extract = 0;
  const structure = getForgeStructureDocuments(documents).length;

  for (const document of documents) {
    switch (document.processing_status) {
      case 'uploaded':
        intake += 1;
        break;
      case 'processing':
        extract += 1;
        break;
      case 'failed':
        extract += 1;
        break;
      default:
        break;
    }
  }

  const decide = getForgeDecideStageRecords(decisions).visible.length;
  const act = getForgeActStageRecords(tasks).visible.length;

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
