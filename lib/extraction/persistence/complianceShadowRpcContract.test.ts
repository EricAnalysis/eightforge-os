import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistExtractionComplianceShadow } from '@/lib/extraction/persistence/complianceShadow';

const migrationPath = path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260723163517_phase3_step0_compliance_foundation.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
const rpcSql = sql.match(
  /CREATE OR REPLACE FUNCTION public\.publish_extraction_compliance_shadow\(payload jsonb\)[\s\S]*?\n\$\$;/,
)?.[0];

if (!rpcSql) {
  throw new Error('publish_extraction_compliance_shadow SQL function not found');
}

const sqlTextKeys = new Set(
  [...rpcSql.matchAll(/payload\s*->>\s*'([^']+)'/g)].map((match) => match[1]),
);
const sqlJsonKeys = new Set(
  [...rpcSql.matchAll(/payload\s*->\s*'([^']+)'/g)].map((match) => match[1]),
);
const sqlConsumedKeys = [...new Set([...sqlTextKeys, ...sqlJsonKeys])].sort();

describe('extraction compliance shadow TypeScript-to-SQL RPC contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('publishes every SQL-consumed key with its expected serialized shape', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    vi.stubEnv('GIT_COMMIT_SHA', '');
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'build-digest-contract-test');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('UNSTRUCTURED_API_KEY', '');
    vi.stubEnv('EIGHTFORGE_INSTRUCTOR_ENABLED', '0');

    const rpc = vi.fn(async (
      name: string,
      args: { payload: Record<string, unknown> },
    ) => {
      void name;
      void args;
      return {
        data: {
          source_artifact_id: '30000000-0000-0000-0000-000000000001',
          extraction_run_id: '30000000-0000-0000-0000-000000000002',
          extraction_snapshot_id: '30000000-0000-0000-0000-000000000003',
          interpretation_snapshot_id: '30000000-0000-0000-0000-000000000004',
        },
        error: null,
      };
    });
    const sourceBytes = new TextEncoder().encode('contract payload bytes').buffer;

    await persistExtractionComplianceShadow({
      admin: { rpc } as never,
      organizationId: '10000000-0000-0000-0000-000000000001',
      sourceDocumentId: '20000000-0000-0000-0000-000000000001',
      sourceBytes,
      storageObjectVersion: 'object-1:version-1',
      mediaType: 'text/plain; charset=utf-8',
      legacyExtractionPayload: {},
      analysisJobId: 'job-contract-1',
      analysisMode: 'deterministic',
    });

    expect(rpc).toHaveBeenCalledOnce();
    const [rpcName, rpcArguments] = rpc.mock.calls[0];
    const payload = rpcArguments.payload;

    expect(rpcName).toBe('publish_extraction_compliance_shadow');
    expect(Object.keys(payload).sort()).toEqual(sqlConsumedKeys);
    expect([...sqlJsonKeys]).toEqual(['parser_manifest']);
    expect(payload.parser_manifest).toEqual(expect.any(Object));
    expect(Array.isArray(payload.parser_manifest)).toBe(false);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);

    for (const key of sqlTextKeys) {
      if (key === 'byte_length') {
        expect(payload[key]).toBe(sourceBytes.byteLength);
      } else {
        expect(typeof payload[key], key).toBe('string');
        expect((payload[key] as string).length, key).toBeGreaterThan(0);
      }
    }

    expect(payload.organization_id).toBe('10000000-0000-0000-0000-000000000001');
    expect(payload.source_document_id).toBe('20000000-0000-0000-0000-000000000001');
    expect(payload.idempotency_key).toBe('analysis-job:job-contract-1');
    expect(payload.media_type_sniffed).toBe('text/plain');
    expect(payload.started_at).toBe(payload.completed_at);
    expect(Number.isNaN(Date.parse(payload.started_at as string))).toBe(false);

    for (const key of [
      'source_sha256',
      'parser_manifest_hash',
      'gap_dependency_hash',
      'artifact_root_hash',
      'content_extraction_fingerprint',
      'interpreter_manifest_hash',
      'effective_truth_set_hash',
      'interpretation_output_root_hash',
    ]) {
      expect(payload[key], key).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
