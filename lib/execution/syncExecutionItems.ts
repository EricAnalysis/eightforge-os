import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildExecutionItemSuppressionSignature,
  executionItemSuppressionSignatureForRow,
  type ExecutionItemSeverity,
  type ExecutionItemStatus,
  type ProjectExecutionItemRow,
} from '@/lib/executionItems';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import {
  isBlockingFinding,
  normalizeValidationFinding,
} from '@/lib/validator/findingSemantics';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

type PersistableValidationFinding = ValidationFinding & {
  evidence?: ValidationEvidence[];
};

type ExistingExecutionItemRow = Pick<
  ProjectExecutionItemRow,
  | 'id'
  | 'source_type'
  | 'source_id'
  | 'source_key'
  | 'severity'
  | 'title'
  | 'problem'
  | 'expected_value'
  | 'actual_value'
  | 'impact'
  | 'required_action'
  | 'status'
  | 'outcome'
  | 'evidence_refs'
  | 'fact_refs'
  | 'validator_rule_key'
  | 'override_reason'
  | 'suppression_signature'
  | 'last_seen_at'
  | 'overridden_at'
  | 'resolved_at'
>;

export type SyncExecutionItemsResult = {
  created: number;
  updated: number;
  resolvable: number;
  suppressed: number;
  suppressedFindingIds: Set<string>;
  executionItemIdsBySourceKey: Map<string, string>;
};

function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    results.push(trimmed);
  }

  return results;
}

function executionItemSeverity(finding: PersistableValidationFinding): ExecutionItemSeverity {
  const normalized = normalizeValidationFinding(finding);
  switch (normalized.business_severity) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
    default:
      return 'low';
  }
}

function findingFactRefs(finding: PersistableValidationFinding): string[] {
  const fromFinding = Array.isArray(normalizeValidationFinding(finding).evidence_refs)
    ? normalizeValidationFinding(finding).evidence_refs ?? []
    : [];
  const fromEvidence = (finding.evidence ?? [])
    .map((evidence) => evidence.fact_id)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => `fact:${value}`);

  return uniqueStrings([...fromFinding.filter((ref) => ref.startsWith('fact:')), ...fromEvidence]);
}

function findingEvidenceRefs(finding: PersistableValidationFinding): string[] {
  const normalized = normalizeValidationFinding(finding);
  const fromFinding = Array.isArray(normalized.evidence_refs) ? normalized.evidence_refs : [];
  const fromEvidence = (finding.evidence ?? []).flatMap((evidence) => {
    const refs: Array<string | null> = [];
    if (evidence.source_document_id && evidence.source_page != null) {
      refs.push(`document:${evidence.source_document_id}:page:${evidence.source_page}`);
    } else if (evidence.source_document_id) {
      refs.push(`document:${evidence.source_document_id}`);
    }
    if (evidence.record_id) {
      refs.push(`record:${evidence.record_id}`);
    }
    if (evidence.field_name) {
      refs.push(`field:${evidence.field_name}`);
    }
    return refs;
  });

  return uniqueStrings([...fromFinding, ...fromEvidence]);
}

type ExecutionItemRecord = Omit<
  ProjectExecutionItemRow,
  | 'id'
  | 'organization_id'
  | 'project_id'
  | 'created_at'
  | 'updated_at'
  | 'last_seen_at'
>;

function buildExecutionItemRecord(
  projectId: string,
  finding: PersistableValidationFinding,
): ExecutionItemRecord {
  const normalized = normalizeValidationFinding(finding);
  const evidence_refs = findingEvidenceRefs(finding);
  const fact_refs = findingFactRefs(finding);

  return {
    source_type: 'validator_finding',
    source_id: finding.id,
    source_key: finding.check_key,
    severity: executionItemSeverity(finding),
    title: normalized.problem ?? finding.blocked_reason ?? finding.rule_id,
    problem: normalized.problem ?? finding.blocked_reason ?? finding.rule_id,
    expected_value: finding.expected ?? null,
    actual_value: finding.actual ?? null,
    impact: normalized.impact ?? 'Approval readiness is affected until this issue is resolved.',
    required_action: normalized.required_action ?? 'Inspect the linked evidence and complete the required correction or approval decision.',
    status: 'open',
    outcome: null,
    evidence_refs,
    fact_refs,
    validator_rule_key: finding.rule_id,
    override_reason: null,
    suppression_signature: buildExecutionItemSuppressionSignature({
      project_id: projectId,
      validator_rule_key: finding.rule_id,
      source_key: finding.check_key,
      expected_value: finding.expected ?? null,
      actual_value: finding.actual ?? null,
      evidence_refs,
      fact_refs,
    }),
    overridden_at: null,
    resolved_at: null,
  };
}

function executionItemChanged(
  existing: ExistingExecutionItemRow,
  nextRecord: ExecutionItemRecord,
  nextStatus: ExecutionItemStatus,
): boolean {
  return (
    existing.source_id !== nextRecord.source_id ||
    existing.severity !== nextRecord.severity ||
    existing.title !== nextRecord.title ||
    existing.problem !== nextRecord.problem ||
    (existing.expected_value ?? null) !== nextRecord.expected_value ||
    (existing.actual_value ?? null) !== nextRecord.actual_value ||
    existing.impact !== nextRecord.impact ||
    existing.required_action !== nextRecord.required_action ||
    existing.status !== nextStatus ||
    (existing.suppression_signature ?? null) !== nextRecord.suppression_signature ||
    JSON.stringify(existing.evidence_refs ?? []) !== JSON.stringify(nextRecord.evidence_refs ?? []) ||
    JSON.stringify(existing.fact_refs ?? []) !== JSON.stringify(nextRecord.fact_refs ?? []) ||
    (existing.validator_rule_key ?? null) !== nextRecord.validator_rule_key ||
    existing.outcome != null ||
    existing.override_reason != null ||
    existing.overridden_at != null ||
    existing.resolved_at != null
  );
}

async function logExecutionItemCreated(params: {
  organizationId: string;
  projectId: string;
  executionItemId: string;
  actorId?: string;
  record: ReturnType<typeof buildExecutionItemRecord>;
}) {
  const result = await logActivityEvent({
    organization_id: params.organizationId,
    project_id: params.projectId,
    entity_type: 'execution_item',
    entity_id: params.executionItemId,
    event_type: 'execution_item_created',
    changed_by: params.actorId ?? null,
    old_value: null,
    new_value: {
      source_type: params.record.source_type,
      source_id: params.record.source_id,
      source_key: params.record.source_key,
      title: params.record.title,
      severity: params.record.severity,
      status: params.record.status,
      validator_rule_key: params.record.validator_rule_key,
      suppression_signature: params.record.suppression_signature,
    },
  });

  if (!result.ok) {
    console.error('[syncExecutionItems] failed to log execution item creation', {
      executionItemId: params.executionItemId,
      error: result.error,
    });
  }
}

async function loadExistingExecutionItems(params: {
  admin: SupabaseClient;
  projectId: string;
}): Promise<ExistingExecutionItemRow[]> {
  const { data, error } = await params.admin
    .from('execution_items')
    .select(
      'id, source_type, source_id, source_key, severity, title, problem, expected_value, actual_value, impact, required_action, status, outcome, evidence_refs, fact_refs, validator_rule_key, override_reason, suppression_signature, last_seen_at, overridden_at, resolved_at',
    )
    .eq('project_id', params.projectId);

  if (error) {
    throw new Error(`Failed to load execution items for ${params.projectId}: ${error.message}`);
  }

  return (data ?? []) as ExistingExecutionItemRow[];
}

async function suppressFindingFromOverriddenExecutionItem(params: {
  admin: SupabaseClient;
  findingId: string;
  actorId?: string;
}) {
  const now = new Date().toISOString();
  const { error } = await params.admin
    .from('project_validation_findings')
    .update({
      status: 'dismissed',
      resolved_by_user_id: params.actorId ?? null,
      resolved_at: now,
      updated_at: now,
    })
    .eq('id', params.findingId);

  if (error) {
    throw new Error(`Failed to suppress validation finding ${params.findingId}: ${error.message}`);
  }
}

async function linkFindingsToExecutionItems(params: {
  admin: SupabaseClient;
  links: Array<{ findingId: string; executionItemId: string }>;
}) {
  for (const link of params.links) {
    const { error } = await params.admin
      .from('project_validation_findings')
      .update({
        linked_action_id: link.executionItemId,
      })
      .eq('id', link.findingId);

    if (error) {
      throw new Error(`Failed to link finding ${link.findingId} to execution item ${link.executionItemId}: ${error.message}`);
    }
  }
}

export async function syncExecutionItems(params: {
  admin: SupabaseClient;
  projectId: string;
  organizationId: string;
  actorId?: string;
  findings: readonly PersistableValidationFinding[];
}): Promise<SyncExecutionItemsResult> {
  const { admin, projectId, organizationId, actorId } = params;
  const now = new Date().toISOString();
  const actionableFindings = params.findings.filter(
    (finding) =>
      finding.status === 'open' &&
      (isBlockingFinding(finding) || normalizeValidationFinding(finding).approval_gate_effect === 'requires_operator_review'),
  );
  const records = actionableFindings.map((finding) => ({
    finding,
    record: buildExecutionItemRecord(projectId, finding),
  }));

  const existingRows = await loadExistingExecutionItems({ admin, projectId });
  const existingBySourceKey = new Map(
    existingRows
      .filter((row) => row.source_type === 'validator_finding')
      .map((row) => [row.source_key, row] as const),
  );
  const currentSourceKeys = new Set(records.map(({ record }) => record.source_key));
  const executionItemIdsBySourceKey = new Map<string, string>();
  const findingExecutionLinks: Array<{ findingId: string; executionItemId: string }> = [];
  const suppressedFindingIds = new Set<string>();

  let created = 0;
  let updated = 0;
  let resolvable = 0;
  let suppressed = 0;

  for (const { finding, record } of records) {
    const existing = existingBySourceKey.get(record.source_key) ?? null;

    if (existing) {
      const existingSuppressionSignature =
        existing.suppression_signature
        ?? executionItemSuppressionSignatureForRow({
          project_id: projectId,
          validator_rule_key: existing.validator_rule_key,
          source_key: existing.source_key,
          expected_value: existing.expected_value,
          actual_value: existing.actual_value,
          evidence_refs: existing.evidence_refs,
          fact_refs: existing.fact_refs,
        });

      const suppressionMatch =
        existing.outcome === 'overridden'
        && existingSuppressionSignature === record.suppression_signature;

      if (suppressionMatch) {
        const { error } = await admin
          .from('execution_items')
          .update({
            source_id: record.source_id,
            severity: record.severity,
            title: record.title,
            problem: record.problem,
            expected_value: record.expected_value,
            actual_value: record.actual_value,
            impact: record.impact,
            required_action: record.required_action,
            evidence_refs: record.evidence_refs,
            fact_refs: record.fact_refs,
            validator_rule_key: record.validator_rule_key,
            suppression_signature: record.suppression_signature,
            status: 'resolved',
            outcome: 'overridden',
            last_seen_at: now,
            updated_at: now,
          })
          .eq('id', existing.id);

        if (error) {
          throw new Error(`Failed to preserve overridden execution item ${existing.id}: ${error.message}`);
        }

        await suppressFindingFromOverriddenExecutionItem({
          admin,
          findingId: finding.id,
          actorId,
        });

        suppressed += 1;
        suppressedFindingIds.add(finding.id);
        executionItemIdsBySourceKey.set(record.source_key, existing.id);
        findingExecutionLinks.push({ findingId: finding.id, executionItemId: existing.id });
        continue;
      }

      if (executionItemChanged(existing, record, 'open')) {
        const { error } = await admin
          .from('execution_items')
          .update({
            source_id: record.source_id,
            severity: record.severity,
            title: record.title,
            problem: record.problem,
            expected_value: record.expected_value,
            actual_value: record.actual_value,
            impact: record.impact,
            required_action: record.required_action,
            status: 'open',
            outcome: null,
            evidence_refs: record.evidence_refs,
            fact_refs: record.fact_refs,
            validator_rule_key: record.validator_rule_key,
            override_reason: null,
            suppression_signature: record.suppression_signature,
            last_seen_at: now,
            overridden_at: null,
            resolved_at: null,
            updated_at: now,
          })
          .eq('id', existing.id);

        if (error) {
          throw new Error(`Failed to update execution item ${existing.id}: ${error.message}`);
        }

        updated += 1;
      } else {
        const { error } = await admin
          .from('execution_items')
          .update({
            source_id: record.source_id,
            last_seen_at: now,
            updated_at: now,
          })
          .eq('id', existing.id);

        if (error) {
          throw new Error(`Failed to refresh execution item ${existing.id}: ${error.message}`);
        }
      }

      executionItemIdsBySourceKey.set(record.source_key, existing.id);
      findingExecutionLinks.push({ findingId: finding.id, executionItemId: existing.id });
      continue;
    }

    const { data, error } = await admin
      .from('execution_items')
      .insert({
        organization_id: organizationId,
        project_id: projectId,
        source_type: record.source_type,
        source_id: record.source_id,
        source_key: record.source_key,
        severity: record.severity,
        title: record.title,
        problem: record.problem,
        expected_value: record.expected_value,
        actual_value: record.actual_value,
        impact: record.impact,
        required_action: record.required_action,
        status: 'open',
        outcome: null,
        evidence_refs: record.evidence_refs,
        fact_refs: record.fact_refs,
        validator_rule_key: record.validator_rule_key,
        override_reason: null,
        suppression_signature: record.suppression_signature,
        last_seen_at: now,
        overridden_at: null,
        resolved_at: null,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (error || !data?.id) {
      throw new Error(`Failed to insert execution item ${record.source_key}: ${error?.message ?? 'unknown error'}`);
    }

    created += 1;
    executionItemIdsBySourceKey.set(record.source_key, data.id);
    findingExecutionLinks.push({ findingId: finding.id, executionItemId: data.id });
    await logExecutionItemCreated({
      organizationId,
      projectId,
      executionItemId: data.id,
      actorId,
      record,
    });
  }

  for (const row of existingRows) {
    if (row.source_type !== 'validator_finding') continue;
    if (currentSourceKeys.has(row.source_key)) continue;
    if (row.status === 'resolved') {
      executionItemIdsBySourceKey.set(row.source_key, row.id);
      continue;
    }

    const { error } = await admin
      .from('execution_items')
      .update({
        status: 'resolvable',
        updated_at: now,
      })
      .eq('id', row.id);

    if (error) {
      throw new Error(`Failed to mark execution item ${row.id} resolvable: ${error.message}`);
    }

    executionItemIdsBySourceKey.set(row.source_key, row.id);
    resolvable += 1;
  }

  await linkFindingsToExecutionItems({
    admin,
    links: findingExecutionLinks,
  });

  return {
    created,
    updated,
    resolvable,
    suppressed,
    suppressedFindingIds,
    executionItemIdsBySourceKey,
  };
}
