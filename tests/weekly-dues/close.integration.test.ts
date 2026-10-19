import { and, eq } from 'drizzle-orm';
import { AuthorizationError, ConflictError, ValidationError, NotFoundError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import {
  auditLogs,
  fines,
  guildSettings,
  members,
  scheduledJobs,
  treasuryEntries,
  weeklyCollections,
  weeklyObligations,
} from '../../src/infrastructure/db/schema.js';
import {
  WeeklyDuesService,
  type PreparedWeeklyPayment,
  type WeeklyCollectionView,
} from '../../src/modules/weekly-dues/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;
const guildId = 'weekly-manual-close-test';
const actor = '500000000000000011';
const alice = '500000000000000012',
  bob = '500000000000000013',
  charlie = '500000000000000014';
const now = new Date('2026-10-12T02:00:00.000Z');
const closeAt = new Date('2026-10-15T02:00:00.000Z');
const later = new Date('2026-10-25T02:00:00.000Z');

describeWithDatabase('weekly manual closure PostgreSQL integration', () => {
  let db: Database,
    pool: ReturnType<typeof createDatabase>['pool'],
    service: WeeklyDuesService,
    view: WeeklyCollectionView;
  beforeAll(() => {
    if (databaseUrl === undefined) throw new Error('TEST_DATABASE_URL required');
    const connection = createDatabase(databaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new WeeklyDuesService(db);
  });
  beforeEach(async () => {
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId, timezone: 'Asia/Bangkok' });
    await db
      .insert(members)
      .values(
        [alice, bob, charlie].map((discordUserId, i) => ({
          guildId,
          discordUserId,
          inGameName: `Member ${i}`,
          status: 'ACTIVE' as const,
        })),
      );
    view = await service.create({
      guildId,
      requestId: 'round',
      title: 'ส่งเงินรอบทดสอบ',
      startsOn: '2026-10-12',
      endsOn: '2026-10-18',
      standardAmount: 100_000,
      overdueFineAmount: 50_000,
      recurringFineAmount: 25_000,
      timezone: 'Asia/Bangkok',
      actorDiscordUserId: actor,
      now,
    });
  });
  afterAll(async () => {
    try {
      await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    } finally {
      await pool.end();
    }
  });
  async function submit(member: string) {
    const prepared = await service.preparePayment(guildId, view.collection.id, member, 100_000, now);
    return persist(prepared, member, now);
  }
  async function persist(prepared: PreparedWeeklyPayment, member: string, at: Date) {
    return service.persistPayment({
      prepared,
      requestId: `proof-${member}`,
      submittedByDiscordUserId: member,
      attachmentId: `attachment-${member}`,
      logChannelId: 'log-channel',
      logMessageId: `log-${member}`,
      now: at,
    });
  }
  async function close(at = closeAt) {
    return service.closeCollection(guildId, view.collection.id, actor, 'ปิดยอดสัปดาห์นี้', at, true);
  }
  async function entries() {
    return db.select().from(treasuryEntries).where(eq(treasuryEntries.guildId, guildId));
  }
  async function jobs() {
    return db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
  }

  it('closes with unpaid and pending members, keeps approved income intact and audits once under concurrent retries', async () => {
    const paid = await submit(alice);
    await service.approvePayment(guildId, paid.proof.id, actor, now);
    const pending = await submit(bob);
    const before = await service.get(guildId, view.collection.id);
    const incomeBefore = await entries();
    await Promise.all([close(), close()]);
    const closed = await service.get(guildId, view.collection.id);
    expect(closed.collection).toMatchObject({
      isClosed: true,
      manuallyClosedAt: closeAt,
      manuallyClosedByDiscordUserId: actor,
      manualClosureReason: 'ปิดยอดสัปดาห์นี้',
      cancelledAt: null,
    });
    expect(closed.obligations).toEqual(before.obligations);
    expect(await entries()).toEqual(incomeBefore);
    expect((await service.getProof(guildId, pending.proof.id)).proof.status).toBe('PENDING');
    expect((await jobs()).filter((j) => j.jobType === 'WEEKLY_CONVERT').every((j) => j.status === 'CANCELLED')).toBe(
      true,
    );
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.guildId, guildId), eq(auditLogs.action, 'WEEKLY_COLLECTION_MANUALLY_CLOSED')));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorDiscordUserId).toBe(actor);
    expect((await close(later)).collection.manuallyClosedAt).toEqual(closeAt);
  });

  it('blocks a new payment and a previously prepared form after closure', async () => {
    const prepared = await service.preparePayment(guildId, view.collection.id, charlie, 100_000, now);
    await close();
    await expect(service.preparePayment(guildId, view.collection.id, bob, 100_000, later)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(persist(prepared, charlie, later)).rejects.toBeInstanceOf(ConflictError);
    expect(await entries()).toHaveLength(0);
  });

  it('lets pending evidence be approved after closure without reopening the round', async () => {
    const pending = await submit(bob);
    await close();
    await service.approvePayment(guildId, pending.proof.id, actor, later);
    expect((await service.getProof(guildId, pending.proof.id)).obligation.status).toBe('PAID');
    expect((await entries()).map((e) => e.amount)).toEqual([100_000]);
    expect((await service.get(guildId, view.collection.id)).collection.manuallyClosedAt).toEqual(closeAt);
  });

  it('rejects pending evidence and freezes fines even when an old worker or restoration runs after closure', async () => {
    const pending = await submit(bob);
    await close();
    await service.rejectPayment(guildId, pending.proof.id, actor, 'หลักฐานไม่ถูกต้อง', later);
    const final = await service.processConversion(guildId, view.collection.id, later);
    expect(final.collection.isClosed).toBe(true);
    expect(final.obligations.every((o) => o.obligation.accruedFineAmount === 0)).toBe(true);
    expect(final.obligations.every((o) => o.obligation.status === 'UNPAID')).toBe(true);
    expect((await jobs()).filter((j) => j.jobType === 'WEEKLY_CONVERT' && j.status === 'PENDING')).toHaveLength(0);
    expect(await service.restoreOutstandingWeeklyFines(guildId, later)).toBe(0);
  });

  it('allows an authorized reversal of approved income after manual close without reopening or adding fines', async () => {
    const proof = await submit(alice);
    await service.approvePayment(guildId, proof.proof.id, actor, now);
    await close();
    await expect(service.rejectPayment(guildId, proof.proof.id, actor, 'คืนเงิน', later)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await service.rejectPayment(guildId, proof.proof.id, actor, 'คืนเงิน', later, true);
    expect((await entries()).reduce((total, e) => total + e.amount, 0)).toBe(0);
    const final = await service.get(guildId, view.collection.id);
    expect(final.collection.isClosed).toBe(true);
    expect(final.obligations.every((o) => o.obligation.accruedFineAmount === 0)).toBe(true);
  });

  it('does not let old admin forms modify and reopen a manually closed round', async () => {
    await close();
    await expect(
      service.setMemberRule(guildId, view.collection.id, charlie, 'REQUIRED', 90_000, null, actor, later),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      service.setMemberFinePolicy(
        guildId,
        view.collection.id,
        charlie,
        new Date('2026-11-01T00:00:00Z'),
        1,
        1,
        'เลื่อนค่าปรับ',
        actor,
        later,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      service.overrideAmount(guildId, view.collection.id, charlie, 90_000, actor, later),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects missing authorization, invalid reasons, other guilds and cancelled rounds', async () => {
    await expect(service.closeCollection(guildId, view.collection.id, actor, 'ปิดยอด', closeAt)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      service.closeCollection(guildId, view.collection.id, actor, ' ', closeAt, true),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.closeCollection('other-guild', view.collection.id, actor, 'ปิดยอด', closeAt, true),
    ).rejects.toBeInstanceOf(NotFoundError);
    await service.cancelCollection(guildId, view.collection.id, actor, 'สร้างผิด', now, true);
    await expect(close()).rejects.toBeInstanceOf(ConflictError);
  });

  it('does not cancel another collection fine job and refreshes existing open published panels', async () => {
    await service.markPublished(guildId, view.collection.id, 'public', 'message');
    expect(await service.ensurePublishedAnnouncementRefreshes(guildId, now)).toBe(1);
    await db
      .insert(scheduledJobs)
      .values({
        guildId,
        jobType: 'WEEKLY_CONVERT',
        deduplicationKey: 'other-collection',
        payload: { collectionId: 'other' },
        runAt: later,
      });
    await close();
    expect((await jobs()).find((j) => j.deduplicationKey === 'other-collection')?.status).toBe('PENDING');
    expect(await service.ensurePublishedAnnouncementRefreshes(guildId, later)).toBe(0);
  });

  it('enforces complete closure metadata and forbids reopening a manually closed round in the database', async () => {
    await expect(
      db
        .update(weeklyCollections)
        .set({ manuallyClosedAt: closeAt })
        .where(eq(weeklyCollections.id, view.collection.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(weeklyCollections)
        .set({
          isClosed: true,
          manuallyClosedAt: closeAt,
          manuallyClosedByDiscordUserId: actor,
          manualClosureReason: null,
        })
        .where(eq(weeklyCollections.id, view.collection.id)),
    ).rejects.toThrow();
    await close();
    await expect(
      db.update(weeklyCollections).set({ isClosed: false }).where(eq(weeklyCollections.id, view.collection.id)),
    ).rejects.toThrow();
    const obligations = await db
      .select()
      .from(weeklyObligations)
      .where(eq(weeklyObligations.collectionId, view.collection.id));
    expect(obligations.every((o) => o.status === 'UNPAID')).toBe(true);
  });

  it('does not restore a legacy converted obligation or reopen its manually closed collection', async () => {
    const obligation = view.obligations[0]?.obligation;
    if (obligation === undefined) throw new Error('Missing obligation');
    const [fine] = await db
      .insert(fines)
      .values({
        guildId,
        requestId: 'legacy-fine',
        memberId: obligation.memberId,
        reason: 'ค่าปรับค้างเดิม',
        principalAmount: 100_000,
        surchargeAmount: 20_000,
        accruedSurchargeAmount: 0,
        dueAt: view.collection.conversionAt,
        nextSurchargeAt: later,
        status: 'CANCELLED',
        sourceType: 'WEEKLY_DUES',
        sourceId: obligation.id,
        createdByDiscordUserId: 'SYSTEM',
      })
      .returning();
    if (fine === undefined) throw new Error('Missing legacy fine');
    await db
      .update(weeklyObligations)
      .set({ status: 'CONVERTED_TO_FINE', convertedFineId: fine.id })
      .where(eq(weeklyObligations.id, obligation.id));
    await close();
    expect(await service.restoreOutstandingWeeklyFines(guildId, later)).toBe(0);
    const final = await service.get(guildId, view.collection.id);
    expect(final.collection.isClosed).toBe(true);
    expect(final.obligations.find((o) => o.obligation.id === obligation.id)?.obligation.status).toBe(
      'CONVERTED_TO_FINE',
    );
  });
});
