import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(path.join(root, 'supabase/migrations/20260906062740_immutable_repository_plan_v2_persistence.sql'), 'utf8');
const closureMigration = readFileSync(path.join(root,
  'supabase/migrations/20260907152935_phase11e_b3_engineering_persistence_authority_closure.sql'), 'utf8');
const reviewMigration = readFileSync(path.join(root,
  'supabase/migrations/20260906063909_immutable_repository_plan_engineering_reviews.sql'), 'utf8');
const replay = readFileSync(path.join(root, 'scripts/verify-step0-migration-replay.sh'), 'utf8');
const writer = readFileSync(path.join(root, 'lib/server/workflowRepositoryPlanPersistence.ts'), 'utf8');
const reader = readFileSync(path.join(root, 'lib/server/workflowRepositoryPlanRead.ts'), 'utf8');

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? productionFiles(absolute)
      : /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [absolute] : [];
  });
}

describe('repository Plan V2 persistence boundaries', () => {
  it('keeps raw and validated evidence separate, immutable, and RPC-only', () => {
    expect(migration).toContain('workflow_repository_plan_raw_evidence');
    expect(migration).toContain('workflow_repository_plan_v2_runs');
    expect(migration).toMatch(/raw_evidence_id uuid UNIQUE[\s\S]+ON DELETE RESTRICT/);
    expect(migration.match(/BEFORE UPDATE OR DELETE/g)).toHaveLength(2);
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.workflow_repository_plan_raw_evidence FROM PUBLIC, anon, authenticated, service_role/);
    expect(migration).toMatch(/GRANT EXECUTE[\s\S]+TO service_role/);
    expect(migration).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)[\s\S]+workflow_repository_plan/);
  });

  it('recomputes byte hashes and checks the complete immutable source chain', () => {
    for (const required of ['extensions.digest', 'rawOutputSha256', 'implementationPlanV1DigestSha256',
      'effectiveReviewedSpecificationDigestSha256', 'foundationDigestSha256', 'contentBundleDigestSha256',
      'guidanceInputDigestSha256', 'repositoryCommitSha', 'reviewPin,assessmentId']) {
      expect(migration).toContain(required);
    }
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('Plan V2 idempotency conflict');
    expect(closureMigration).toContain('workflow_repository_plan_v2_plan_v1_source_binding_check');
    expect(closureMigration).toContain("{guidance,sourceImplementationPlanV1DigestSha256}");
    expect(closureMigration).toMatch(
      /ADD CONSTRAINT workflow_repository_plan_v2_plan_v1_source_binding_check\s+CHECK \(\s*implementation_plan_v1_digest_sha256\s+IS NOT DISTINCT FROM plan_v2_canonical_json::jsonb #>> '\{source,implementationPlanV1DigestSha256\}'\s+AND implementation_plan_v1_digest_sha256\s+IS NOT DISTINCT FROM plan_v2_canonical_json::jsonb #>> '\{guidance,sourceImplementationPlanV1DigestSha256\}'\s*\);/,
    );
  });

  it('closes modified review scope at the database boundary and wires direct qualification before B4', () => {
    expect(reviewMigration).toContain('record_workflow_repository_plan_recommendation_review');
    expect(closureMigration).toContain('is_valid_workflow_engineering_modified_scope');
    for (const required of ['capabilitySummary','evidenceRefs','regressionGates','stopConditions',
      'operator_decision_required','^ev_[0-9a-f]{64}$']) expect(closureMigration).toContain(required);
    expect(closureMigration).toContain('REVOKE ALL ON FUNCTION public.is_valid_workflow_engineering_modified_scope');
    const b3 = replay.indexOf('verify-repository-plan-engineering-review.sql');
    const b4 = replay.indexOf('verify-linear-projection-delivery.sql');
    expect(b3).toBeGreaterThan(0);
    expect(b4).toBeGreaterThan(b3);
    expect(replay).toContain('PHASE 11E B3A/B3B CONCURRENCY: PASS');
  });

  it('keeps the normal read seam away from raw output and provider execution', () => {
    expect(reader).toContain("from('workflow_repository_plan_v2_runs')");
    expect(reader).not.toContain('workflow_repository_plan_raw_evidence');
    expect(reader).not.toMatch(/raw_output|rawOutput|forgewing\/runtime\/client|runForgewing|repositoryPlanContent/);
    expect(writer).toContain('record_workflow_repository_plan_v2_run');
    expect(writer).not.toMatch(/\.from\(|fetch\(|repositoryPlanContent|repositoryPlanFoundation/);
  });

  it('allows only the producer, persistence writer, and validated reader to consume the neutral Plan V2 contract', () => {
    const allowed = new Set(['lib/approvedEngineeringRequest.ts', 'lib/forgewing/tasks/repositoryPlanGuidance.ts',
      'lib/server/workflowRepositoryPlanPersistence.ts', 'lib/server/workflowRepositoryPlanRead.ts']);
    const consumers = productionFiles(path.join(root, 'lib')).flatMap((absolute) => {
      const text = readFileSync(absolute, 'utf8');
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      return /(?:from\s*|require\s*\(|import\s*\()(['"])(?:@\/lib\/|\.\.\/)*repositoryAwareImplementationPlan\1/.test(text)
        ? [relative] : [];
    });
    expect(consumers.sort()).toEqual([...allowed].sort());
    expect(reader).not.toMatch(/RepositoryPlanRawProviderEvidence|rawProviderEvidence/);
  }, 30_000);
});
