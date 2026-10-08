import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>['db'];
export type DatabasePoolErrorReporter = (error: Error) => void;

type DatabaseConnectionOptions = Pick<PoolConfig, 'max' | 'connectionTimeoutMillis' | 'statement_timeout' | 'query_timeout'>;

export function createDatabase(
  databaseUrl: string,
  reportPoolError: DatabasePoolErrorReporter = defaultPoolErrorReporter,
  options: DatabaseConnectionOptions = {},
) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
    ...options,
  });
  pool.on('error', (error) => {
    reportPoolError(error);
  });

  return {
    db: drizzle(pool, { schema }),
    pool,
  };
}

function defaultPoolErrorReporter(error: Error): void {
  console.error('Unexpected error from an idle PostgreSQL client', error);
}
