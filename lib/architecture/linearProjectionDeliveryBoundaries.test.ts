import { readFileSync } from 'node:fs';import path from 'node:path';import { describe,expect,it } from 'vitest';
const root=process.cwd();const read=(file:string)=>readFileSync(path.join(root,file),'utf8');
describe('Linear delivery authority boundaries',()=>{
 it('keeps correlation operational, RLS protected, and RPC-only',()=>{const sql=read('supabase/migrations/20260906065136_linear_projection_delivery.sql');
  const reprojection=read('supabase/migrations/20260906160355_allow_withdrawn_linear_issue_reprojection.sql');
  expect(sql).toContain('delivery state only');expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
  expect(sql).toMatch(/REVOKE ALL ON TABLE public\.linear_projection_correlations FROM PUBLIC, anon, authenticated, service_role/);
  expect(sql).toMatch(/CREATE UNIQUE INDEX linear_projection_correlations_one_active_request/);
  expect(sql.match(/SECURITY DEFINER SET search_path = ''/g)).toHaveLength(3);
  expect(sql).toContain('pg_advisory_xact_lock');expect(sql).toContain("'recovered'::text");
  expect(sql).toContain('correlation.claim_token = p_claim_token');expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)/);
  expect(reprojection).toContain('DROP INDEX public.linear_projection_correlations_issue_id_unique');
  expect(reprojection).toMatch(/CREATE UNIQUE INDEX linear_projection_correlations_issue_id_unique[\s\S]+WHERE status = 'projected' AND linear_issue_id IS NOT NULL/);
  expect(reprojection.match(/NULL::uuid/g)).toHaveLength(2);
  expect(reprojection).toContain('FROM public.linear_projection_correlations AS historical');
  expect(reprojection).toContain('FROM public.workflow_repository_plan_recommendation_reviews AS review');
  expect(reprojection).toContain('last_failure_code = NULL');
  expect(reprojection).not.toMatch(/^(?:UPDATE|DELETE FROM|TRUNCATE)\b/m);});
 it('keeps the client surface narrow and server-only',()=>{const client=read('lib/server/linearClient.ts');
  for(const method of ['createIssue','findProjectedIssueByIdempotencyKey'])expect(client).toContain(method);
  expect(client).not.toMatch(/updateIssue|getStatus|readComments|readDescription|readLabels|webhook/);
  expect(client).toContain('process.env.LINEAR_API_KEY');expect(client).not.toContain('NEXT_PUBLIC');});
 it('keeps delivery one-shot and upstream authority read-only',()=>{const delivery=read('lib/server/linearProjectionDelivery.ts');
  expect(delivery).not.toMatch(/while\s*\(|for\s*\(\s*;/);expect(delivery).not.toMatch(/setTimeout|setInterval|cron|webhook/);
 expect(delivery).toContain('readApprovedEngineeringRequest');expect(delivery).not.toMatch(/workflowIntake|sourceSubmissionId|rawOutput/);
  expect(delivery).toContain('findProjectedIssueByIdempotencyKey');expect(delivery).toContain('buildLinearCapabilityProjection');});
 it('keeps direct PostgreSQL lifecycle proof in the fresh replay gate',()=>{const verifier=read('scripts/sql/verify-linear-projection-delivery.sql');
  const replay=read('scripts/verify-step0-migration-replay.sh');
  expect(replay).toContain('--file scripts/sql/verify-linear-projection-delivery.sql');
  for(const rpc of ['claim_linear_projection_delivery','confirm_linear_projection_delivery','fail_linear_projection_delivery','withdraw_linear_projection_delivery']){
   expect(verifier).toContain(`public.${rpc}`);
  }
  for(const proof of ['SET ROLE authenticated','SET ROLE service_role','claim_status <> \'busy\'','claim_status <> \'recovered\'',
   'stale Linear token unexpectedly confirmed','stale Linear token unexpectedly failed','wrong request digest unexpectedly withdrew',
   'withdrawn Linear history allowed immutable identity rebinding','LINEAR PROJECTION DIRECT POSTGRESQL VERIFICATION: PASS']){
   expect(verifier).toContain(proof);
  }
  expect(verifier).not.toMatch(/api\.linear\.app|fetch\s*\(|LINEAR_API_KEY/);});
});
