import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Forgewing B4.2 authority guards. A value-reading proposal is AI_PROPOSED and
 * non-authoritative. Exactly one road leads from it to truth: an operator's
 * human fact assertion that cites it, verified by the database. This phase
 * stores and verifies only; it reaches no provider, policy or budget.
 */

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const MIGRATION = 'supabase/migrations/20261004220000_forgewing_value_reading_proposals.sql';
const B42_FILES = ['lib/server/valueReadingProposals.ts', 'lib/resolution/valueReadingLifecycle.ts'];

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel.split(path.sep).join('/'));
    }
  };
  for (const root of ['app', 'lib', 'components']) walk(root);
  return out;
}

describe('B4.2 value-reading authority boundaries', () => {
  it.each(B42_FILES)('%s reaches no provider, client, policy or budget', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/from '@\/lib\/forgewing\//);
    expect(source).not.toMatch(/@anthropic-ai|callClaude|forgewing\/runtime|\bfetch\(/);
    expect(source).not.toMatch(
      /reserveForgewingProviderCall|reserve_forgewing_provider_call|organization_forgewing_data_policy_events|forgewingGates/);
    expect(source).not.toMatch(/getSupabaseAdmin/);
  });

  it('only the value-reading module writes proposals or their reviews', () => {
    const writers = productionFiles().filter((file) =>
      /record_forgewing_value_reading_(proposal|review)|RECORD_VALUE_READING_(PROPOSAL|REVIEW)_RPC/.test(read(file)));
    expect(writers).toEqual(['lib/server/valueReadingProposals.ts']);
  });

  it('no product code supplies a final AI review origin; the database derives it', () => {
    const offenders = productionFiles().filter((file) => /p_review_origin:\s*'ai_proposed_operator/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('truth, pricing and the Validator never read value readings', () => {
    const coreRoots = ['lib/canonical/', 'lib/validator/', 'lib/contracts/', 'lib/humanFactAssertions/',
      'lib/extraction/', 'lib/projectFacts/', 'lib/truthQuery/', 'lib/effectiveFacts/'];
    const offenders = productionFiles().filter((file) => coreRoots.some((root) => file.startsWith(root))
      && /valueReadingProposals|valueReadingLifecycle|priced_value_reading|forgewing_recovery_proposals/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('the impact preview never carries a cited proposal into its hypothetical row', () => {
    const request = read('lib/server/regionAssertionRequest.ts');
    const hypothetical = request.slice(request.indexOf('export function hypotheticalRegionAssertionRow'));
    expect(hypothetical).toMatch(/review_origin: 'operator_entered'/);
    expect(hypothetical).toMatch(/forgewing_proposal_id: null/);
  });

  it('the review table can only reject or defer a value reading, at the database', () => {
    const migration = read(MIGRATION);
    expect(migration).toMatch(/p_disposition NOT IN \('rejected', 'deferred'\)/);
    expect(migration).toMatch(/CREATE TRIGGER forgewing_recovery_proposal_reviews_value_reading_guard\s+BEFORE INSERT/);
    expect(migration).toMatch(/NEW\.disposition IN \('accepted', 'modified'\)[\s\S]*proposal\.proposal_version = 3/);
  });

  it('the engine reaches no provider client, wires no provider and never writes truth (B4.3)', () => {
    const engine = read('lib/server/valueReadingEngine.ts');
    expect(engine).not.toMatch(/from '@\/lib\/forgewing\//);
    expect(engine).not.toMatch(/@anthropic-ai|callClaude|forgewing\/runtime|\bfetch\(|getSupabaseAdmin/);
    expect(engine).not.toMatch(/recordRegionBoundAssertion|record_region_bound_human_fact_assertion|human_fact_assertions'/);
    expect(engine).not.toMatch(/organization_forgewing_data_policy_events|FORGEWING_DATA_POLICY_EVENTS_TABLE/);
    // No default provider or renderer: both are injected, and B4.3 injects only fixtures.
    expect(engine).toMatch(/const provider = dependencies\.provider \?\? null;/);
    expect(engine).toMatch(/if \(!provider \|\| !dependencies\.renderRegionImage\)/);
  });

  it('only the authenticated workspace request route runs the engine; no production caller overrides its gates (B4.4)', () => {
    const files = productionFiles().filter((file) => file !== 'lib/server/valueReadingEngine.ts');
    expect(files.filter((file) => /runValueReading/.test(read(file)))).toEqual([
      'app/api/projects/[id]/resolution-cases/value-reading/route.ts',
    ]);
    // The renderer shares the engine's crop-spec type; nothing else imports the engine.
    expect(files.filter((file) => /from '@\/lib\/server\/valueReadingEngine'/.test(read(file)))).toEqual([
      'app/api/projects/[id]/resolution-cases/value-reading/route.ts',
      'lib/server/valueReadingRegionRenderer.ts',
    ]);
    expect(files.filter((file) => /resolveEligibility\s*:|\breserve\s*:/.test(read(file)))).toEqual([]);
  });

  it('each outcome shape has exactly one writer (B4.3)', () => {
    const recovery = productionFiles().filter((file) => /record_forgewing_recovery_generation_outcome/.test(read(file)));
    expect(recovery).toEqual(['lib/server/forgewingRecoveryGenerationOutcomePersistence.ts']);
    const valueReading = productionFiles().filter((file) =>
      /record_forgewing_value_reading_outcome|RECORD_VALUE_READING_OUTCOME_RPC/.test(read(file)));
    expect(valueReading).toEqual(['lib/server/valueReadingProposals.ts']);
  });

  it('every resolved request records an outcome; only unresolved cases record nothing (B4.3)', () => {
    const engine = read('lib/server/valueReadingEngine.ts');
    const run = engine.slice(engine.indexOf('export async function runValueReading'));
    // Every completed path goes through finish(), which writes the outcome.
    const completions = run.match(/return finish\(/g) ?? [];
    expect(completions.length).toBeGreaterThanOrEqual(12);
    expect(run.match(/status: 'completed'/g)).toHaveLength(2);
    expect(run).toMatch(/if \(!resolved\.ok\) return \{ status: 'not_resolved', reason: resolved\.reason \};/);
    // Deployment refusals are recorded too.
    expect(engine).toMatch(/kill_switch_off: \{ code: 'recovery_disabled', reason: 'kill_switch_off' \}/);
    expect(engine).toMatch(/activation_disabled: \{ code: 'activation_not_allowed', reason: 'activation_disabled' \}/);
  });

  it('pins the B4.5 invariant: the request digest binds the exact rendered bytes', () => {
    const engine = read('lib/server/valueReadingEngine.ts');
    const run = engine.slice(engine.indexOf('export async function runValueReading'));
    expect(engine).toMatch(/renderDigestSha256: params\.renderDigestSha256,/);
    expect(engine).not.toMatch(/renderDigestSha256: null,/);
    // A request cannot be built without the digest of the image bytes.
    expect(engine).toMatch(/if \(!SHA256_HEX\.test\(params\.renderDigestSha256\)\) throw/);
    // The digest is the engine's own hash of the bytes it sends, never the renderer's claim.
    expect(run).toMatch(/const renderDigestSha256 = createHash\('sha256'\)\.update\(image\.bytes\)\.digest\('hex'\);/);
    // Order: gates, render, digest, then reuse, budget and the call, all keyed by that digest.
    const order = ['GATE_OUTCOMES[eligibility.reason]', 'dependencies.renderRegionImage(crop)',
      'const renderDigestSha256 =', 'buildValueReadingRequest({', 'loadValueReadingProposalByRequestDigest',
      'reserveForgewingProviderCall)', 'callWithTimeout(provider'];
    const positions = order.map((marker) => run.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(run).toMatch(/renderDigestSha256,\n\s+model: request\.model,/);
  });

  it('constructs the provider and renderer only in the authenticated Ask route (B4.5)', () => {
    const files = productionFiles();
    expect(files.filter((file) => /createClaudeValueReadingProvider\(/.test(read(file)))
      .filter((file) => file !== 'lib/forgewing/runtime/valueReadingClient.ts'))
      .toEqual(['app/api/projects/[id]/resolution-cases/value-reading/route.ts']);
    expect(files.filter((file) => /createValueReadingRegionRenderer\(|loadVerifiedValueReadingSource\(/.test(read(file)))
      .filter((file) => file !== 'lib/server/valueReadingRegionRenderer.ts'))
      .toEqual(['app/api/projects/[id]/resolution-cases/value-reading/route.ts']);
    const route = read('app/api/projects/[id]/resolution-cases/value-reading/route.ts');
    expect(route).toContain('includeTextExcerpts: false');
    expect(route).toContain('getActorContext(req)');
  });

  it('keeps the provider contract pure and the adapter away from the engine, persistence and truth (B4.5)', () => {
    expect(read('lib/valueReadingContract.ts')).not.toMatch(/^import /m);
    const adapter = read('lib/forgewing/runtime/valueReadingClient.ts');
    expect(adapter).not.toMatch(/valueReadingEngine|valueReadingProposals|forgewingGates|supabase|getSupabaseAdmin|human_fact_assertions/i);
    // One image, one call: no SDK retries behind the engine's single reservation.
    expect(adapter).toMatch(/maxRetries: 0/);
    expect(adapter).toMatch(/temperature: 0/);
    expect(adapter).toMatch(/if \(sha256Hex\(request\.image\.bytes\) !== request\.renderDigestSha256\) throw/);
  });

  it('draws only from bytes that hash to the bound artifact (B4.5)', () => {
    const renderer = read('lib/server/valueReadingRegionRenderer.ts');
    expect(renderer).toMatch(/return sha256Hex\(bytes\) === artifactRow\.source_sha256 \? bytes : null;/);
    expect(renderer).toMatch(/\.eq\('id', spec\.sourceArtifactId\)\.eq\('organization_id', spec\.organizationId\)/);
    expect(renderer).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
  });

  it('activates nothing: the value-reading ceiling stays disabled until B4.6 qualifies it', () => {
    expect(read('lib/server/forgewingGates.ts')).toMatch(
      /qualification: 'unqualified',\s+qualificationCeiling: 'disabled',/);
  });

  it('the B4.5 outcome migration widens one predicate and nothing else', () => {
    const migration = read('supabase/migrations/20261005120000_forgewing_value_reading_unrendered_evidence.sql');
    expect(migration.replace(/--.*$/gm, '')).not.toMatch(/CREATE|GRANT|REVOKE|UPDATE public\.|DELETE FROM|DROP (TABLE|COLUMN|FUNCTION|TRIGGER)/i);
    expect(migration.match(/DROP CONSTRAINT/g)).toHaveLength(1);
    expect(migration).toMatch(/OR \(outcome_code = 'evidence_binding_failed' AND NOT provider_invoked\)\)/);
    // The rest of the shape is the deployed one, unchanged.
    const deployed = read('supabase/migrations/20261004230000_forgewing_value_reading_outcomes.sql');
    const shape = (sql: string) => sql.slice(sql.indexOf('ADD CONSTRAINT forgewing_generation_outcomes_value_reading_shape'))
      .split('END);')[0]!.replace(/\n\s*-- B4\.5:.*\n\s*OR \(outcome_code = 'evidence_binding_failed' AND NOT provider_invoked\)\)/, ')')
      .replace(/\s+/g, ' ');
    expect(shape(migration)).toBe(shape(deployed));
  });

  it('the outcomes migration only adds, and only for value readings', () => {
    const migration = read('supabase/migrations/20261004230000_forgewing_value_reading_outcomes.sql');
    expect(migration).not.toMatch(/DROP (TABLE|COLUMN|TRIGGER|FUNCTION)|CREATE OR REPLACE FUNCTION/i);
    expect([...migration.matchAll(/GRANT [^;]*;/gi)].map((match) => match[0].replace(/\s+/g, ' ')))
      .toEqual(['GRANT EXECUTE ON FUNCTION public.record_forgewing_value_reading_outcome( uuid, uuid, uuid, text, integer, text, text, text, uuid, text, text, text, boolean, text) TO service_role;']);
    expect(migration).toMatch(/num_nonnulls\(anchor_key, request_digest_sha256, requested_by, proposal_id\) = 0/);
    expect(migration).toMatch(/OR \(recovery_type = 'priced_value_reading' AND outcome_code IN \(/);
  });

  it('is forward-only and additive', () => {
    const migration = read(MIGRATION);
    expect(migration).not.toMatch(/DROP (TABLE|COLUMN|TRIGGER|FUNCTION)/i);
    expect(migration).not.toMatch(/\bUPDATE public\.|\bDELETE FROM/i);
    expect(migration).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*(forgewing_recovery|human_fact_assertions)/i);
    // Recovery versions 1 and 2 keep requiring certainty and a provider model.
    expect(migration.match(/AND certainty IS NOT NULL\s+AND provider_model IS NOT NULL\)/g)).toHaveLength(2);
  });
});
