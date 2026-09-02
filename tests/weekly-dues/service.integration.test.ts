import { and, eq } from 'drizzle-orm';
import { ConflictError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import {
  fines,
  guildSettings,
  members,
  scheduledJobs,
  treasuryEntries,
  weeklyObligations,
} from '../../src/infrastructure/db/schema.js';
import { FineService } from '../../src/modules/fines/service.js';
import { WeeklyDuesService, type PreparedWeeklyPayment } from '../../src/modules/weekly-dues/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('WeeklyDuesService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: WeeklyDuesService;
  let fineService: FineService;
  const guildId = 'weekly-dues-integration-guild';
  const actor = '500000000000000001';
  const firstMember = '500000000000000002';
  const secondMember = '500000000000000003';
  const adminMember = '500000000000000004';

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new WeeklyDuesService(db);
    fineService = new FineService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId, timezone: 'Asia/Bangkok' });
    await db.insert(members).values([
      { guildId, discordUserId: firstMember, inGameName: 'Alpha', status: 'ACTIVE' },
      { guildId, discordUserId: secondMember, inGameName: 'Bravo', status: 'ACTIVE' },
      { guildId, discordUserId: adminMember, inGameName: 'Admin Active', status: 'ACTIVE' },
      { guildId, discordUserId: '500000000000000005', inGameName: 'Former', status: 'FORMER' },
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('snapshots every active member, supports override, and is idempotent', async () => {
    const input = {
      guildId,
      requestId: 'weekly-create-1',
      title: 'ส่งเงินสัปดาห์ 24–30 ส.ค.',
      startsOn: '2026-08-24',
      endsOn: '2026-08-30',
      standardAmount: 100_000,
      overdueFineAmount: 50_000,
      recurringFineAmount: 25_000,
      timezone: 'Asia/Bangkok',
      actorDiscordUserId: actor,
      now: new Date('2026-08-24T00:00:00.000Z'),
    } as const;
    const created = await service.create(input);
    const duplicate = await service.create(input);
    expect(duplicate.collection.id).toBe(created.collection.id);
    expect(created.obligations.map(({ member }) => member.discordUserId).sort()).toEqual([adminMember, firstMember, secondMember].sort());
    expect(created.collection.conversionAt.toISOString()).toBe('2026-08-30T17:00:00.000Z');
    await expect(service.preparePayment(
      guildId,
      created.collection.id,
      firstMember,
      100_000,
      new Date('2026-08-23T16:59:59.000Z'),
    )).rejects.toBeInstanceOf(ConflictError);

    const updated = await service.overrideAmount(guildId, created.collection.id, secondMember, 120_000, actor, new Date('2026-08-25T00:00:00.000Z'));
    expect(updated.obligations.find(({ member }) => member.discordUserId === secondMember)?.obligation.amount).toBe(120_000);
  });

  it('approves one full payment and atomically adds it to treasury', async () => {
    const collection = (await service.list(guildId))[0];
    expect(collection).toBeDefined();
    const prepared = await service.preparePayment(guildId, collection!.collection.id, firstMember, 100_000, new Date('2026-08-26T00:00:00.000Z'));
    const proof = await persistProof(service, prepared, 'weekly-proof-1', firstMember);
    const approved = await service.approvePayment(guildId, proof.proof.id, actor, new Date('2026-08-26T01:00:00.000Z'));
    expect(approved.proof.status).toBe('APPROVED');
    expect(approved.obligation.status).toBe('PAID');

    const [entry] = await db.select().from(treasuryEntries).where(and(
      eq(treasuryEntries.sourceType, 'WEEKLY_PAYMENT'),
      eq(treasuryEntries.sourceId, proof.proof.id),
    ));
    expect(entry?.amount).toBe(100_000);
  });

  it('skips pending evidence at close, converts unpaid balances, and starts recurring fine after 24 hours', async () => {
    const collection = (await service.list(guildId))[0];
    expect(collection).toBeDefined();
    const pending = await service.preparePayment(guildId, collection!.collection.id, adminMember, 100_000, new Date('2026-08-29T00:00:00.000Z'));
    const pendingProof = await persistProof(service, pending, 'weekly-proof-pending', adminMember);

    const converted = await service.processConversion(guildId, collection!.collection.id, new Date('2026-08-30T17:00:00.000Z'));
    expect(converted.collection.isClosed).toBe(true);
    expect(converted.obligations.find(({ member }) => member.discordUserId === adminMember)?.obligation.status).toBe('PENDING_VERIFICATION');
    expect(converted.obligations.find(({ member }) => member.discordUserId === secondMember)?.obligation.status).toBe('CONVERTED_TO_FINE');

    const secondObligation = converted.obligations.find(({ member }) => member.discordUserId === secondMember)?.obligation;
    const [fine] = await db.select().from(fines).where(eq(fines.id, secondObligation!.convertedFineId!));
    expect(fine?.principalAmount).toBe(170_000);
    expect(fine?.accruedSurchargeAmount).toBe(0);
    expect(fine?.nextSurchargeAt.toISOString()).toBe('2026-08-31T17:00:00.000Z');

    await fineService.processSurcharge(guildId, fine!.id, new Date('2026-08-31T16:59:59.000Z'));
    expect((await fineService.get(guildId, fine!.id)).fine.accruedSurchargeAmount).toBe(0);
    await fineService.processSurcharge(guildId, fine!.id, new Date('2026-08-31T17:00:00.000Z'));
    expect((await fineService.get(guildId, fine!.id)).fine.accruedSurchargeAmount).toBe(25_000);

    const rejected = await service.rejectPayment(guildId, pendingProof.proof.id, actor, 'ยอดในรูปไม่ตรง', new Date('2026-08-30T18:00:00.000Z'));
    expect(rejected.proof.status).toBe('REJECTED');
    const [adminObligation] = await db.select().from(weeklyObligations).where(eq(weeklyObligations.id, rejected.obligation.id));
    expect(adminObligation?.status).toBe('CONVERTED_TO_FINE');
    expect(adminObligation?.convertedFineId).not.toBeNull();
  });

  it('queues publish, conversion, refresh, fine, and treasury jobs', async () => {
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(new Set(jobs.map((job) => job.jobType))).toEqual(expect.objectContaining(new Set([
      'WEEKLY_PUBLISH',
      'WEEKLY_CONVERT',
      'WEEKLY_REFRESH',
      'FINE_PUBLISH',
      'FINE_SURCHARGE',
      'TREASURY_PUBLISH',
      'TREASURY_REFRESH',
    ])));
  });
});

async function persistProof(
  service: WeeklyDuesService,
  prepared: PreparedWeeklyPayment,
  requestId: string,
  submittedByDiscordUserId: string,
) {
  return service.persistPayment({
    prepared,
    requestId,
    submittedByDiscordUserId,
    attachmentId: `attachment-${requestId}`,
    logChannelId: 'weekly-channel',
    logMessageId: `message-${requestId}`,
    now: new Date('2026-08-29T01:00:00.000Z'),
  });
}
