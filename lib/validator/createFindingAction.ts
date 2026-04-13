import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { buildValidatorFindingAction } from '@/lib/validator/queueFindingActions';
import { evaluateFindingRouting } from '@/lib/validator/validatorRouting';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

type ProjectContextRow = {
  id: string;
  organization_id: string;
  name: string;
  code: string | null;
};

function requireAdminClient() {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error('Server validation client is not configured.');
  }

  return admin;
}

async function loadFinding(findingId: string): Promise<ValidationFinding> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('project_validation_findings')
    .select('*')
    .eq('id', findingId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to load validation finding ${findingId}: ${error?.message ?? 'not found'}`);
  }

  return data as ValidationFinding;
}

async function loadProject(projectId: string): Promise<ProjectContextRow> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('projects')
    .select('id, organization_id, name, code')
    .eq('id', projectId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to load project ${projectId}: ${error?.message ?? 'not found'}`);
  }

  return data as ProjectContextRow;
}

async function loadFindingEvidence(findingId: string): Promise<ValidationEvidence[]> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('project_validation_evidence')
    .select('id, finding_id, evidence_type, source_document_id, source_page, fact_id, record_id, field_name, field_value, note, created_at')
    .eq('finding_id', findingId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to load validation evidence for finding ${findingId}: ${error.message}`);
  }

  return (data ?? []) as ValidationEvidence[];
}

function loadPrimaryDocumentId(
  evidence: readonly ValidationEvidence[],
): string | null {
  return evidence.find((entry) => entry.source_document_id)?.source_document_id ?? null;
}

function formatProjectLabel(project: ProjectContextRow): string {
  return project.code?.trim() || project.name;
}

function resolvePriority(finding: ValidationFinding): string {
  if (finding.severity === 'critical') return 'critical';
  if (finding.severity === 'warning') return 'high';
  return 'medium';
}

function buildTaskDescription(
  project: ProjectContextRow,
  finding: ValidationFinding,
  routingReason: string,
): string {
  const pieces = [
    `Review validator finding ${finding.rule_id} for ${formatProjectLabel(project)}.`,
    routingReason,
    `Subject: ${finding.subject_type}:${finding.subject_id}.`,
  ];

  if (finding.field) {
    pieces.push(`Field: ${finding.field}.`);
  }
  if (finding.expected) {
    pieces.push(`Expected: ${finding.expected}.`);
  }
  if (finding.actual) {
    pieces.push(`Actual: ${finding.actual}.`);
  }

  return pieces.join(' ');
}

export async function createFindingAction(
  findingId: string,
): Promise<{ actionId: string }> {
  const finding = await loadFinding(findingId);
  if (finding.linked_action_id) {
    return { actionId: finding.linked_action_id };
  }

  const routing = evaluateFindingRouting(finding);
  if (!routing.action_eligible) {
    throw new Error(routing.routing_reason);
  }

  const admin = requireAdminClient();
  const project = await loadProject(finding.project_id);
  const evidence = await loadFindingEvidence(findingId);
  const queueFindingAction = buildValidatorFindingAction({
    finding,
    evidence,
  });
  const documentId = loadPrimaryDocumentId(evidence);
  const now = new Date().toISOString();
  const description = buildTaskDescription(project, finding, routing.routing_reason);

  const { data, error } = await admin
    .from('workflow_tasks')
    .insert({
      organization_id: project.organization_id,
      decision_id: finding.linked_decision_id,
      document_id: documentId,
      project_id: project.id,
      task_type: 'review_validator_finding',
      title: queueFindingAction?.next_step?.trim() || `Review validator finding: ${finding.rule_id}`,
      description,
      priority: resolvePriority(finding),
      status: 'open',
      source: 'system',
      source_metadata: {
        origin: 'project_validator',
        validator_finding_id: finding.id,
        rule_id: finding.rule_id,
        category: finding.category,
        severity: finding.severity,
        subject_type: finding.subject_type,
        subject_id: finding.subject_id,
        routing_reason: routing.routing_reason,
      },
      details: {
        check_key: finding.check_key,
        field: finding.field,
        expected: finding.expected,
        actual: finding.actual,
        variance: finding.variance,
        variance_unit: finding.variance_unit,
        blocked_reason: finding.blocked_reason,
      },
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single();

  if (error || !data?.id) {
    throw new Error(`Failed to create action for finding ${findingId}: ${error?.message ?? 'unknown error'}`);
  }

  const { error: updateError } = await admin
    .from('project_validation_findings')
    .update({
      linked_action_id: data.id,
      updated_at: now,
    })
    .eq('id', findingId);

  if (updateError) {
    throw new Error(`Failed to link action ${data.id} to finding ${findingId}: ${updateError.message}`);
  }

  return { actionId: data.id };
}
