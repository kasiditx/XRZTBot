import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>['db'];
export type DatabasePoolErrorReporter = (error: Error) => void;

export function createDatabase(databaseUrl: string, reportPoolError: DatabasePoolErrorReporter = defaultPoolErrorReporter) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
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
