import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  operatorApprovalLabel,
  approvalNextAction,
  type OperatorApprovalLabel,
} from '@/lib/truthToAction';

export type ClientDecisionItem = {
  id: string;
  clientStatus: OperatorApprovalLabel;
  reason: string;
  nextStep: string;
  amount: number | null;
};

const VISIBLE_STATUSES = new Set([
  'blocked',
  'needs_review',
  'approved_with_exceptions',
  'approved',
  'open',
  'in_review',
]);

function extractAmount(details: Record<string, unknown> | null | undefined): number | null {
  if (!details) return null;
  for (const key of ['requires_verification_amount', 'blocked_amount', 'impacted_amount']) {
    const v = details[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function extractNextStep(
  details: Record<string, unknown> | null | undefined,
  clientStatus: OperatorApprovalLabel,
): string {
  if (details) {
    // Try primary_action.description
    const pa = details['primary_action'];
    if (pa && typeof pa === 'object' && !Array.isArray(pa)) {
      const desc = (pa as Record<string, unknown>)['description'];
      if (typeof desc === 'string' && desc.trim()) return desc.trim();
    }
    // Try suggested_actions[0].description
    const sa = details['suggested_actions'];
    if (Array.isArray(sa) && sa.length > 0) {
      const first = sa[0];
      if (first && typeof first === 'object') {
        const desc = (first as Record<string, unknown>)['description'];
        if (typeof desc === 'string' && desc.trim()) return desc.trim();
      }
    }
    // Try next_step directly
    const ns = details['next_step'];
    if (typeof ns === 'string' && ns.trim()) return ns.trim();
  }
  return approvalNextAction(clientStatus);
}

export async function fetchClientDecisions(projectId: string): Promise<{
  projectName: string | null;
  items: ClientDecisionItem[];
} | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data: project, error: projectError } = await admin
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .single();

  if (projectError || !project) return null;

  const { data: rows, error: decisionsError } = await admin
    .from('decisions')
    .select('id, title, summary, status, details')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (decisionsError) return null;

  const items: ClientDecisionItem[] = (rows ?? [])
    .filter((row) => VISIBLE_STATUSES.has(row.status))
    .map((row) => {
      const clientStatus = operatorApprovalLabel(row.status);
      const details = row.details as Record<string, unknown> | null;
      return {
        id: row.id,
        clientStatus,
        reason: (row.summary?.trim() || row.title?.trim()) ?? 'No detail available.',
        nextStep: extractNextStep(details, clientStatus),
        amount: extractAmount(details),
      };
    });

  return { projectName: project.name ?? null, items };
}
