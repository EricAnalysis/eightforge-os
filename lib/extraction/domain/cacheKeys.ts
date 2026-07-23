import { hashCanonical } from '@/lib/extraction/domain/hash';

export function pageRenderCacheKey(input: {
  readonly source_sha256: string;
  readonly page: number;
  readonly render_config_digest: string;
}): string {
  return `page-render:${hashCanonical(input)}`;
}
export function engineArtifactCacheKey(input: {
  readonly page_render_sha256: string;
  readonly engine_name: string;
  readonly engine_version: string;
  readonly engine_config_digest: string;
}): string {
  return `engine-artifact:${hashCanonical(input)}`;
}

export function tableArtifactCacheKey(input: {
  readonly ordered_region_artifact_digest: string;
  readonly table_parser_version: string;
  readonly table_parser_config_digest: string;
}): string {
  return `table-artifact:${hashCanonical(input)}`;
}

export function fieldArtifactCacheKey(input: {
  readonly ordered_fragment_digest: string;
  readonly primitive_parser_version: string;
  readonly schema_version: string;
}): string {
  return `field-artifact:${hashCanonical(input)}`;
}
