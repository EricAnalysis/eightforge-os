import { readFileSync } from 'node:fs';import path from 'node:path';import { describe,expect,it } from 'vitest';
const root=process.cwd();const read=(file:string)=>readFileSync(path.join(root,file),'utf8');
describe('Linear delivery authority boundaries',()=>{
 it('keeps correlation operational, RLS protected, and RPC-only',()=>{const sql=read('supabase/migrations/20260906065136_linear_projection_delivery.sql');
  expect(sql).toContain('delivery state only');expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
  expect(sql).toMatch(/REVOKE ALL ON TABLE public\.linear_projection_correlations FROM PUBLIC, anon, authenticated, service_role/);
  expect(sql).toMatch(/CREATE UNIQUE INDEX linear_projection_correlations_one_active_request/);
  expect(sql.match(/SECURITY DEFINER SET search_path = ''/g)).toHaveLength(3);
  expect(sql).toContain('pg_advisory_xact_lock');expect(sql).toContain("'recovered'::text");
  expect(sql).toContain('correlation.claim_token = p_claim_token');expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)/);});
 it('keeps the client surface narrow and server-only',()=>{const client=read('lib/server/linearClient.ts');
  for(const method of ['createIssue','findProjectedIssueByIdempotencyKey'])expect(client).toContain(method);
  expect(client).not.toMatch(/updateIssue|getStatus|readComments|readDescription|readLabels|webhook/);
  expect(client).toContain('process.env.LINEAR_API_KEY');expect(client).not.toContain('NEXT_PUBLIC');});
 it('keeps delivery one-shot and upstream authority read-only',()=>{const delivery=read('lib/server/linearProjectionDelivery.ts');
  expect(delivery).not.toMatch(/while\s*\(|for\s*\(\s*;/);expect(delivery).not.toMatch(/setTimeout|setInterval|cron|webhook/);
  expect(delivery).toContain('readApprovedEngineeringRequest');expect(delivery).not.toMatch(/workflowIntake|sourceSubmissionId|rawOutput/);
  expect(delivery).toContain('findProjectedIssueByIdempotencyKey');expect(delivery).toContain('buildLinearCapabilityProjection');});
});
