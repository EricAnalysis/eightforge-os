/**
 * Read-only probe: prints the KEY STRUCTURE (never values) of one document's
 * preferred extraction, to locate page text for bounded review excerpts.
 *   npx vite-node --config vitest.config.ts scripts/evaluation/case-investigation/probeExtractionShape.ts -- --env-file <f> --document <id>
 */
import { readFileSync } from 'node:fs';

import { createClient } from '@supabase/supabase-js';

import { readOnlyClient } from '@/lib/evaluation/caseInvestigation/readClients';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const values = new Map(readFileSync(arg('--env-file')!, 'utf8').split(/\r?\n/)
  .map((line) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)).filter(Boolean)
  .map((m) => [m![1]!, m![2]!.replace(/^['"]|['"]$/g, '')]));
const admin = readOnlyClient(createClient(values.get('NEXT_PUBLIC_SUPABASE_URL') ?? values.get('SUPABASE_URL')!,
  values.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } }));

function shape(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) return value.length ? [`array(${value.length})`, shape(value[0], depth - 1)] : 'array(0)';
  if (value && typeof value === 'object') {
    if (depth <= 0) return 'object';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth - 1)]));
  }
  return typeof value === 'string' ? `string(${value.length})` : typeof value;
}

const { data, error } = await admin.from('document_extractions').select('data, created_at')
  .eq('document_id', arg('--document')!).is('field_key', null).order('created_at', { ascending: false }).limit(1);
if (error) throw new Error(error.message);
let root: unknown = (data as Array<{ data: unknown }>)[0]?.data;
for (const key of (arg('--path') ?? '').split('.').filter(Boolean)) root = (root as Record<string, unknown> | undefined)?.[key];
console.log(JSON.stringify(shape(root, Number(arg('--depth') ?? 5)), null, 1).slice(0, 6000));
