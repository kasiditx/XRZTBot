import { jest } from '@jest/globals';
import type pino from 'pino';
import type { Database } from '../../src/infrastructure/db/client.js';
import { DurableScheduler } from '../../src/modules/scheduler/service.js';

interface EmptyDatabaseFixture {
  readonly db: Database;
  readonly claimCallCount: () => number;
  readonly nextJobCallCount: () => number;
}

function createEmptyDatabase(nextRunAt: Date | null = null): EmptyDatabaseFixture {
  const dueQuery: Record<string, jest.Mock> = {};
  dueQuery.from = jest.fn(() => dueQuery);
  dueQuery.where = jest.fn(() => dueQuery);
  dueQuery.orderBy = jest.fn(() => dueQuery);
  dueQuery.limit = jest.fn(() => dueQuery);
  dueQuery.for = jest.fn(() => Promise.resolve([]));

  const nextJobQuery: Record<string, jest.Mock> = {};
  nextJobQuery.from = jest.fn(() => nextJobQuery);
  nextJobQuery.where = jest.fn(() => nextJobQuery);
  nextJobQuery.orderBy = jest.fn(() => nextJobQuery);
  const nextJobLimit = jest.fn(() => Promise.resolve(nextRunAt === null ? [] : [{ runAt: nextRunAt }]));
  nextJobQuery.limit = nextJobLimit;

  const updateQuery: Record<string, jest.Mock> = {};
  updateQuery.set = jest.fn(() => updateQuery);
  updateQuery.where = jest.fn(() => updateQuery);
  updateQuery.returning = jest.fn(() => Promise.resolve([]));

  const tx = {
    select: jest.fn(() => dueQuery),
  };
  const transaction = jest.fn(async (callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx));
  const db = {
    transaction,
    select: jest.fn(() => nextJobQuery),
    update: jest.fn(() => updateQuery),
  } as unknown as Database;

  return {
    db,
    claimCallCount: () => transaction.mock.calls.length,
    nextJobCallCount: () => nextJobLimit.mock.calls.length,
  };
}

function createLogger(): pino.Logger {
  return {
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as pino.Logger;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('DurableScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-19T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the idle interval instead of polling continuously when no jobs exist', async () => {
    const fixture = createEmptyDatabase();
    const scheduler = new DurableScheduler(fixture.db, new Map(), 'guild-1', 5_000, 3_600_000, createLogger());

    await scheduler.start();
    await flushPromises();

    expect(fixture.claimCallCount()).toBe(1);
    expect(fixture.nextJobCallCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(3_599_999);
    expect(fixture.claimCallCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(fixture.claimCallCount()).toBe(2);

    await scheduler.stop();
  });

  it('wakes immediately when an interaction may have queued a new job', async () => {
    const fixture = createEmptyDatabase();
    const scheduler = new DurableScheduler(fixture.db, new Map(), 'guild-1', 5_000, 3_600_000, createLogger());

    await scheduler.start();
    await flushPromises();
    scheduler.wake();
    await jest.advanceTimersByTimeAsync(0);

    expect(fixture.claimCallCount()).toBe(2);

    await scheduler.stop();
  });

  it('sleeps until the next pending job when one is scheduled sooner than the idle check', async () => {
    const nextRunAt = new Date('2026-09-19T12:10:00.000Z');
    const fixture = createEmptyDatabase(nextRunAt);
    const scheduler = new DurableScheduler(fixture.db, new Map(), 'guild-1', 5_000, 3_600_000, createLogger());

    await scheduler.start();
    await flushPromises();

    await jest.advanceTimersByTimeAsync(599_999);
    expect(fixture.claimCallCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(fixture.claimCallCount()).toBe(2);

    await scheduler.stop();
  });
});
