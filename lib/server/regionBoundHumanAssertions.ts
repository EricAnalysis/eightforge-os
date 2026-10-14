import {
  HUMAN_FACT_ASSERTIONS_TABLE,
  HUMAN_FACT_ASSERTION_SELECT,
  type HumanFactAssertionRow,
} from '@/lib/humanFactAssertions/regionBoundAssertions';

/**
 * Server-side read of region-bound human-reviewed values (B3).
 *
 * EightForge Core: manual operator review never depends on the Forgewing
 * entitlement or on Forgewing being enabled. This module only reads. The one
 * writer is `regionBoundHumanAssertionWriter`, kept separate so that every
 * reader (the resolution queue, Ask, the Validator, value reading) can import
 * reviewed truth without being able to reach the truth writer (Forgewing S4).
 */

type QueryResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
type SelectQuery = QueryResult & {
  in(column: string, values: readonly string[]): SelectQuery;
  eq(column: string, value: unknown): SelectQuery;
  order(column: string, options: { ascending: boolean }): SelectQuery;
};
export type RegionAssertionClient = {
  from(table: string): { select(columns: string): SelectQuery };
  rpc(fn: string, args: Record<string, unknown>): QueryResult;
};

export type RegionAssertionReadResult =
  | Readonly<{ status: 'ok'; rows: readonly HumanFactAssertionRow[] }>
  /** The B3 columns are not deployed yet. Nothing region-bound can exist. */
  | Readonly<{ status: 'unavailable'; rows: readonly [] }>;

/** undefined_table / undefined_column / PostgREST schema-cache misses. */
export function isRegionAssertionSchemaUnavailable(error: { code?: string; message?: string }): boolean {
  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();
  return code === '42P01' || code === '42703' || code === 'PGRST205' || code === 'PGRST204'
    || (message.includes('human_fact_assertions') && message.includes('schema cache'));
}

export async function loadRegionBoundAssertionRows(
  admin: RegionAssertionClient,
  documentIds: readonly string[],
): Promise<RegionAssertionReadResult> {
  if (documentIds.length === 0) return { status: 'ok', rows: [] };
  const { data, error } = await admin
    .from(HUMAN_FACT_ASSERTIONS_TABLE)
    .select(HUMAN_FACT_ASSERTION_SELECT)
    .in('source_document_id', [...documentIds])
    .eq('source_binding', 'region_bound')
    .order('asserted_at', { ascending: true });
  if (error) {
    if (isRegionAssertionSchemaUnavailable(error)) return { status: 'unavailable', rows: [] };
    throw new Error(`Failed to load region-bound human assertions: ${error.message ?? 'unknown error'}`);
  }
  return { status: 'ok', rows: Array.isArray(data) ? data as HumanFactAssertionRow[] : [] };
}
