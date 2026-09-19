import { and, eq } from 'drizzle-orm';
import { AuthorizationError, ConflictError, ValidationError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import {
  fines,
  guildSettings,
  members,
  scheduledJobs,
  treasuryEntries,
  weeklyCollections,
  weeklyObligations,
  weeklyPaymentProofs,
} from '../../src/infrastructure/db/schema.js';
import { appendTreasuryEntryWithTransaction, TreasuryService } from '../../src/modules/treasury/service.js';
import {
  WeeklyDuesService,
  weeklyAmountDue,
  type PreparedWeeklyPayment,
} from '../../src/modules/weekly-dues/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('WeeklyDuesService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: WeeklyDuesService;
  const guildId = 'weekly-dues-integration-guild';
  const actor = '500000000000000001';
  const firstMember = '500000000000000002';
  const secondMember = '500000000000000003';
  const adminMember = '500000000000000004';
  const reserveMember = '500000000000000006';

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new WeeklyDuesService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId, timezone: 'Asia/Bangkok' });
    await db.insert(members).values([
      { guildId, discordUserId: firstMember, inGameName: 'Alpha', status: 'ACTIVE' },
      { guildId, discordUserId: secondMember, inGameName: 'Bravo', status: 'ACTIVE' },
      { guildId, discordUserId: adminMember, inGameName: 'Admin Active', status: 'ACTIVE' },
      { guildId, discordUserId: '500000000000000005', inGameName: 'Former', status: 'FORMER' },
      { guildId, discordUserId: reserveMember, inGameName: 'Reserve', status: 'ACTIVE', rosterTitle: 'RESERVE' },
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
    expect(created.obligations.map(({ member }) => member.discordUserId).sort()).toEqual([adminMember, firstMember, secondMember, reserveMember].sort());
    expect(created.obligations.find(({ member }) => member.discordUserId === reserveMember)?.obligation).toMatchObject({
      amount: 0,
      status: 'EXEMPT',
      rejectionReason: 'ยกเว้นเนื่องจากเป็นตำแหน่งสำรอง',
      convertedFineId: null,
    });
    expect(created.obligations.filter(({ member }) => member.discordUserId !== reserveMember)
      .every(({ obligation }) => obligation.status === 'UNPAID' && obligation.amount === 100_000)).toBe(true);
    await expect(service.preparePayment(guildId, created.collection.id, reserveMember, 100_000, input.now))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(service.overrideAmount(guildId, created.collection.id, reserveMember, 100_000, actor, input.now))
      .rejects.toBeInstanceOf(ConflictError);
    const requiredReserve = await service.setMemberRule(
      guildId, created.collection.id, reserveMember, 'REQUIRED', 90_000, null, actor, input.now,
    );
    expect(requiredReserve.obligations.find(({ member }) => member.discordUserId === reserveMember)?.obligation).toMatchObject({
      amount: 90_000,
      status: 'UNPAID',
      rejectionReason: null,
    });
    const exemptedReserve = await service.setMemberRule(
      guildId, created.collection.id, reserveMember, 'EXEMPT', 0, 'ยกเว้นรอบนี้', actor, input.now,
    );
    expect(exemptedReserve.obligations.find(({ member }) => member.discordUserId === reserveMember)?.obligation).toMatchObject({
      amount: 0,
      status: 'EXEMPT',
      rejectionReason: 'ยกเว้นรอบนี้',
    });
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
    await expect(service.setMemberRule(
      guildId, collection!.collection.id, firstMember, 'EXEMPT', 0, null, actor, new Date('2026-08-26T01:01:00.000Z'),
    )).rejects.toBeInstanceOf(ConflictError);

    const [entry] = await db.select().from(treasuryEntries).where(and(
      eq(treasuryEntries.sourceType, 'WEEKLY_PAYMENT'),
      eq(treasuryEntries.sourceId, proof.proof.id),
    ));
    expect(entry?.amount).toBe(100_000);
    const proofRefreshJobs = await db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.guildId, guildId),
      eq(scheduledJobs.jobType, 'WEEKLY_PROOF_REFRESH'),
    ));
    expect(proofRefreshJobs.some((job) => (job.payload as { proofId?: string }).proofId === proof.proof.id)).toBe(true);
  });

  it('keeps the round open, skips pending evidence, and adds recurring fines to weekly balances', async () => {
    const collection = (await service.list(guildId))[0];
    expect(collection).toBeDefined();
    const pending = await service.preparePayment(guildId, collection!.collection.id, adminMember, 100_000, new Date('2026-08-29T00:00:00.000Z'));
    const pendingProof = await persistProof(service, pending, 'weekly-proof-pending', adminMember);

    const overdue = await service.processConversion(guildId, collection!.collection.id, new Date('2026-08-30T17:00:00.000Z'));
    expect(overdue.collection.isClosed).toBe(false);
    expect(overdue.obligations.find(({ member }) => member.discordUserId === reserveMember)?.obligation).toMatchObject({
      status: 'EXEMPT',
      amount: 0,
      convertedFineId: null,
    });
    expect(overdue.obligations.find(({ member }) => member.discordUserId === adminMember)?.obligation.status).toBe('PENDING_VERIFICATION');
    const firstOverdue = overdue.obligations.find(({ member }) => member.discordUserId === secondMember)!.obligation;
    expect(firstOverdue).toMatchObject({ status: 'UNPAID', amount: 120_000, accruedFineAmount: 50_000, convertedFineId: null });
    expect(weeklyAmountDue(firstOverdue)).toBe(170_000);

    const recurring = await service.processConversion(guildId, collection!.collection.id, new Date('2026-08-31T17:00:00.000Z'));
    const secondOverdue = recurring.obligations.find(({ member }) => member.discordUserId === secondMember)!.obligation;
    expect(secondOverdue.accruedFineAmount).toBe(75_000);
    expect(weeklyAmountDue(secondOverdue)).toBe(195_000);

    const rejected = await service.rejectPayment(guildId, pendingProof.proof.id, actor, 'ยอดในรูปไม่ตรง', new Date('2026-08-30T18:00:00.000Z'));
    expect(rejected.proof.status).toBe('REJECTED');
    const [adminObligation] = await db.select().from(weeklyObligations).where(eq(weeklyObligations.id, rejected.obligation.id));
    expect(adminObligation).toMatchObject({ status: 'UNPAID', accruedFineAmount: 50_000, convertedFineId: null });
  });

  it('lets Admin postpone and change a weekly fine, then exempt and re-enable a member after deadline', async () => {
    const collection = (await service.list(guildId)).find(({ collection: value }) => (
      value.requestId === 'weekly-create-1'
    ));
    expect(collection).toBeDefined();

    const adjustedAt = new Date('2026-09-01T00:00:00.000Z');
    const postponedUntil = new Date('2026-09-03T17:00:00.000Z');
    const adjusted = await service.setMemberFinePolicy(
      guildId,
      collection!.collection.id,
      adminMember,
      postponedUntil,
      10_000,
      5_000,
      'ลาฉุกเฉินสองวัน',
      actor,
      adjustedAt,
    );
    const adminObligation = adjusted.obligations.find(({ member }) => member.discordUserId === adminMember)!.obligation;
    expect(adminObligation).toMatchObject({
      status: 'UNPAID',
      amount: 100_000,
      accruedFineAmount: 0,
      overdueFineAmountOverride: 10_000,
      recurringFineAmountOverride: 5_000,
      fineConversionAt: postponedUntil,
    });

    const secondObligation = collection!.obligations.find(({ member }) => member.discordUserId === secondMember)!.obligation;
    expect(secondObligation.accruedFineAmount).toBe(75_000);
    const exempted = await service.setMemberRule(
      guildId,
      collection!.collection.id,
      secondMember,
      'EXEMPT',
      0,
      'ลาเหตุฉุกเฉิน',
      actor,
      new Date('2026-09-01T00:01:00.000Z'),
    );
    expect(exempted.obligations.find(({ member }) => member.discordUserId === secondMember)?.obligation)
      .toMatchObject({ status: 'EXEMPT', amount: 0, accruedFineAmount: 0, convertedFineId: null, rejectionReason: 'ลาเหตุฉุกเฉิน' });

    const requiredAgain = await service.setMemberRule(
      guildId,
      collection!.collection.id,
      secondMember,
      'REQUIRED',
      130_000,
      null,
      actor,
      new Date('2026-09-01T00:02:00.000Z'),
    );
    const requiredObligation = requiredAgain.obligations.find(({ member }) => member.discordUserId === secondMember)!.obligation;
    expect(requiredObligation).toMatchObject({ status: 'UNPAID', amount: 130_000, accruedFineAmount: 50_000, convertedFineId: null });
    expect(weeklyAmountDue(requiredObligation)).toBe(180_000);
  });

  it('keeps a postponed member unpaid at the deadline and accrues only at the personal fine time', async () => {
    const created = await service.create({
      guildId,
      requestId: 'weekly-personal-fine-delay',
      title: 'รอบทดสอบเลื่อนค่าปรับ',
      startsOn: '2026-09-14',
      endsOn: '2026-09-20',
      standardAmount: 200_000,
      overdueFineAmount: 20_000,
      recurringFineAmount: 20_000,
      timezone: 'Asia/Bangkok',
      actorDiscordUserId: actor,
      now: new Date('2026-09-14T00:00:00.000Z'),
    });
    const personalFineAt = new Date('2026-09-22T17:00:00.000Z');
    await service.setMemberFinePolicy(
      guildId,
      created.collection.id,
      secondMember,
      personalFineAt,
      7_000,
      3_000,
      'อนุมัติเลื่อนค่าปรับ',
      actor,
      new Date('2026-09-15T00:00:00.000Z'),
    );

    const closed = await service.processConversion(
      guildId,
      created.collection.id,
      created.collection.conversionAt,
    );
    expect(closed.collection.isClosed).toBe(false);
    expect(closed.obligations.find(({ member }) => member.discordUserId === secondMember)?.obligation.status).toBe('UNPAID');

    const accrued = await service.processConversion(guildId, created.collection.id, personalFineAt);
    const obligation = accrued.obligations.find(({ member }) => member.discordUserId === secondMember)!.obligation;
    expect(obligation).toMatchObject({ status: 'UNPAID', amount: 200_000, accruedFineAmount: 7_000 });
    expect(weeklyAmountDue(obligation)).toBe(207_000);
  });

  it('accepts the full weekly balance after the deadline and closes only after everyone is settled', async () => {
    const created = await service.create({
      guildId,
      requestId: 'weekly-close-after-settlement',
      title: 'รอบปิดเมื่อจ่ายครบ',
      startsOn: '2026-10-05',
      endsOn: '2026-10-06',
      standardAmount: 200_000,
      overdueFineAmount: 20_000,
      recurringFineAmount: 20_000,
      timezone: 'Asia/Bangkok',
      actorDiscordUserId: actor,
      now: new Date('2026-10-04T17:00:00.000Z'),
    });
    for (const memberId of [firstMember, adminMember]) {
      await service.setMemberRule(
        guildId, created.collection.id, memberId, 'EXEMPT', 0, 'ยกเว้นเพื่อทดสอบ', actor,
        new Date('2026-10-05T00:00:00.000Z'),
      );
    }
    const overdue = await service.processConversion(
      guildId,
      created.collection.id,
      created.collection.conversionAt,
    );
    expect(overdue.collection.isClosed).toBe(false);
    const obligation = overdue.obligations.find(({ member }) => member.discordUserId === secondMember)!.obligation;
    expect(weeklyAmountDue(obligation)).toBe(220_000);

    const prepared = await service.preparePayment(
      guildId,
      created.collection.id,
      secondMember,
      220_000,
      created.collection.conversionAt,
    );
    const proof = await persistProof(
      service,
      prepared,
      'weekly-proof-after-deadline',
      secondMember,
      new Date(created.collection.conversionAt.getTime() + 1_000),
    );
    await service.approvePayment(
      guildId,
      proof.proof.id,
      actor,
      new Date(created.collection.conversionAt.getTime() + 2_000),
    );
    expect((await service.get(guildId, created.collection.id)).collection.isClosed).toBe(true);
    await service.cancelCollection(
      guildId,
      created.collection.id,
      actor,
      'ล้างข้อมูลทดสอบหลังยืนยันการปิดรอบ',
      new Date(created.collection.conversionAt.getTime() + 3_000),
      true,
    );
  });

  it('restores legacy unpaid weekly fines into the original weekly collection', async () => {
    const created = await service.create({
      guildId,
      requestId: 'weekly-legacy-fine-restore',
      title: 'รอบเก่าที่ถูกแปลงเป็นค่าปรับ',
      startsOn: '2026-10-12',
      endsOn: '2026-10-13',
      standardAmount: 200_000,
      overdueFineAmount: 20_000,
      recurringFineAmount: 20_000,
      timezone: 'Asia/Bangkok',
      actorDiscordUserId: actor,
      now: new Date('2026-10-11T17:00:00.000Z'),
    });
    const obligation = created.obligations.find(({ member }) => member.discordUserId === secondMember)!.obligation;
    const [legacyFine] = await db.insert(fines).values({
      guildId,
      requestId: 'legacy-weekly-fine',
      memberId: obligation.memberId,
      reason: 'ค้างส่งเงินรายสัปดาห์',
      principalAmount: 220_000,
      surchargeAmount: 20_000,
      accruedSurchargeAmount: 20_000,
      dueAt: created.collection.conversionAt,
      nextSurchargeAt: new Date(created.collection.conversionAt.getTime() + 48 * 60 * 60 * 1_000),
      sourceType: 'WEEKLY_DUES',
      sourceId: obligation.id,
      createdByDiscordUserId: 'SYSTEM',
    }).returning();
    await db.update(weeklyObligations).set({ status: 'CONVERTED_TO_FINE', convertedFineId: legacyFine!.id })
      .where(eq(weeklyObligations.id, obligation.id));
    await db.update(weeklyCollections).set({ isClosed: true }).where(eq(weeklyCollections.id, created.collection.id));

    expect(await service.restoreOutstandingWeeklyFines(
      guildId,
      new Date(created.collection.conversionAt.getTime() + 24 * 60 * 60 * 1_000),
    )).toBeGreaterThanOrEqual(1);
    const restored = await service.get(guildId, created.collection.id);
    expect(restored.collection.isClosed).toBe(false);
    expect(restored.obligations.find(({ member }) => member.discordUserId === secondMember)?.obligation)
      .toMatchObject({ status: 'UNPAID', amount: 200_000, accruedFineAmount: 40_000, convertedFineId: null });
    const [cancelledFine] = await db.select().from(fines).where(eq(fines.id, legacyFine!.id));
    expect(cancelledFine?.status).toBe('CANCELLED');
  });

  it('queues publish, accrual, refresh, and treasury jobs', async () => {
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(new Set(jobs.map((job) => job.jobType))).toEqual(expect.objectContaining(new Set([
      'WEEKLY_PUBLISH',
      'WEEKLY_CONVERT',
      'WEEKLY_REFRESH',
      'TREASURY_PUBLISH',
      'TREASURY_REFRESH',
    ])));
  });

  it('reverses an approved payment once and restores the overdue weekly balance with its fine', async () => {
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
    expect(obligation).toMatchObject({ status: 'UNPAID', accruedFineAmount: 75_000, convertedFineId: null });
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

  it('cancels an overdue collection without creating separate fines and ignores accrual retries', async () => {
    const collection = (await service.list(guildId)).find(({ collection: value }) => (
      value.requestId === 'weekly-create-1'
    ));
    expect(collection).toBeDefined();
    expect(collection!.collection.isClosed).toBe(false);
    expect(collection!.obligations.every(({ obligation }) => obligation.convertedFineId === null)).toBe(true);

    const cancelled = await service.cancelCollection(
      guildId,
      collection!.collection.id,
      actor,
      'ยกเลิกรอบย้อนหลัง',
      new Date('2026-09-08T04:00:00.000Z'),
      true,
    );
    expect(cancelled.obligations.every(({ obligation }) => obligation.status === 'EXEMPT')).toBe(true);

    const retried = await service.processConversion(
      guildId,
      collection!.collection.id,
      new Date('2026-09-09T00:00:00.000Z'),
    );
    expect(retried.collection.cancelledAt).not.toBeNull();
    expect(retried.obligations.every(({ obligation }) => obligation.status === 'EXEMPT')).toBe(true);
  });

  it('exempts existing unpaid reserve dues idempotently while preserving other obligations', async () => {
    const now = new Date('2026-09-14T00:00:00.000Z');
    const created = await service.create({
      guildId, requestId: 'reserve-retroactive', title: 'Reserve exemption',
      startsOn: '2026-09-14', endsOn: '2026-09-19', standardAmount: 200_000,
      overdueFineAmount: 50_000, recurringFineAmount: 25_000,
      timezone: 'Asia/Bangkok', actorDiscordUserId: actor, now,
    });
    const reserve = created.obligations.find(({ member }) => member.discordUserId === reserveMember)!;
    // Reproduce an obligation created before reserve exemptions were introduced.
    await db.update(weeklyObligations).set({ status: 'UNPAID', amount: 200_000 })
      .where(eq(weeklyObligations.id, reserve.obligation.id));
    const updated = await service.exemptReserveMembers(guildId, created.collection.id, actor, now);
    expect(updated.obligations.find(({ member }) => member.discordUserId === reserveMember)?.obligation)
      .toMatchObject({
        status: 'EXEMPT',
        amount: 0,
        rejectionReason: 'ยกเว้นเนื่องจากเป็นตำแหน่งสำรอง',
        convertedFineId: null,
        decidedByDiscordUserId: actor,
      });
    expect(updated.obligations.filter(({ member }) => member.discordUserId !== reserveMember))
      .toEqual(created.obligations.filter(({ member }) => member.discordUserId !== reserveMember));
    expect(await service.exemptReserveMembers(guildId, created.collection.id, actor, now)).toEqual(updated);
    await expect(service.exemptReserveMembers(guildId, created.collection.id, actor, created.collection.conversionAt))
      .rejects.toBeInstanceOf(ConflictError);
    const overdue = await service.processConversion(guildId, created.collection.id, created.collection.conversionAt);
    expect(overdue.collection.isClosed).toBe(false);
    expect(overdue.obligations.find(({ member }) => member.discordUserId === reserveMember)?.obligation)
      .toMatchObject({ status: 'EXEMPT', amount: 0, convertedFineId: null });
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
