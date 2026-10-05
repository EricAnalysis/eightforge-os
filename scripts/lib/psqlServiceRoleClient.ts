import { execFileSync } from 'node:child_process';

/**
 * The minimal Supabase surface the server adapters use, backed by psql against
 * a freshly replayed database. Reads and record-function calls run as
 * service_role; record functions are called with named arguments so parameter
 * order can never drift from the migration. For replay harnesses only.
 */

export function sqlLiteral(value: unknown): string {
  if (value == null) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlValue(name: string, value: unknown): string {
  if (value == null) return 'NULL';
  if (Array.isArray(value)) {
    return name === 'p_candidate_ids'
      ? `${sqlLiteral(JSON.stringify(value))}::jsonb`
      : `ARRAY[${value.map((entry) => sqlLiteral(entry)).join(',')}]::text[]`;
  }
  if (typeof value === 'object' || name === 'p_asserted_value') return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return sqlLiteral(value);
}

type Result = { data: unknown; error: { code?: string; message?: string } | null };

export function psqlServiceRoleClient(databaseUrl: string) {
  const runSql = (statement: string): unknown => {
    const output = execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-At',
      '--dbname', databaseUrl], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const text = output.trim();
    return text.length === 0 ? null : JSON.parse(text);
  };

  const client = {
    /** Runs SQL as the connecting (owner) role, for fixtures and checks. */
    runSql,
    rpc(fn: string, args: Record<string, unknown>): Promise<Result> {
      const named = Object.entries(args).map(([name, value]) => `${name} => ${sqlValue(name, value)}`);
      try {
        const data = runSql(`SET ROLE service_role; SET request.jwt.claim.role='service_role';
          SELECT coalesce(json_agg(r), '[]'::json) FROM public.${fn}(${named.join(', ')}) r;`);
        return Promise.resolve({ data, error: null });
      } catch (error) {
        const text = String((error as { stderr?: unknown }).stderr ?? error);
        const code = /ERROR:\s+([0-9A-Z]{5}):/.exec(text)?.[1] ?? 'P0001';
        return Promise.resolve({ data: null, error: { code, message: text } });
      }
    },
    from(table: string) {
      return {
        select(columns: string) {
          const filters: string[] = [];
          let order = '';
          const run = (limit = ''): Result => ({
            data: runSql(`SET ROLE service_role;
              SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT ${columns} FROM public.${table}
              WHERE ${filters.join(' AND ') || 'true'}${order}${limit}) t;`),
            error: null,
          });
          const query = {
            in(column: string, values: readonly string[]) {
              filters.push(`${column}::text IN (${values.map(sqlLiteral).join(',')})`);
              return query;
            },
            eq(column: string, value: unknown) {
              filters.push(`${column} = ${sqlLiteral(value)}`);
              return query;
            },
            is(column: string, value: null) {
              if (value !== null) throw new Error('only IS NULL is supported');
              filters.push(`${column} IS NULL`);
              return query;
            },
            order(column: string, options: { ascending: boolean }) {
              order = ` ORDER BY ${column} ${options.ascending ? 'ASC' : 'DESC'}, id`;
              return query;
            },
            maybeSingle(): Promise<Result> {
              const result = run(' LIMIT 1');
              return Promise.resolve({ data: Array.isArray(result.data) ? result.data[0] ?? null : null, error: null });
            },
            then(resolve: (value: Result) => unknown) {
              return Promise.resolve(run()).then(resolve);
            },
          };
          return query;
        },
      };
    },
  };
  return client;
}
