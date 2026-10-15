import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Forgewing S5: every human-authority write is attributed to the verified
 * session, never to a request field.
 *
 * The database record functions accept the actor id as a parameter from a
 * service-role caller and check only membership or role (accepted residual
 * risk: any service-role code path could name a different actor; closing that
 * fully needs the database to verify a session-bound attestation, a larger
 * authority redesign). This guard keeps the application side of that
 * contract: each typed human route derives its actor from `getActorContext`,
 * and none reads an actor identity out of the request.
 */

const HUMAN_AUTHORITY_ROUTES = [
  'app/api/documents/[id]/facts/region-assertions/route.ts', // reviewed values
  'app/api/internal/forgewing-recovery-review/route.ts', // recovery proposal review
  'app/api/projects/[id]/resolution-cases/value-reading-review/route.ts', // value-reading reject/defer
  'app/api/internal/workflow-assessment-review/route.ts', // assessment review
  'app/api/internal/repository-engineering-reviews/route.ts', // engineering review
  'app/api/internal/improvement-lifecycle/fix-attestations/route.ts', // fix attestation
  'app/api/customer-header-mappings/approve/route.ts', // mapping approval
  'app/api/customer-header-mappings/[id]/activate/route.ts', // mapping activation
  'app/api/customer-header-mappings/[id]/withdraw/route.ts', // mapping withdrawal
  'app/api/decisions/[id]/status/route.ts', // finding / decision clearance
  'app/api/execution-items/[id]/outcome/route.ts', // execution outcome
  'app/api/projects/[id]/invoice-line-rate-link/route.ts', // rate-link closure
  'app/api/projects/[id]/document-precedence/route.ts', // relationship / precedence approval (+ proposal acceptance)
  'app/api/projects/[id]/relationship-proposals/route.ts', // relationship proposal generation (requested_by)
  'app/api/projects/[id]/relationship-proposals/[proposalId]/review/route.ts', // proposal reject / defer
] as const;

const code = (relative: string) => readFileSync(relative, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Actor identities that would come from the request instead of the session. */
const REQUEST_ACTOR = /\b(?:body|payload|json|input|parsed(?:\.data)?|request\.body|req\.body|data)\s*(?:\?\.|\.)\s*(?:actorId|actor_id|reviewerActorId|reviewer_actor_id|recordedBy|recorded_by|approvedBy|approved_by|userId|user_id|attestedBy|attested_by)\b/;

describe('human-authority actor attribution (S5)', () => {
  it.each(HUMAN_AUTHORITY_ROUTES)('%s derives its actor from the verified session', (route) => {
    expect(code(route)).toContain('getActorContext(');
  });

  it.each(HUMAN_AUTHORITY_ROUTES)('%s never reads an actor identity from the request', (route) => {
    expect(code(route)).not.toMatch(REQUEST_ACTOR);
  });

  it('no product code grants a Forgewing entitlement or data-processing authorization', () => {
    // Activation is an operator decision recorded on a trusted connection,
    // with recorded_by (required for grants since S5). The gate modules only read.
    for (const module of ['lib/server/forgewingEntitlement.ts', 'lib/server/forgewingGates.ts']) {
      expect(code(module)).not.toMatch(/\.insert\(|\.upsert\(|\.update\(/);
    }
    const migration = readFileSync('supabase/migrations/20261014160000_forgewing_activation_ledger_actors.sql', 'utf8');
    expect(migration).toContain('CHECK (enabled IS NOT TRUE OR recorded_by IS NOT NULL) NOT VALID');
    expect(migration).toContain('CHECK (approved IS NOT TRUE OR recorded_by IS NOT NULL) NOT VALID');
  });
});
