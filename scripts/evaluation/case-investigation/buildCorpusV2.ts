/**
 * Case Investigation qualification contract v2: corpus construction and census.
 * Explicit, manual command. Never run in CI. ZERO provider calls.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/case-investigation/buildCorpusV2.ts -- \
 *     --out <empty directory OUTSIDE the repository> [--env-file <.env with production read access>]
 *
 * - conflict class: deterministic fixtures through the real canonical rule
 *   path (lib/evaluation/caseInvestigation/conflictFixtures.ts), served to the
 *   live context read by an in-memory read client.
 * - validator_failure class (only with --env-file): real production projects,
 *   read through the SAME live path (`readInvestigationContext` over
 *   `readResolutionQueue` and the precedence snapshot). The production client
 *   is wrapped by `readOnlyClient`: only `.from(table).select(...)` is
 *   reachable, every write method and every RPC throws. The key is read from
 *   the file into this process only; it is never placed in process.env.
 *
 * Every context is built for purpose `provider_investigation` with exactly the
 * `text_excerpts` class approved (the class activation requires), plus an
 * `operator_review` read for the human reviewers. Outputs hold customer text:
 * they go to --out, outside the repository. `corpus-manifest.repo.json` there
 * holds identities and digests only (check keys hashed) and is the file to commit.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';

import {
  buildConflictFixtureProject,
  CONFLICT_FIXTURE_PROJECTS,
  CONFLICT_FIXTURE_VERSION,
  FIXTURE_ORGANIZATION_ID,
} from '@/lib/evaluation/caseInvestigation/conflictFixtures';
import {
  CASE_INVESTIGATION_CONTRACT_V2,
  classifyCase,
  corpusCensus,
  type CorpusManifestEntry,
  PRODUCTION_CORPUS_ORGANIZATION_ID,
  PRODUCTION_CORPUS_PROJECTS,
  productionExclusion,
} from '@/lib/evaluation/caseInvestigation/corpusV2';
import { memoryReadClient, readOnlyClient } from '@/lib/evaluation/caseInvestigation/readClients';
import type { ResolutionCase } from '@/lib/resolution/resolutionCases';
import { CASE_INVESTIGATION_PROMPT_VERSION, PROVIDER_RANKABLE_ACTION_KINDS } from '@/lib/server/caseInvestigationRunner';
import { loadProjectDocumentPrecedenceSnapshot } from '@/lib/server/documentPrecedence';
import { readInvestigationContext } from '@/lib/server/investigationContextRead';
import { readResolutionQueue, type ResolutionReadClient } from '@/lib/server/resolutionQueueRead';
import { validatorRuleCatalogueFingerprint } from '@/lib/validator/ruleCatalogueFingerprint';

const FORBIDDEN_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', 'DATABASE_URL'];
const PINNED_SOURCES = [
  'lib/server/caseInvestigationRunner.ts',
  'lib/forgewing/runtime/caseInvestigationClient.ts',
  'lib/resolution/investigationContext.ts',
  'lib/server/investigationContextRead.ts',
  'lib/resolution/caseInvestigation.ts',
  'lib/evaluation/caseInvestigation/conflictFixtures.ts',
  'lib/evaluation/caseInvestigation/corpusV2.ts',
];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function readEnvFile(file: string): { url: string; key: string } {
  const values = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.replace(/^['"]|['"]$/g, ''));
  }
  const url = values.get('SUPABASE_URL') ?? values.get('NEXT_PUBLIC_SUPABASE_URL');
  const key = values.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('env file must define the Supabase URL and read credentials');
  return { url, key };
}

const approveTextExcerptsOnly = async (_admin: unknown, params: { contentClasses: readonly string[] }) =>
  ({ approved: params.contentClasses.every((contentClass) => contentClass === 'text_excerpts') }) as never;

type Source = Readonly<{
  source: CorpusManifestEntry['source'];
  organizationId: string;
  projectId: string;
  projectName: string;
  admin: ResolutionReadClient;
}>;

async function buildFromSource(source: Source, out: string, entries: CorpusManifestEntry[]) {
  // One real read per project, shared by every case on it (memoized, not re-implemented).
  const queue = readResolutionQueue({ organizationId: source.organizationId, projectId: source.projectId },
    { admin: source.admin, forgewingEnabled: true });
  const precedence = loadProjectDocumentPrecedenceSnapshot(source.admin as never,
    { organizationId: source.organizationId, projectId: source.projectId });
  const read = await queue;
  if (read.status !== 'ok') throw new Error(`${source.projectName}: queue read ${read.status}`);
  const cases = read.queue.cases.filter((entry) => entry.kind === 'validator_finding');
  for (const resolutionCase of cases) {
    const dependencies = {
      admin: source.admin, readQueue: (() => queue) as never, loadPrecedence: () => precedence,
      resolveDataPolicy: approveTextExcerptsOnly, forgewingEnabled: true,
    };
    const query = { organizationId: source.organizationId, projectId: source.projectId, caseId: resolutionCase.caseId };
    const provider = await readInvestigationContext({ ...query, purpose: 'provider_investigation' }, dependencies);
    const operator = await readInvestigationContext({ ...query, purpose: 'operator_review' }, dependencies);
    if (provider.status !== 'ok' || operator.status !== 'ok') throw new Error(`${resolutionCase.caseId}: context ${provider.status}`);
    const ruleId = resolutionCase.finding?.ruleId ?? 'unknown';
    // A decision-backed issue carries no evidence rows: its cited source is
    // the decision's own document (and governing document, when recorded).
    const decisionId = /^finding:decision:([0-9a-f-]{36})$/u.exec(resolutionCase.caseId)?.[1] ?? null;
    const decisionDocuments: string[] = [];
    if (decisionId) {
      const decision = await (source.admin as unknown as { from: (t: string) => { select: (c: string) => {
        eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { document_id?: string | null;
          details?: { applied_governing_document_id?: string | null } | null } | null; error: unknown }> } } } })
        .from('decisions').select('document_id, details').eq('id', decisionId).maybeSingle();
      if (decision.error) throw new Error(`${resolutionCase.caseId}: decision read failed`);
      for (const id of [decision.data?.document_id, decision.data?.details?.applied_governing_document_id]) {
        if (typeof id === 'string' && id) decisionDocuments.push(id);
      }
    }
    const citedDocumentIds = [...new Set([...resolutionCase.evidence.map((ref) => ref.documentId), resolutionCase.documentId,
      ...decisionDocuments].filter((id): id is string => typeof id === 'string' && id.length > 0))].sort();
    const entry: CorpusManifestEntry = {
      caseId: resolutionCase.caseId,
      qualificationClass: classifyCase({ ruleId }),
      source: source.source,
      projectId: source.projectId,
      projectName: source.projectName,
      ruleId,
      checkKey: resolutionCase.finding?.checkKey ?? '',
      rankableActionKinds: [...new Set(resolutionCase.actions.map((action) => action.kind))]
        .filter((kind) => PROVIDER_RANKABLE_ACTION_KINDS.has(kind)),
      citedDocumentIds,
      transmittedDigest: provider.context.transmittedDigest,
      readDigest: operator.context.readDigest,
      excluded: source.source === 'production'
        ? productionExclusion({ projectId: source.projectId, ruleId, evidenceDocumentIds: citedDocumentIds })
        : null,
    };
    entries.push(entry);
    const file = path.join(out, 'cases', `${sha256(entry.caseId).slice(0, 16)}.json`);
    writeFileSync(file, `${JSON.stringify({ entry, resolutionCase: resolutionCase as ResolutionCase,
      providerContext: provider.context, operatorContext: operator.context }, null, 2)}\n`);
  }
}

async function main() {
  const out = arg('--out');
  if (!out) throw new Error('--out <empty directory outside the repository> is required');
  const outDir = path.resolve(out);
  if (outDir.startsWith(path.resolve(process.cwd()) + path.sep)) throw new Error('--out must be outside the repository');
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error('--out must be empty');
  const present = FORBIDDEN_ENV.filter((name) => process.env[name]);
  if (present.length > 0) throw new Error(`refusing to run with ${present.join(', ')} in the environment (zero-call, read-only)`);
  mkdirSync(path.join(outDir, 'cases'), { recursive: true });

  const entries: CorpusManifestEntry[] = [];
  for (const project of CONFLICT_FIXTURE_PROJECTS) {
    const built = buildConflictFixtureProject(project);
    await buildFromSource({ source: 'conflict_fixture', organizationId: FIXTURE_ORGANIZATION_ID,
      projectId: built.projectId, projectName: project.name, admin: memoryReadClient(built.tables) as never }, outDir, entries);
  }
  const envFile = arg('--env-file');
  if (envFile) {
    const credentials = readEnvFile(envFile);
    const admin = readOnlyClient(createClient(credentials.url, credentials.key,
      { auth: { persistSession: false, autoRefreshToken: false } })) as unknown as ResolutionReadClient;
    for (const project of PRODUCTION_CORPUS_PROJECTS) {
      await buildFromSource({ source: 'production', organizationId: PRODUCTION_CORPUS_ORGANIZATION_ID,
        projectId: project.projectId, projectName: project.name, admin }, outDir, entries);
    }
  }

  // Fixture conflict cases are the conflict class; non-conflict findings the
  // fixtures also raise are not production cases and do not count.
  const corpus = entries.filter((entry) => entry.source === 'production' || entry.qualificationClass === 'conflict');
  const manifest = {
    contract: CASE_INVESTIGATION_CONTRACT_V2,
    builtAt: new Date().toISOString(),
    productionIncluded: Boolean(envFile),
    pins: {
      conflictFixtureVersion: CONFLICT_FIXTURE_VERSION,
      promptVersion: CASE_INVESTIGATION_PROMPT_VERSION,
      contextVersion: 'investigation_context_v1',
      validatorRuleCatalogueFingerprint: validatorRuleCatalogueFingerprint(),
      approvedContentClasses: ['text_excerpts'],
      sources: Object.fromEntries(PINNED_SOURCES.map((file) => [file, sha256(readFileSync(file))])),
    },
    census: corpusCensus(corpus),
    entries: corpus,
  };
  writeFileSync(path.join(outDir, 'corpus-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // The committable copy: check keys can quote customer text (descriptions,
  // invoice numbers), so they appear only as digests.
  const committable = { ...manifest,
    entries: corpus.map(({ checkKey, ...entry }) => ({ ...entry, checkKeySha256: sha256(checkKey) })) };
  writeFileSync(path.join(outDir, 'corpus-manifest.repo.json'), `${JSON.stringify(committable, null, 2)}\n`);
  console.log(JSON.stringify({ census: manifest.census, cases: corpus.length,
    byRule: Object.fromEntries([...new Map(corpus.filter((e) => !e.excluded).map((e) => [e.ruleId, 0]))].map(([rule]) =>
      [rule, corpus.filter((e) => !e.excluded && e.ruleId === rule).length])) }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
