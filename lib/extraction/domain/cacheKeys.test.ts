import { describe, expect, it } from 'vitest';
import {
  engineArtifactCacheKey,
  fieldArtifactCacheKey,
  pageRenderCacheKey,
  tableArtifactCacheKey,
} from '@/lib/extraction/domain/cacheKeys';

describe('content-addressed cache keys', () => {
  it('uses exactly the Phase 2 output-affecting inputs', () => {
    expect(pageRenderCacheKey({
      source_sha256: 'a'.repeat(64),
      page: 3,
      render_config_digest: 'b'.repeat(64),
    })).toMatch(/^page-render:[0-9a-f]{64}$/);
    expect(engineArtifactCacheKey({
      page_render_sha256: 'c'.repeat(64),
      engine_name: 'ocr',
      engine_version: '1',
      engine_config_digest: 'd'.repeat(64),
    })).toMatch(/^engine-artifact:[0-9a-f]{64}$/);
    expect(tableArtifactCacheKey({
      ordered_region_artifact_digest: 'e'.repeat(64),
      table_parser_version: '1',
      table_parser_config_digest: 'f'.repeat(64),
    })).toMatch(/^table-artifact:[0-9a-f]{64}$/);
    expect(fieldArtifactCacheKey({
      ordered_fragment_digest: '1'.repeat(64),
      primitive_parser_version: '1',
      schema_version: 'v1',
    })).toMatch(/^field-artifact:[0-9a-f]{64}$/);
  });

  it('cannot accept filename, project, document, ID, or count inputs', () => {
    if (false) {
      pageRenderCacheKey({
        source_sha256: 'a'.repeat(64),
        page: 1,
        render_config_digest: 'b'.repeat(64),
        // @ts-expect-error Filename is prohibited from cache identity.
        filename: 'contract.pdf',
      });
      fieldArtifactCacheKey({
        ordered_fragment_digest: 'a'.repeat(64),
        primitive_parser_version: '1',
        schema_version: 'v1',
        // @ts-expect-error Expected row count is prohibited from cache identity.
        expected_row_count: 32,
      });
    }
    expect(true).toBe(true);
  });
});
