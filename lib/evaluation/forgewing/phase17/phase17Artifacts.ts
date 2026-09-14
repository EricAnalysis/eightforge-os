import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  PHASE17_FORBIDDEN_COMMIT_SAFE_KEYS,
  Phase17EvaluationRunSchema,
  Phase17FreezeSchema,
  type Phase17EvaluationRun,
  type Phase17Freeze,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';
import type { Phase17LocalRawRecord } from '@/lib/evaluation/forgewing/phase17/phase17Execution';

/**
 * Phase 17 artifact persistence. The only module in the harness that writes.
 *
 * Layout: <artifactRoot>/<runId>/
 *   freeze.json      commit-safe, written and byte-verified before any provider call
 *   summary.json     commit-safe normalized metrics and qualification result
 *   local/raw.json   provider inputs and raw outputs; gitignored, never committed;
 *                    written after execution (even when it throws) and BEFORE the
 *                    summary, so paid-call evidence survives a summary failure
 *
 * Every file is write-once (`wx`). Commit-safe artifacts are rejected if any
 * key that could carry source text or provider payload appears at any depth.
 */

export const PHASE17_LOCAL_DIRECTORY = 'local';

export function phase17ForbiddenKeyPaths(value: unknown, trail = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => phase17ForbiddenKeyPaths(entry, `${trail}[${index}]`));
  }
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
    ...((PHASE17_FORBIDDEN_COMMIT_SAFE_KEYS as readonly string[]).includes(key)
      ? [`${trail}.${key}`] : []),
    ...phase17ForbiddenKeyPaths(entry, `${trail}.${key}`),
  ]);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeOnce(absolutePath: string, bytes: string): string {
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes, { encoding: 'utf8', flag: 'wx' });
  if (readFileSync(absolutePath, 'utf8') !== bytes) {
    throw new Error(`PHASE17_ARTIFACT_VERIFICATION_FAILED: ${absolutePath}`);
  }
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function commitSafe<T>(schema: { parse(value: unknown): T }, value: T, name: string): string {
  const parsed = schema.parse(value);
  const forbidden = phase17ForbiddenKeyPaths(parsed);
  if (forbidden.length > 0) {
    throw new Error(`PHASE17_ARTIFACT_NOT_COMMIT_SAFE: ${name} ${forbidden.join(', ')}`);
  }
  return serialize(parsed);
}

export function phase17RunDirectory(artifactRoot: string, runId: string): string {
  return path.join(artifactRoot, runId);
}

export function writePhase17Freeze(artifactRoot: string, freeze: Phase17Freeze): Readonly<{
  path: string; sha256: string;
}> {
  const target = path.join(phase17RunDirectory(artifactRoot, freeze.runId), 'freeze.json');
  return { path: target, sha256: writeOnce(target, commitSafe(Phase17FreezeSchema, freeze, 'freeze')) };
}

export function writePhase17Summary(artifactRoot: string, summary: Phase17EvaluationRun): Readonly<{
  path: string; sha256: string;
}> {
  const target = path.join(phase17RunDirectory(artifactRoot, summary.runId), 'summary.json');
  return {
    path: target,
    sha256: writeOnce(target, commitSafe(Phase17EvaluationRunSchema, summary, 'summary')),
  };
}

export function writePhase17LocalRaw(artifactRoot: string, runId: string,
  raw: readonly Phase17LocalRawRecord[], executionStatus: 'completed' | 'aborted',
): Readonly<{ path: string; sha256: string }> {
  const target = path.join(phase17RunDirectory(artifactRoot, runId), PHASE17_LOCAL_DIRECTORY,
    'raw.json');
  return { path: target, sha256: writeOnce(target, serialize({
    warning: 'LOCAL ONLY. Contains source text and provider payloads. Never commit.',
    runId,
    // aborted: execution threw; these are the calls that completed before it did.
    executionStatus,
    records: raw,
  })) };
}

/**
 * Integrity check for committed artifacts: both parse, neither carries a
 * forbidden key, and the summary is bound to the exact freeze bytes.
 */
export function verifyPhase17CommittedRun(freezeBytes: string, summaryBytes: string): Readonly<{
  freeze: Phase17Freeze; summary: Phase17EvaluationRun;
}> {
  const freeze = Phase17FreezeSchema.parse(JSON.parse(freezeBytes));
  const summary = Phase17EvaluationRunSchema.parse(JSON.parse(summaryBytes));
  const forbidden = [
    ...phase17ForbiddenKeyPaths(freeze), ...phase17ForbiddenKeyPaths(summary),
  ];
  if (forbidden.length > 0) throw new Error(`PHASE17_ARTIFACT_NOT_COMMIT_SAFE: ${forbidden.join(', ')}`);
  const freezeSha256 = createHash('sha256').update(freezeBytes, 'utf8').digest('hex');
  if (summary.freezeSha256 !== freezeSha256 || summary.runId !== freeze.runId) {
    throw new Error('PHASE17_ARTIFACT_BINDING_FAILED: summary is not bound to this freeze');
  }
  return { freeze, summary };
}
