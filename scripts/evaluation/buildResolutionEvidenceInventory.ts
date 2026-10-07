/**
 * Resolution evidence inventory -- explicit, manual, offline (B4.6.1 input).
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/buildResolutionEvidenceInventory.ts -- \
 *     --out <inventory.json> [--document <label>=<pdf>[@<sha256>]]... [--extraction <label>=<payload.json>]...
 *
 * - --document runs the production extraction entry point, extractDocument(),
 *   on a source PDF exactly as the reconstruction diff does; an @sha256 suffix
 *   pins the source bytes and the run refuses on mismatch.
 * - --extraction reads a stored extraction payload: either the extraction
 *   data object itself, or { id, created_at, data }.
 *
 * Every entry is a ResolutionCase the queue would open for that extraction,
 * classified by type and keyed by stable evidence identity; see
 * lib/evaluation/resolutionEvidenceInventory.ts. Unreviewed by construction.
 *
 * No database, no provider, no network: refuses to start with database or
 * extraction-AI credentials in the environment. The inventory holds source row
 * text, so it must be written outside the repository; stdout carries counts only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import {
  buildResolutionEvidenceInventory,
  INVENTORY_CLASSES,
  type InventoryDocumentInput,
} from '@/lib/evaluation/resolutionEvidenceInventory';
import { extractDocument } from '@/lib/server/documentExtraction';

const FORBIDDEN_ENV = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL',
  'DATABASE_URL', 'OPENAI_API_KEY', 'UNSTRUCTURED_API_KEY', 'ANTHROPIC_API_KEY'];

function args(name: string): string[] {
  return process.argv.flatMap((value, index) => (value === name ? [process.argv[index + 1] ?? ''] : []));
}

function labelled(spec: string, flag: string): { label: string; value: string } {
  const at = spec.indexOf('=');
  if (at <= 0 || at === spec.length - 1) throw new Error(`${flag} expects <label>=<path>, got "${spec}"`);
  return { label: spec.slice(0, at), value: spec.slice(at + 1) };
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function fromDocument(spec: string): Promise<InventoryDocumentInput> {
  const { label, value } = labelled(spec, '--document');
  const [file, pinned] = value.split('@') as [string, string | undefined];
  const bytes = readFileSync(file);
  const sha = sha256Hex(new Uint8Array(bytes));
  if (pinned && pinned.toLowerCase() !== sha) throw new Error(`${label}: source sha256 ${sha} does not match pin ${pinned}`);
  const sourceDocumentId = `local-inventory-document-${sha.slice(0, 24)}`;
  // A deterministic UUID-shaped artifact id derived from the source bytes, as the reconstruction diff does.
  const sourceArtifactId = `${sha.slice(0, 8)}-${sha.slice(8, 12)}-4${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`;
  const payload = await extractDocument({
    id: sourceDocumentId, title: path.basename(file), name: path.basename(file), document_type: 'contract', storage_path: file,
  }, toArrayBuffer(bytes), 'application/pdf', path.basename(file), { sourceDocumentId, sourceArtifactId });
  return { documentId: sourceDocumentId, label,
    extraction: { id: `local:${sha}`, created_at: null, data: payload as unknown as Record<string, unknown> } };
}

function fromExtraction(spec: string): InventoryDocumentInput {
  const { label, value } = labelled(spec, '--extraction');
  const parsed = JSON.parse(readFileSync(value, 'utf8')) as Record<string, unknown>;
  const wrapped = parsed && typeof parsed.data === 'object' && parsed.data !== null && !('extraction' in parsed);
  const data = (wrapped ? parsed.data : parsed) as Record<string, unknown>;
  const sha = sha256Hex(new TextEncoder().encode(JSON.stringify(data)));
  const documentId = typeof parsed.document_id === 'string' ? parsed.document_id : `local-inventory-extraction-${sha.slice(0, 24)}`;
  return { documentId, label, extraction: {
    id: wrapped && typeof parsed.id === 'string' ? parsed.id : `local:${sha}`,
    created_at: wrapped && typeof parsed.created_at === 'string' ? parsed.created_at : null,
    data,
  } };
}

async function main(): Promise<void> {
  const forbidden = FORBIDDEN_ENV.filter((name) => process.env[name]?.trim());
  if (forbidden.length > 0) throw new Error(`Refusing to run with ${forbidden.join(', ')} set: this inventory is offline only`);
  const out = args('--out')[0];
  if (!out) throw new Error('--out <inventory.json> is required');
  const relative = path.relative(process.cwd(), path.resolve(out));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error('--out must be outside the repository: the inventory holds source row text');
  }
  const documents: InventoryDocumentInput[] = [];
  for (const spec of args('--document')) documents.push(await fromDocument(spec));
  for (const spec of args('--extraction')) documents.push(fromExtraction(spec));
  if (documents.length === 0) throw new Error('at least one --document or --extraction is required');

  const inventory = buildResolutionEvidenceInventory(documents);
  writeFileSync(out, `${JSON.stringify(inventory, null, 2)}\n`);
  const lines = [`${inventory.schema}: ${documents.length} document(s), ${inventory.distinctIdentities} distinct evidence identities`];
  for (const [label, counts] of Object.entries(inventory.countsByDocumentAndClass)) {
    lines.push(`  ${label}: ${INVENTORY_CLASSES.filter((name) => counts[name]).map((name) => `${name} ${counts[name]}`).join('; ') || 'none'}`);
  }
  lines.push(`  attached category requirements: ${inventory.attachedCategoryRequirements}`);
  lines.push(`  overlaps: ${inventory.overlaps.length}; unclassified kinds: ${JSON.stringify(inventory.unclassifiedKinds)}`);
  lines.push(`-> ${out}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
