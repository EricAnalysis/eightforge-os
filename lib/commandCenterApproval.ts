import {
  approvalBlockerCountForProjectFacts,
  approvalStatusLabelForProjectFacts,
  resolveCanonicalProjectFacts,
} from '@/lib/projectFacts';
import type { ProjectRecord } from '@/lib/projectOverview';

export type CanonicalProjectApproval = {
  label: 'Approved' | 'Blocked' | 'Needs Review' | 'Not Evaluated';
  blocker_count: number;
  is_blocked: boolean;
};

/**
 * Canonical approval state for Command Center surfaces, derived from the
 * persisted validation_summary_json exactly like the Project Overview header
 * (resolveProjectStatus), so both surfaces agree on blocked-ness.
 */
export function canonicalApprovalForProject(
  project: Pick<ProjectRecord, 'validation_status' | 'validation_summary_json'>,
): CanonicalProjectApproval {
  const facts = resolveCanonicalProjectFacts({
    validationStatus: project.validation_status ?? null,
    validationSummary: project.validation_summary_json,
  });
  const label = approvalStatusLabelForProjectFacts(facts);
  const blocker_count = approvalBlockerCountForProjectFacts(facts);
  return {
    label,
    blocker_count,
    is_blocked: label === 'Blocked' || blocker_count > 0,
  };
}

export function buildCanonicalApprovalByProjectId(
  projects: readonly Pick<ProjectRecord, 'id' | 'validation_status' | 'validation_summary_json'>[],
): Map<string, CanonicalProjectApproval> {
  const map = new Map<string, CanonicalProjectApproval>();
  for (const project of projects) {
    map.set(project.id, canonicalApprovalForProject(project));
  }
  return map;
}
