/**
 * Read clients for the Case Investigation qualification corpus (contract v2).
 *
 * The corpus is frozen through the SAME server read path the live capability
 * uses (`readInvestigationContext`), never a re-implementation of it. That path
 * takes an injected client, so the harness supplies one of two:
 *
 * - `readOnlyClient(client)`: wraps a real Supabase client so that only
 *   `.from(table).select(...)` is reachable. Every other property (`rpc`,
 *   `storage`, `auth`, `functions`, `schema`, ...) and every write method on a
 *   table (`insert`, `update`, `upsert`, `delete`) throws before any request is
 *   built. Production stays read-only by construction, not by convention.
 * - `memoryReadClient(tables)`: serves fixture tables (deterministic conflict
 *   fixtures) with the query subset the read path uses. An unsupported method
 *   throws, so a fixture can never silently diverge from the real query.
 */

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };

export class ReadOnlyViolation extends Error {
  constructor(what: string) {
    super(`read-only qualification client: ${what} is not allowed`);
    this.name = 'ReadOnlyViolation';
  }
}

/** Only `.from(table).select(...)` is reachable; everything else throws. */
export function readOnlyClient<T extends { from: (table: string) => { select: (...args: never[]) => unknown } }>(client: T): T {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'from') {
        return (table: string) => {
          const builder = target.from(table);
          return new Proxy({}, {
            get(_unused, method) {
              if (method === 'select') return (...args: never[]) => builder.select(...args);
              throw new ReadOnlyViolation(`${String(table)}.${String(method)}`);
            },
          });
        };
      }
      // Promise resolution probes `then`; the client itself is never a thenable.
      if (property === 'then') return undefined;
      throw new ReadOnlyViolation(String(property));
    },
  });
}

function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  return String(left) < String(right) ? -1 : 1;
}

class MemoryQuery implements PromiseLike<Result> {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private orderBy: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private mode: 'many' | 'maybeSingle' | 'single' = 'many';

  constructor(private readonly rows: readonly Row[]) {}

  select(): this { return this; }
  eq(column: string, value: unknown): this { this.filters.push((row) => row[column] === value); return this; }
  neq(column: string, value: unknown): this { this.filters.push((row) => row[column] !== value); return this; }
  in(column: string, values: readonly unknown[]): this {
    const set = new Set(values);
    this.filters.push((row) => set.has(row[column]));
    return this;
  }
  is(column: string, value: null | boolean): this { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy.push({ column, ascending: options?.ascending ?? true });
    return this;
  }
  limit(count: number): this { this.limitCount = count; return this; }
  maybeSingle(): this { this.mode = 'maybeSingle'; return this; }
  single(): this { this.mode = 'single'; return this; }

  private execute(): Result {
    let rows = this.rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.orderBy.length > 0) {
      rows = [...rows].sort((left, right) => {
        for (const { column, ascending } of this.orderBy) {
          const order = compare(left[column], right[column]);
          if (order !== 0) return ascending ? order : -order;
        }
        return 0;
      });
    }
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
    const copy = rows.map((row) => structuredClone(row));
    if (this.mode === 'many') return { data: copy, error: null };
    if (copy.length > 1) return { data: null, error: { message: 'multiple rows returned' } };
    if (copy.length === 0 && this.mode === 'single') return { data: null, error: { message: 'no rows returned' } };
    return { data: copy[0] ?? null, error: null };
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

/** In-memory tables served with the read path's query subset; anything else throws. */
export function memoryReadClient(tables: Readonly<Record<string, readonly Row[]>>) {
  const query = (table: string) => {
    const instance = new MemoryQuery(tables[table] ?? []);
    const guarded: MemoryQuery = new Proxy(instance, {
      get(target, method) {
        if (method in target) {
          const value = Reflect.get(target, method, target);
          if (typeof value !== 'function') return value;
          // Chained calls keep returning the guarded query, so every later
          // method is checked too.
          return (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown).apply(target, args);
            return result === target ? guarded : result;
          };
        }
        throw new ReadOnlyViolation(`${table}.${String(method)} (unsupported by the fixture client)`);
      },
    });
    return guarded;
  };
  return readOnlyClient({ from: (table: string) => ({ select: () => query(table) }) });
}
