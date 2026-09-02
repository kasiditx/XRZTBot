import { eq } from 'drizzle-orm';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { guildSettings, scheduledJobs, treasuryEntries } from '../../src/infrastructure/db/schema.js';
import { TreasuryService, type PreparedTreasuryEntry } from '../../src/modules/treasury/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('TreasuryService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: TreasuryService;
  const guildId = 'treasury-integration-guild';
  const actor = '400000000000000001';

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new TreasuryService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('sets one idempotent opening balance without evidence', async () => {
    const opening = await service.createOpeningBalance(guildId, 'opening-1', 100_000, actor, new Date('2026-08-27T10:00:00.000Z'));
    const duplicate = await service.createOpeningBalance(guildId, 'opening-1', 100_000, actor, new Date('2026-08-27T10:00:01.000Z'));
    expect(opening.id).toBe(duplicate.id);
    expect(opening.balanceAfter).toBe(100_000);
    await expect(service.createOpeningBalance(guildId, 'opening-2', 50_000, actor, new Date())).rejects.toBeInstanceOf(ConflictError);
  });

  it('persists income and expense with immutable balance-after snapshots', async () => {
    const income = await persistManual(service, guildId, 'income-1', 'INCOME', 50_000, 'ขายของแก๊ง', actor);
    expect(income.amount).toBe(50_000);
    expect(income.balanceAfter).toBe(150_000);
    expect(income.attachmentId).toBe('attachment-income-1');

    const expense = await persistManual(service, guildId, 'expense-1', 'EXPENSE', 40_000, 'ซื้อของเข้าสต็อก', actor);
    expect(expense.amount).toBe(-40_000);
    expect(expense.balanceAfter).toBe(110_000);
    expect((await service.getDashboard(guildId)).balance).toBe(110_000);
  });

  it('rejects an expense that would make the fund negative', async () => {
    await expect(service.prepareManualEntry(guildId, 'expense-too-large', 'EXPENSE', 110_001, 'ยอดเกินเงินคงเหลือ', actor))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('creates exactly one audited reversal and restores the balance', async () => {
    const expense = (await service.getDashboard(guildId, 10)).recentEntries.find((entry) => entry.sourceId === 'expense-1');
    expect(expense).toBeDefined();
    const reversal = await service.reverseEntry(guildId, 'reverse-1', expense!.id, 'ลงรายจ่ายผิด', actor, new Date('2026-08-27T11:00:00.000Z'));
    const duplicate = await service.reverseEntry(guildId, 'reverse-duplicate', expense!.id, 'ลองย้อนซ้ำ', actor, new Date('2026-08-27T11:01:00.000Z'));
    expect(duplicate.id).toBe(reversal.id);
    expect(reversal.amount).toBe(40_000);
    expect(reversal.balanceAfter).toBe(150_000);
  });

  it('serializes concurrent expenses so only one can consume the same balance', async () => {
    const concurrentGuild = 'treasury-concurrent-guild';
    await db.delete(guildSettings).where(eq(guildSettings.guildId, concurrentGuild));
    await db.insert(guildSettings).values({ guildId: concurrentGuild });
    await service.createOpeningBalance(concurrentGuild, 'opening-concurrent', 100_000, actor, new Date('2026-08-27T10:00:00.000Z'));
    const first = await service.prepareManualEntry(concurrentGuild, 'expense-concurrent-1', 'EXPENSE', 80_000, 'รายจ่ายหนึ่ง', actor);
    const second = await service.prepareManualEntry(concurrentGuild, 'expense-concurrent-2', 'EXPENSE', 80_000, 'รายจ่ายสอง', actor);
    const results = await Promise.allSettled([
      persistPrepared(service, first),
      persistPrepared(service, second),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await service.getDashboard(concurrentGuild)).balance).toBe(20_000);
  });

  it('queues public entry and dashboard refresh jobs', async () => {
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(jobs.some((job) => job.jobType === 'TREASURY_PUBLISH')).toBe(true);
    expect(jobs.some((job) => job.jobType === 'TREASURY_REFRESH')).toBe(true);
    const entries = await db.select().from(treasuryEntries).where(eq(treasuryEntries.guildId, guildId));
    expect(entries.every((entry) => entry.balanceAfter >= 0)).toBe(true);
  });
});

async function persistManual(
  service: TreasuryService,
  guildId: string,
  requestId: string,
  entryType: 'INCOME' | 'EXPENSE',
  amount: number,
  description: string,
  actor: string,
) {
  const prepared = await service.prepareManualEntry(guildId, requestId, entryType, amount, description, actor);
  return persistPrepared(service, prepared);
}

async function persistPrepared(service: TreasuryService, prepared: PreparedTreasuryEntry) {
  return service.persistManualEntry({
    prepared,
    attachmentId: `attachment-${prepared.requestId}`,
    publicChannelId: 'treasury-channel',
    publicMessageId: `message-${prepared.requestId}`,
    now: new Date('2026-08-27T10:30:00.000Z'),
  });
}
