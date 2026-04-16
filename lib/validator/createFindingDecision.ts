import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { evaluateFindingRouting } from '@/lib/validator/validatorRouting';
import type { ValidationFinding } from '@/types/validator';

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

async function loadPrimaryDocumentId(findingId: string): Promise<string | null> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('project_validation_evidence')
    .select('source_document_id')
    .eq('finding_id', findingId)
    .not('source_document_id', 'is', null)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load validation evidence for finding ${findingId}: ${error.message}`);
  }

  return (data as { source_document_id?: string | null } | null)?.source_document_id ?? null;
}

function formatProjectLabel(project: ProjectContextRow): string {
  return project.code?.trim() || project.name;
}

function buildDecisionSummary(
  project: ProjectContextRow,
  finding: ValidationFinding,
  routingReason: string,
): string {
  const fieldLabel = finding.field ? ` on ${finding.field}` : '';
  return `Validator finding ${finding.rule_id} for ${formatProjectLabel(project)} requires decision review${fieldLabel}. ${routingReason}`;
}

export async function createFindingDecision(
  findingId: string,
): Promise<{ decisionId: string }> {
  const finding = await loadFinding(findingId);
  if (finding.linked_decision_id) {
    return { decisionId: finding.linked_decision_id };
  }

  const routing = evaluateFindingRouting(finding);
  if (!routing.decision_eligible) {
    throw new Error(routing.routing_reason);
  }

  const admin = requireAdminClient();
  const project = await loadProject(finding.project_id);
  const documentId = await loadPrimaryDocumentId(findingId);
  const now = new Date().toISOString();
  const summary = buildDecisionSummary(project, finding, routing.routing_reason);

  const { data, error } = await admin
    .from('decisions')
    .insert({
      organization_id: project.organization_id,
      document_id: documentId,
      project_id: project.id,
      decision_rule_id: null,
      decision_type: 'validator_finding',
      title: `Validator review: ${finding.rule_id}`,
      summary,
      severity: 'critical',
      status: 'open',
      confidence: 1,
      details: {
        origin: 'project_validator',
        validator_finding_id: finding.id,
        rule_id: finding.rule_id,
        check_key: finding.check_key,
        category: finding.category,
        severity: finding.severity,
        status: finding.status,
        subject_type: finding.subject_type,
        subject_id: finding.subject_id,
        field: finding.field,
        expected: finding.expected,
        actual: finding.actual,
        variance: finding.variance,
        variance_unit: finding.variance_unit,
        blocked_reason: finding.blocked_reason,
        routing_reason: routing.routing_reason,
      },
      source: 'system',
      first_detected_at: now,
      last_detected_at: now,
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single();

  if (error || !data?.id) {
    throw new Error(`Failed to create decision for finding ${findingId}: ${error?.message ?? 'unknown error'}`);
  }

  const { error: updateError } = await admin
    .from('project_validation_findings')
    .update({
      linked_decision_id: data.id,
      updated_at: now,
    })
    .eq('id', findingId);

  if (updateError) {
    throw new Error(`Failed to link decision ${data.id} to finding ${findingId}: ${updateError.message}`);
  }

  return { decisionId: data.id };
}
