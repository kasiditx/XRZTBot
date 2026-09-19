import { jest } from '@jest/globals';
import { createDatabase } from '../../src/infrastructure/db/client.js';

describe('database pool', () => {
  it('reports an idle client error without crashing the process', async () => {
    const reportError = jest.fn();
    const { pool } = createDatabase('postgresql://user:password@localhost:5432/mirubot', reportError);
    const error = new Error('idle PostgreSQL connection terminated unexpectedly');

    expect(() => pool.emit('error', error, {})).not.toThrow();
    expect(reportError).toHaveBeenCalledWith(error);

    await pool.end();
  });
});
