import { and, eq } from 'drizzle-orm';
import { AuthorizationError, ConflictError, ValidationError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import {
  fines,
  guildSettings,
  members,
  scheduledJobs,
  treasuryEntries,
  weeklyObligations,
  weeklyPaymentProofs,
} from '../../src/infrastructure/db/schema.js';
import { FineService } from '../../src/modules/fines/service.js';
import { appendTreasuryEntryWithTransaction, TreasuryService } from '../../src/modules/treasury/service.js';
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

  it('reverses an approved overdue payment once and converts the reopened obligation to a fine', async () => {
    const [proof] = await db.select().from(weeklyPaymentProofs).where(and(eq(weeklyPaymentProofs.guildId, guildId), eq(weeklyPaymentProofs.status, 'APPROVED')));
    const now = new Date('2026-09-01T00:00:00.000Z');
    await expect(service.rejectPayment(guildId, proof!.id, actor, 'รายการผิด', now)).rejects.toBeInstanceOf(AuthorizationError);
    const expense = await db.transaction((tx) => appendTreasuryEntryWithTransaction(tx, {
      guildId, entryType: 'EXPENSE', amount: -100_000, description: 'ใช้เงินไปแล้ว',
      sourceType: 'MANUAL', sourceId: 'reversal-insufficient-balance-test', createdByDiscordUserId: actor, now,
    }));
    await expect(service.rejectPayment(guildId, proof!.id, actor, 'คืนเงินแล้ว', now, true)).rejects.toBeInstanceOf(ValidationError);
    expect((await service.getProof(guildId, proof!.id)).proof.status).toBe('APPROVED');
    await new TreasuryService(db).reverseEntry(guildId, 'restore-test-funds', expense.id, 'คืนเงินทดสอบ', actor, now);
    await Promise.all([1, 2].map(() => service.rejectPayment(guildId, proof!.id, actor, 'คืนเงินแล้ว', now, true)));
    const [obligation] = await db.select().from(weeklyObligations).where(eq(weeklyObligations.id, proof!.obligationId));
    expect(obligation?.status).toBe('CONVERTED_TO_FINE');
    expect(obligation?.convertedFineId).not.toBeNull();
    const entries = await db.select().from(treasuryEntries).where(eq(treasuryEntries.guildId, guildId));
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(0);
    const [source] = entries.filter((entry) => entry.sourceType === 'WEEKLY_PAYMENT' && entry.sourceId === proof!.id);
    expect(entries.filter((entry) => entry.reversalOfEntryId === source!.id)).toHaveLength(1);
  });

  it('cancels an open collection atomically and reverses approved weekly payments once', async () => {
    const created = await service.create({
      guildId,
      requestId: 'weekly-create-cancel-open',
      title: 'รอบที่สร้างผิด',
      startsOn: '2026-09-07',
      endsOn: '2026-09-13',
      standardAmount: 100_000,
      overdueFineAmount: 50_000,
      recurringFineAmount: 25_000,
      timezone: 'Asia/Bangkok',
      actorDiscordUserId: actor,
      now: new Date('2026-09-07T00:00:00.000Z'),
    });
    const prepared = await service.preparePayment(
      guildId,
      created.collection.id,
      firstMember,
      100_000,
      new Date('2026-09-08T00:00:00.000Z'),
    );
    const proof = await persistProof(
      service,
      prepared,
      'weekly-proof-cancel-open',
      firstMember,
      new Date('2026-09-08T00:30:00.000Z'),
    );
    await service.approvePayment(guildId, proof.proof.id, actor, new Date('2026-09-08T01:00:00.000Z'));

    const cancelledAt = new Date('2026-09-08T02:00:00.000Z');
    await expect(service.cancelCollection(
      guildId,
      created.collection.id,
      actor,
      'สร้างรอบผิดสัปดาห์',
      cancelledAt,
    )).rejects.toBeInstanceOf(AuthorizationError);
    const first = await service.cancelCollection(
      guildId,
      created.collection.id,
      actor,
      'สร้างรอบผิดสัปดาห์',
      cancelledAt,
      true,
    );
    const duplicate = await service.cancelCollection(
      guildId,
      created.collection.id,
      actor,
      'สร้างรอบผิดสัปดาห์',
      cancelledAt,
      true,
    );

    expect(first.collection).toMatchObject({
      isClosed: true,
      cancelledAt,
      cancelledByDiscordUserId: actor,
      cancellationReason: 'สร้างรอบผิดสัปดาห์',
    });
    expect(duplicate.collection.cancelledAt).toEqual(cancelledAt);
    expect(first.obligations.every(({ obligation }) => obligation.status === 'EXEMPT')).toBe(true);
    expect((await service.getProof(guildId, proof.proof.id)).proof).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'สร้างรอบผิดสัปดาห์',
    });
    await expect(service.preparePayment(
      guildId,
      created.collection.id,
      secondMember,
      100_000,
      new Date('2026-09-08T03:00:00.000Z'),
    )).rejects.toBeInstanceOf(ConflictError);

    const entries = await db.select().from(treasuryEntries).where(eq(treasuryEntries.guildId, guildId));
    const [source] = entries.filter((entry) => (
      entry.sourceType === 'WEEKLY_PAYMENT' && entry.sourceId === proof.proof.id
    ));
    expect(entries.filter((entry) => entry.reversalOfEntryId === source!.id)).toHaveLength(1);
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(0);
  });

  it('cancels fines generated from a closed collection and ignores its scheduled conversion retry', async () => {
    const collection = (await service.list(guildId)).find(({ collection: value }) => (
      value.requestId === 'weekly-create-1'
    ));
    expect(collection).toBeDefined();
    const fineIds = collection!.obligations.flatMap(({ obligation }) => (
      obligation.convertedFineId === null ? [] : [obligation.convertedFineId]
    ));
    expect(fineIds.length).toBeGreaterThan(0);

    const cancelled = await service.cancelCollection(
      guildId,
      collection!.collection.id,
      actor,
      'ยกเลิกรอบย้อนหลัง',
      new Date('2026-09-08T04:00:00.000Z'),
      true,
    );
    expect(cancelled.obligations.every(({ obligation }) => obligation.status === 'EXEMPT')).toBe(true);
    for (const fineId of fineIds) {
      expect((await fineService.get(guildId, fineId)).fine.status).toBe('CANCELLED');
    }

    const retried = await service.processConversion(
      guildId,
      collection!.collection.id,
      new Date('2026-09-09T00:00:00.000Z'),
    );
    expect(retried.collection.cancelledAt).not.toBeNull();
    expect(retried.obligations.every(({ obligation }) => obligation.status === 'EXEMPT')).toBe(true);
  });
});

async function persistProof(
  service: WeeklyDuesService,
  prepared: PreparedWeeklyPayment,
  requestId: string,
  submittedByDiscordUserId: string,
  now = new Date('2026-08-29T01:00:00.000Z'),
) {
  return service.persistPayment({
    prepared,
    requestId,
    submittedByDiscordUserId,
    attachmentId: `attachment-${requestId}`,
    logChannelId: 'weekly-channel',
    logMessageId: `message-${requestId}`,
    now,
  });
}
