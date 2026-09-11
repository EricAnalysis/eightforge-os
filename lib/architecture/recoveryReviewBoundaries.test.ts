import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RECOVERY_PROPOSAL_TABLE,
  RECOVERY_REVIEW_TABLE,
} from '@/lib/server/effectiveRecoveryConfirmations';
import { RECOVERY_PROPOSAL_WRITE_FUNCTION }
  from '@/lib/server/forgewingRecoveryProposalPersistence';
import { RECOVERY_REVIEW_WRITE_FUNCTION } from '@/lib/server/forgewingRecoveryReview';

/**
 * Phase 12 architecture guards.
 *
 * The whole design rests on a small number of things being true of the code as
 * a whole rather than of any one module: Forgewing proposes, a human confirms,
 * and EightForge reprocesses deterministically. Each guard below fails if some
 * future edit quietly moves authority.
 */

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const SOURCE_EXTENSION = /\.(?:ts|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx)$/;
const AUTHORITY_REMEDIATION = readFileSync(path.join(
  MIGRATIONS,
  '20260910123806_phase_12_recovery_proposal_source_authority.sql',
), 'utf8');

function walk(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    if (['node_modules', '.next', '.git', '.claude'].includes(entry)) return [];
    if (statSync(absolute).isDirectory()) return walk(absolute);
    return SOURCE_EXTENSION.test(entry) ? [absolute] : [];
  });
}

type SourceFile = { relative: string; text: string };

function productionFiles(): SourceFile[] {
  return ['app', 'components', 'lib', 'scripts']
    .flatMap((directory) => walk(path.join(ROOT, directory)))
    .map((absolute) => ({
      relative: path.relative(ROOT, absolute).split(path.sep).join('/'),
      text: readFileSync(absolute, 'utf8'),
    }))
    .filter(({ relative }) => !TEST_FILE.test(relative));
}

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(path.join(MIGRATIONS, name), 'utf8'))
    .join('\n');
}

/** Modules permitted to touch the recovery tables at all. */
const RECOVERY_PERSISTENCE_MODULES = new Set([
  'lib/server/forgewingRecoveryProposalPersistence.ts',
  'lib/server/forgewingRecoveryReview.ts',
  'lib/server/effectiveRecoveryConfirmations.ts',
  'lib/server/forgewingRecoveryReviewRead.ts',
]);

/**
 * Paths that produce or read canonical truth. If any of them learned about
 * recovery, "recovery" would have become a second truth path resolved at read
 * time -- the exact defect the reconstruction seam exists to avoid.
 */
const CANONICAL_ROOTS = [
  'lib/canonical', 'lib/contracts', 'lib/validator', 'lib/projectFacts',
  'lib/truthQuery', 'lib/effectiveFacts', 'lib/ask',
] as const;

const RECOVERY_VOCABULARY = [
  RECOVERY_PROPOSAL_TABLE,
  RECOVERY_REVIEW_TABLE,
  'recovery_candidates',
  'RecoveryCandidateV2',
  'resolveEffectiveRecoveryConfirmations',
  'loadConfirmedRateObservations',
  'ConfirmedRecovery',
  'confirmedRateObservations',
  'confirmedRecoveryCandidates',
];

const VISUAL_SOURCE_MODULES = [
  'components/documents/RecoveryReviewPanel.tsx',
  'components/evaluation/forgewing/A3LinkagePdfPage.tsx',
  'components/recovery/SourceEvidencePage.tsx',
  'lib/recovery/sourceGeometry.ts',
  'lib/recovery/visualSourceEvidence.ts',
  'lib/server/forgewingRecoveryReviewRead.ts',
] as const;

describe('recovery review architecture boundaries', () => {
  it('keeps recovery tables inside the four persistence seams', () => {
    const offenders = productionFiles().filter(({ relative, text }) =>
      !RECOVERY_PERSISTENCE_MODULES.has(relative)
      && (text.includes(RECOVERY_PROPOSAL_TABLE) || text.includes(RECOVERY_REVIEW_TABLE)));
    expect(offenders.map(({ relative }) => relative)).toEqual([]);
  });

  it('keeps every canonical and validator path unaware that recovery exists', () => {
    const offenders = productionFiles()
      .filter(({ relative }) => CANONICAL_ROOTS.some((root) => relative.startsWith(`${root}/`)))
      .flatMap(({ relative, text }) =>
        RECOVERY_VOCABULARY.filter((term) => text.includes(term))
          .map((term) => `${relative} -> ${term}`));
    // No read-time overlay: nothing downstream may consult a recovery record
    // and substitute a value. Recovery is resolved during reconstruction, and
    // what reaches these paths is an ordinary priced row.
    expect(offenders).toEqual([]);
  });

  it('lets only the resolver supply confirmed observations to reconstruction', () => {
    const suppliers = productionFiles()
      .filter(({ text }) => text.includes('confirmedRateObservations'))
      .map(({ relative }) => relative)
      .sort();
    expect(suppliers).toEqual([
      // The reconstruction seam itself, the resolver that produces the set,
      // and the extraction function that forwards it. The pipelines no longer
      // name it: they take the whole selection set from the resolver instead.
      'lib/extraction/pdf/pagePricedScheduleReconstruction.ts',
      'lib/server/documentExtraction.ts',
      'lib/server/effectiveRecoveryConfirmations.ts',
    ]);
  });

  it('lets only the resolver and extraction seam carry confirmed V2 candidates', () => {
    const suppliers = productionFiles()
      .filter(({ text }) => text.includes('confirmedRecoveryCandidates'))
      .map(({ relative }) => relative)
      .sort();
    expect(suppliers).toEqual([
      'lib/extraction/pdf/pagePricedScheduleReconstruction.ts',
      'lib/server/documentExtraction.ts',
      'lib/server/effectiveRecoveryConfirmations.ts',
    ]);
  });

  it('resolves recovery selections through the V2 loader in BOTH process entry points', () => {
    // Both pipelines must load the same selection set. A pipeline still calling
    // the V1-only loader would silently discard every candidate confirmation:
    // a human accepts a cluster, reprocesses, and the row stays withheld with
    // no diagnostic. That is a fail-open on human authority, so it is pinned.
    const entryPoints = [
      'app/api/jobs/process/[jobId]/route.ts',
      'lib/pipeline/processDocument.ts',
    ];
    for (const relative of entryPoints) {
      const file = productionFiles().find((entry) => entry.relative === relative);
      expect(file, `${relative} is missing`).toBeDefined();
      expect(file!.text, relative).toContain('loadConfirmedRecoverySelections');
      expect(file!.text, relative).not.toContain('loadConfirmedRateObservations');
    }
  });

  it('never lets a browser supply a confirmed observation set', () => {
    const clientModules = productionFiles().filter(({ relative, text }) =>
      (relative.startsWith('components/') || text.startsWith("'use client'"))
      && text.includes('confirmedRateObservations'));
    expect(clientModules.map(({ relative }) => relative)).toEqual([]);
  });

  it('keeps the review route and surface away from every provider client', () => {
    const providerTerms = [
      '@/lib/server/ai/claudeClient', '@/lib/forgewing/runtime/client',
      '@anthropic-ai/sdk', 'callClaudeFor', 'runForgewingPricing',
    ];
    for (const relative of [
      'app/api/internal/forgewing-recovery-review/route.ts',
      'components/documents/RecoveryReviewPanel.tsx',
      'lib/server/forgewingRecoveryReview.ts',
      'lib/server/forgewingRecoveryReviewRead.ts',
      'lib/server/effectiveRecoveryConfirmations.ts',
      ...VISUAL_SOURCE_MODULES,
    ]) {
      const text = readFileSync(path.join(ROOT, relative), 'utf8');
      for (const term of providerTerms) {
        expect(`${relative}:${text.includes(term)}`).toBe(`${relative}:false`);
      }
    }
  });

  it('keeps visual source verification outside canonical and validator authority', () => {
    for (const relative of VISUAL_SOURCE_MODULES) {
      const text = readFileSync(path.join(ROOT, relative), 'utf8');
      expect(text, relative).not.toMatch(/from ['"]@\/lib\/(?:canonical|validator|projectFacts|truthQuery|effectiveFacts)/);
    }
  });

  it('has one canonical source-space converter and makes every viewer import it', () => {
    const definitions = productionFiles().filter(({ text }) =>
      text.includes('export function toViewportRect('));
    expect(definitions.map(({ relative }) => relative)).toEqual([
      'lib/recovery/sourceGeometry.ts',
    ]);
    for (const relative of [
      'components/evaluation/forgewing/A3LinkagePdfPage.tsx',
      'components/recovery/SourceEvidencePage.tsx',
    ]) {
      const text = readFileSync(path.join(ROOT, relative), 'utf8');
      expect(text, relative).toContain('SourceEvidencePage');
    }
    expect(readFileSync(path.join(
      ROOT, 'components/recovery/SourceEvidencePage.tsx'), 'utf8'))
      .toContain("from '@/lib/recovery/sourceGeometry'");
  });

  it('forbids fuzzy, nearest, and text-based visual evidence rebinding', () => {
    const forbidden = /fuzzy|nearest|textmatch|text_match|rebind/i;
    const offenders = VISUAL_SOURCE_MODULES.flatMap((relative) => {
      const code = readFileSync(path.join(ROOT, relative), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return forbidden.test(code) ? [relative] : [];
    });
    expect(offenders).toEqual([]);
  });

  it('keeps browser review authority candidate-id-only', () => {
    const panel = readFileSync(
      path.join(ROOT, 'components/documents/RecoveryReviewPanel.tsx'), 'utf8');
    const requestStart = panel.indexOf(
      "authorizedFetch('/api/internal/forgewing-recovery-review'");
    const requestEnd = panel.indexOf('    });', requestStart);
    expect(requestStart).toBeGreaterThan(0);
    const request = panel.slice(requestStart, requestEnd);
    expect(request).toContain('confirmedCandidateId');
    for (const forbidden of [
      'boundingBox', 'orderedObservationIds', 'rawText', 'targetRowIdentity',
      'pageRepresentationDigest', 'sourceArtifactId', 'targetContextEvidence',
    ]) expect(request).not.toContain(forbidden);
  });

  it('requires authenticated actor context before source-file access', () => {
    const route = readFileSync(
      path.join(ROOT, 'app/api/documents/[id]/file/route.ts'), 'utf8');
    expect(route).not.toContain("searchParams.get('orgId')");
    expect(route.indexOf('getActorContext(request)')).toBeGreaterThan(0);
    expect(route.indexOf('getActorContext(request)')).toBeLessThan(
      route.indexOf('getSupabaseAdmin()'));
    expect(route).toContain('actorResult.actor.organizationId');
  });

  it('keeps recovery candidate contract changes on the fresh-replay path', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/migration-fresh-replay.yml'), 'utf8');
    const replay = readFileSync(
      path.join(ROOT, 'scripts/verify-step0-migration-replay.sh'), 'utf8');
    for (const pathFilter of [
      "'lib/extraction/recovery/**'",
      "'scripts/verify-phase13-recovery-v2-from-postgres.ts'",
      "'scripts/verify-phase14-recovery-target-context-from-postgres.ts'",
    ]) expect(workflow).toContain(pathFilter);
    expect(replay).toContain('scripts/verify-phase13-recovery-v2-from-postgres.ts');
    expect(replay).toContain('scripts/verify-phase14-recovery-target-context-from-postgres.ts');
  });

  it('offers no control that asks Forgewing to regenerate a proposal', () => {
    // Comments are stripped: this is about what the surface offers an
    // operator, not about what the module says it does not do.
    const panel = readFileSync(
      path.join(ROOT, 'components/documents/RecoveryReviewPanel.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(/regenerate|ask forgewing|try again|re-?propose/i.test(panel)).toBe(false);
  });

  it('keeps recovery review out of Linear projection', () => {
    const offenders = productionFiles().filter(({ text }) =>
      /linear/i.test(text) && RECOVERY_VOCABULARY.some((term) => text.includes(term)));
    expect(offenders.map(({ relative }) => relative)).toEqual([]);
  });

  it('keeps the shadow blob cleanup away from the durable records', () => {
    // The cleanup deletes storage objects. If it could reach a table or an RPC
    // it could erase the only reviewable copy of a proposal, which is the TTL
    // hazard this phase exists to remove.
    const cleanup = readFileSync(
      path.join(ROOT, 'lib/extraction/persistence/forgewingShadowCleanup.ts'), 'utf8');
    expect(cleanup.includes('.from(')).toBe(true); // storage.from(bucket)
    expect(/\.from\(\s*['"`]/.test(cleanup)).toBe(false); // never a table literal
    expect(cleanup.includes('.rpc(')).toBe(false);
    expect(cleanup.includes(RECOVERY_PROPOSAL_TABLE)).toBe(false);
    expect(cleanup.includes(RECOVERY_REVIEW_TABLE)).toBe(false);
  });

  it('makes the durable proposal independent of the shadow blob succeeding', () => {
    const shadow = readFileSync(
      path.join(ROOT, 'lib/extraction/persistence/complianceShadow.ts'), 'utf8');
    // The durable write is not nested inside a blob-success branch: an expired
    // or failed blob must not remove a reviewable proposal.
    const guardIndex = shadow.indexOf(
      "[forgewingRecovery] non-fatal pricing recovery persistence outcome");
    expect(guardIndex).toBeGreaterThan(0);
    // The call site, not the import: it sits after the blob-outcome branch has
    // already closed, so a failed blob does not skip it.
    expect(shadow.indexOf('buildDurableRecoveryProposal({', guardIndex))
      .toBeGreaterThan(guardIndex);
    expect(shadow.includes("persisted.status === 'persisted' ? persisted.path : null")).toBe(true);
  });
});

describe('recovery persistence SQL posture', () => {
  const sql = migrationSql();

  for (const table of [RECOVERY_PROPOSAL_TABLE, RECOVERY_REVIEW_TABLE]) {
    it(`denies browser DML and enables RLS on ${table}`, () => {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(
        `REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated, service_role`);
      expect(sql).toContain(`GRANT SELECT ON TABLE public.${table} TO service_role`);
      // No INSERT/UPDATE/DELETE grant to anyone: writes go through the
      // SECURITY DEFINER functions or not at all.
      expect(new RegExp(`GRANT\\s+(?:INSERT|UPDATE|DELETE)[^;]*${table}`, 'i').test(sql))
        .toBe(false);
    });

    it(`makes ${table} immutable`, () => {
      expect(sql).toContain(
        `BEFORE UPDATE OR DELETE ON public.${table}`);
    });
  }

  for (const fn of [RECOVERY_PROPOSAL_WRITE_FUNCTION, RECOVERY_REVIEW_WRITE_FUNCTION]) {
    it(`keeps ${fn} a service-role SECURITY DEFINER seam`, () => {
      const body = sql.slice(sql.indexOf(`CREATE FUNCTION public.${fn}(`));
      expect(body).toContain("SECURITY DEFINER SET search_path = ''");
      expect(body).toContain("IF auth.role() <> 'service_role' THEN");
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(`);
      expect(new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*TO (?:anon|authenticated|PUBLIC)`,
      ).test(sql)).toBe(false);
    });
  }

  it('allocates review versions under an advisory lock, never latest-wins', () => {
    const review = sql.slice(sql.indexOf(`CREATE FUNCTION public.${RECOVERY_REVIEW_WRITE_FUNCTION}(`));
    expect(review).toContain('pg_advisory_xact_lock');
    expect(review).toContain('coalesce(max(r.review_version), 0) + 1');
    // The pin is exact: a review is bound to one proposal id AND digest.
    expect(review).toContain('WHERE proposal_id = p_proposal_id AND proposal_digest_sha256 = p_proposal_digest_sha256');
  });

  it('derives the confirmed value from proposal evidence rather than the caller', () => {
    const review = sql.slice(sql.indexOf(`CREATE FUNCTION public.${RECOVERY_REVIEW_WRITE_FUNCTION}(`));
    // There is no p_confirmed_raw_text parameter at all, and the stored text is
    // read out of the pinned proposal's own eligible evidence.
    expect(review.slice(0, review.indexOf('LANGUAGE plpgsql')))
      .not.toContain('p_confirmed_raw_text');
    expect(review).toContain("SELECT e->>'rawText' INTO v_confirmed_text");
    expect(review).toContain("AND (e->>'eligible')::boolean");
  });

  it('binds accept to the proposed observation and modify to a different one', () => {
    const review = sql.slice(sql.indexOf(`CREATE FUNCTION public.${RECOVERY_REVIEW_WRITE_FUNCTION}(`));
    expect(review).toContain("IF p_disposition = 'accepted' AND p_confirmed_observation_id <> v_proposal.selected_observation_id");
    expect(review).toContain("IF p_disposition = 'modified' AND p_confirmed_observation_id = v_proposal.selected_observation_id");
  });

  it('lets only accepted and modified carry a confirmation', () => {
    expect(sql).toContain(
      "CHECK ((disposition IN ('accepted','modified')) = (confirmed_observation_id IS NOT NULL)");
  });

  it('closes proposal source authority and selectable evidence in the remediation migration', () => {
    expect(AUTHORITY_REMEDIATION).toContain('artifact.source_document_id = p_source_document_id');
    expect(AUTHORITY_REMEDIATION).toContain('artifact.organization_id = p_organization_id');
    expect(AUTHORITY_REMEDIATION).toContain('document.organization_id = p_organization_id');
    expect(AUTHORITY_REMEDIATION).toContain("evidence->'eligible' = 'true'::jsonb");
    expect(AUTHORITY_REMEDIATION).toContain("evidence->>'rawText' = p_proposed_value");
  });

  it('makes proposal digest collision checks exact and null-safe', () => {
    for (const field of [
      'organization_id', 'source_document_id', 'source_artifact_id', 'extraction_snapshot_id',
      'physical_page_number', 'proposal_id', 'schema_version', 'selected_observation_id',
      'proposed_value', 'normalized_value', 'page_representation_digest', 'evidence',
      'alternative_observation_ids', 'certainty', 'reason_category', 'provider_model',
      'prompt_template_id', 'prompt_template_version', 'shadow_artifact_path',
    ]) {
      expect(AUTHORITY_REMEDIATION).toContain(
        `v_existing.${field} IS DISTINCT FROM p_${field}`,
      );
    }
  });

  it('authorizes the exact proposal before returning an idempotent review', () => {
    const exactProposal = AUTHORITY_REMEDIATION.indexOf(
      'WHERE proposal_id = p_proposal_id AND proposal_digest_sha256 = p_proposal_digest_sha256',
    );
    const existingReview = AUTHORITY_REMEDIATION.indexOf(
      'WHERE review_request_digest_sha256 = p_review_request_digest_sha256',
    );
    expect(exactProposal).toBeGreaterThan(0);
    expect(existingReview).toBeGreaterThan(exactProposal);
    expect(AUTHORITY_REMEDIATION).toContain(
      'v_existing.proposal_row_id IS DISTINCT FROM v_proposal.id',
    );
  });
});
