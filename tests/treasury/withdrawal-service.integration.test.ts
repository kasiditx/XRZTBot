import { and, eq } from 'drizzle-orm';
import { AuthorizationError, ValidationError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import {
  guildSettings,
  members,
  treasuryEntries,
  treasuryWithdrawalRequests,
} from '../../src/infrastructure/db/schema.js';
import { TreasuryWithdrawalService } from '../../src/modules/treasury-withdrawals/service.js';
import { TreasuryService } from '../../src/modules/treasury/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('TreasuryWithdrawalService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let withdrawals: TreasuryWithdrawalService;
  let treasury: TreasuryService;
  const guildId = 'treasury-withdrawal-integration-guild';
  const requesterDiscordUserId = '410000000000000001';
  const adminDiscordUserId = '410000000000000002';

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    withdrawals = new TreasuryWithdrawalService(db);
    treasury = new TreasuryService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId });
    await db.insert(members).values({
      guildId,
      discordUserId: requesterDiscordUserId,
      inGameName: 'Requester',
      status: 'ACTIVE',
    });
    await treasury.createOpeningBalance(
      guildId,
      'opening',
      100_000,
      adminDiscordUserId,
      new Date('2026-08-28T01:00:00.000Z'),
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('approves once and atomically records an expense without evidence', async () => {
    const request = await withdrawals.create({
      guildId,
      clientRequestId: 'withdrawal-1',
      requesterDiscordUserId,
      amount: 40_000,
      reason: 'ซื้อของใช้ในแก๊ง',
      now: new Date('2026-08-28T02:00:00.000Z'),
    });

    const approved = await withdrawals.approve(
      guildId,
      request.request.id,
      adminDiscordUserId,
      new Date('2026-08-28T02:05:00.000Z'),
    );
    const duplicate = await withdrawals.approve(
      guildId,
      request.request.id,
      adminDiscordUserId,
      new Date('2026-08-28T02:06:00.000Z'),
    );
    const entries = await db.select().from(treasuryEntries).where(and(
      eq(treasuryEntries.guildId, guildId),
      eq(treasuryEntries.sourceType, 'TREASURY_WITHDRAWAL_REQUEST'),
      eq(treasuryEntries.sourceId, request.request.id),
    ));

    expect(approved.request.status).toBe('APPROVED');
    expect(duplicate.request.treasuryEntryId).toBe(approved.request.treasuryEntryId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ amount: -40_000, attachmentId: null, balanceAfter: 60_000 });
  });

  it('keeps a request pending when approval would make the treasury negative', async () => {
    const request = await withdrawals.create({
      guildId,
      clientRequestId: 'withdrawal-too-large',
      requesterDiscordUserId,
      amount: 60_001,
      reason: 'ยอดเกินเงินคงเหลือ',
      now: new Date('2026-08-28T03:00:00.000Z'),
    });

    await expect(withdrawals.approve(
      guildId,
      request.request.id,
      adminDiscordUserId,
      new Date('2026-08-28T03:05:00.000Z'),
    )).rejects.toBeInstanceOf(ValidationError);

    const [stored] = await db.select().from(treasuryWithdrawalRequests).where(eq(
      treasuryWithdrawalRequests.id,
      request.request.id,
    ));
    expect(stored?.status).toBe('PENDING');
    expect((await treasury.getDashboard(guildId)).balance).toBe(60_000);
  });

  it('allows only the requester to cancel a pending request', async () => {
    const request = await withdrawals.create({
      guildId,
      clientRequestId: 'withdrawal-cancel',
      requesterDiscordUserId,
      amount: 1_000,
      reason: 'ยกเลิกภายหลัง',
      now: new Date('2026-08-28T04:00:00.000Z'),
    });

    await expect(withdrawals.cancel(
      guildId,
      request.request.id,
      adminDiscordUserId,
      new Date('2026-08-28T04:01:00.000Z'),
    )).rejects.toBeInstanceOf(AuthorizationError);
    const cancelled = await withdrawals.cancel(
      guildId,
      request.request.id,
      requesterDiscordUserId,
      new Date('2026-08-28T04:02:00.000Z'),
    );
    expect(cancelled.request.status).toBe('CANCELLED');
  });
});
