import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { buildRepositoryPlanFoundation, type RepositoryPlanFoundationInput } from '@/lib/repositoryPlanFoundation';
import type { RepositoryClassification } from '@/lib/repositoryPlanEvidence';
import type { WorkflowImplementationPlanArtifact } from '@/lib/workflowImplementationPlan';
import { verifyRepositorySnapshot } from './repositoryPlanSnapshot';
import { collectCommittedContent } from './repositoryPlanContentCollector';

const actualCollectorTest = process.env.EIGHTFORGE_VERIFY_ACTUAL_COLLECTOR === '1' ? it : it.skip;

actualCollectorTest('collects exact committed blobs rather than autocrlf working-tree bytes', () => {
  const repositoryRoot = process.cwd();
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
    NODE_ENV: process.env.NODE_ENV,
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
  };
  const gitText = (...args: string[]) => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
    cwd: repositoryRoot, env, encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const gitBytes = (...args: string[]) => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
    cwd: repositoryRoot, env, windowsHide: true, shell: false,
    timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const trackedStatus = () => gitText('status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none');
  const before = trackedStatus();
  expect(before, 'Opt-in collector gate requires clean tracked state').toBe('');
  const commitSha = gitText('rev-parse', '--verify', 'HEAD^{commit}').trim();
  const fixtures = [
    ['EXTRACT', 'lib/documentTypes.ts'],
    ['HUMAN', 'lib/types/workflow.ts'],
    ['RULE', 'lib/rules/index.ts'],
  ] as const;
  const tree = parseTree(gitBytes('ls-tree', '-r', '-z', '--full-tree', commitSha));
  const verified = verifyRepositorySnapshot(repositoryRoot, commitSha);
  expect(verified.ok).toBe(true);
  if (!verified.ok) return;
  const snapshot = verified.snapshot;
  const bundles = [];
  for (const [classification, filePath] of fixtures) {
    const blobSha = tree.get(filePath);
    expect(blobSha, `fixture must exist in exact commit tree: ${filePath}`).toMatch(/^[a-f0-9]{40}$/);
    const foundation = buildRepositoryPlanFoundation({ trustedPlanV1: planV1(classification), repositorySnapshot: snapshot,
      manifest: [{ filePath, commitSha, blobSha: blobSha!, classification }],
      evidence: [{ filePath, commitSha, classification, evidenceKind: evidenceKind(classification),
        reason: 'Stable actual-checkout collector fixture' }],
    } as RepositoryPlanFoundationInput);
    expect(foundation.ok).toBe(true);
    if (!foundation.ok) return;
    const result = collectCommittedContent({ foundation: foundation.artifact, snapshot, classification, repositoryRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.files).toHaveLength(1);
    expect(result.bundle.classification).toBe(classification);
    expect(result.bundle.files[0]!.filePath).toBe(filePath);
    const rawBlob = gitBytes('cat-file', 'blob', blobSha!);
    expect(result.bundle.files[0]!.blobSha).toBe(blobSha);
    expect(result.bundle.files[0]!.byteLength).toBe(rawBlob.byteLength);
    expect(result.bundle.files[0]!.contentSha256).toBe(sha256Hex(rawBlob));
    expect(Buffer.from(result.bundle.files[0]!.content, 'utf8')).toEqual(rawBlob);
    bundles.push(result.bundle);
  }
  expect(new Set(bundles.flatMap((bundle) => bundle.files.map((file) => file.filePath)))).toEqual(new Set(fixtures.map(([, path]) => path)));
  const mismatches = bundles.flatMap((bundle) => bundle.files).filter((file) => {
    const committed = gitBytes('cat-file', 'blob', file.blobSha);
    return !readFileSync(resolve(repositoryRoot, file.filePath)).equals(committed);
  });
  if (gitText('config', '--get', 'core.autocrlf').trim() === 'true') {
    expect(mismatches.length, 'At least one multiline LF blob must differ from its autocrlf checkout').toBeGreaterThan(0);
    for (const file of mismatches) expect(file.contentSha256).not.toBe(sha256Hex(readFileSync(resolve(repositoryRoot, file.filePath))));
  }
  expect(trackedStatus()).toBe(before);
  expect(gitText('rev-parse', '--verify', 'HEAD^{commit}').trim()).toBe(commitSha);
  console.info(JSON.stringify({ actualCollectorHead: commitSha, classifications: fixtures.map(([value]) => value),
    collectedFiles: bundles.reduce((total, bundle) => total + bundle.files.length, 0),
    collectedBytes: bundles.reduce((total, bundle) => total + bundle.collection.collectedBytes, 0),
    isolatedPaths: fixtures.map(([, path]) => path), worktreeBlobMismatchPaths: mismatches.map((file) => file.filePath),
    providerCalls: 0, runtimeRepositoryWrites: 0, externalTempWrites: 0 }));
}, 120_000);

function planV1(classification: RepositoryClassification): WorkflowImplementationPlanArtifact {
  const pin = { assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 2,
    reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 3 };
  const plan = { domain: 'eightforge.implementation-plan', schemaVersion: 1, authority: 'non_authoritative', executable: false,
    grantsExecutionAuthority: false, source: { pin, effectiveReviewedSpecificationDigestSha256: 'd'.repeat(64) },
    plannedSteps: [{ stepId: 'step', originalClassification: classification, effectiveClassification: classification, disposition: 'modified',
      provenance: { ...pin, sourceSubmissionId: pin.assessmentId, stepReviewId: pin.reviewId,
        reviewerActorId: pin.assessmentId, reviewerNotes: null },
      specificationSource: { mode: 'reviewed_replacement', sourceField: 'workflow_assessment_step_reviews.accepted_specification' },
      implementationReadiness: classification === 'EXTRACT'
        ? { state: 'requires_operator_decision', decision: 'source_document_taxonomy' }
        : classification === 'HUMAN' ? { state: 'blocked_structural', blocker: 'no_organization_for_task' }
          : { state: 'blocked_structural', blocker: 'rule_definition_is_code' },
      specification: classification === 'EXTRACT'
        ? { describedFact: 'Document classification', sourceDocument: 'Uploaded document', deterministicExtractionPlausible: true }
        : classification === 'HUMAN' ? { description: 'Human review', whyHumanControlled: 'Authority remains human controlled' }
          : { plainLanguageRule: 'Require evidence', requiredFacts: ['evidence'], conditionType: 'presence_check',
            expectedEvidence: ['source'], expectedOutcome: 'present', userDescribedExceptions: [], unresolvedAssumptions: [] } }],
    rejectedSteps: [] };
  return { ...plan, digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1',
    value: hashCanonical(plan) } } as WorkflowImplementationPlanArtifact;
}

function evidenceKind(classification: RepositoryClassification) {
  return classification === 'EXTRACT' ? 'document_type' as const
    : classification === 'HUMAN' ? 'authority_contract' as const : 'authored_rule' as const;
}

function parseTree(output: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    expect(end).toBeGreaterThan(offset);
    const record = output.subarray(offset, end);
    const tab = record.indexOf(0x09);
    const header = record.subarray(0, tab).toString('ascii');
    const match = /^100644 blob ([a-f0-9]{40})$/.exec(header);
    if (match) entries.set(new TextDecoder('utf-8', { fatal: true }).decode(record.subarray(tab + 1)), match[1]!);
    offset = end + 1;
  }
  return entries;
}
