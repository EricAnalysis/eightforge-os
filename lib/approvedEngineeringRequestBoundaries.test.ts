import { describe, expect, it } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
const root=process.cwd();
describe('approved engineering request boundaries',()=>{
 it('contains backlog-only authority and no operator-decision or execution dependency',()=>{const source=fs.readFileSync(path.join(root,'lib/approvedEngineeringRequest.ts'),'utf8');expect(source).toContain("authorizes: z.literal('backlog_projection')");for(const literal of ['authorizesCodeExecution: z.literal(false)','authorizesRepositoryWrites: z.literal(false)','authorizesMigrations: z.literal(false)','authorizesDeployment: z.literal(false)','authorizesCanonicalFactMutation: z.literal(false)','authorizesWorkflowOperationalDecision: z.literal(false)'])expect(source).toContain(literal);expect(source).not.toMatch(/getActorContext|codex|linear|operatorDecisionSuggestion/);});
 it('keeps exact-plan and exact-review reads independent of provider evidence and latest selection',()=>{const source=fs.readFileSync(path.join(root,'lib/server/approvedEngineeringRequestRead.ts'),'utf8');expect(source).toContain(".eq('id',p.data.reviewId)");expect(source).toContain(".eq('review_version',p.data.reviewVersion)");expect(source).not.toMatch(/raw_evidence|order\(|limit\(|latest/i);});
});
