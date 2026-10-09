import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { attendanceRecords, attendanceRounds, attendanceSchedules, guildSettings, scheduledJobs } from '../../src/infrastructure/db/schema.js';
import { buildAttendanceRoundTimes } from '../../src/modules/attendance/rules.js';
import { AttendanceService, type AttendanceRound } from '../../src/modules/attendance/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;
const guildId = 'attendance-announcements-test';
const otherGuildId = `${guildId}-other`;
const actor = '200000000000000011';
const timezone = 'Asia/Bangkok';
const now = new Date('2026-10-09T02:00:00.000Z');

describeWithDatabase('recurring attendance announcement timing PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: AttendanceService;
  let scheduleId: string;

  beforeAll(() => {
    if (databaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(databaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new AttendanceService(db);
  });

  beforeEach(async () => {
    for (const id of [guildId, otherGuildId]) {
      await db.delete(guildSettings).where(eq(guildSettings.guildId, id));
      await db.insert(guildSettings).values({ guildId: id, timezone });
    }
    scheduleId = randomUUID();
    await db.insert(attendanceSchedules).values({
      id: scheduleId, guildId, requestId: 'fixture-schedule', name: 'ทดสอบคิวเดิม', mode: 'GENERAL',
      weekdays: [1, 2, 3, 4, 5, 6, 7], opensAtLocalTime: '19:00', closesAtLocalTime: '21:00', createdByDiscordUserId: actor,
    });
  });

  afterAll(async () => {
    try {
      for (const id of [guildId, otherGuildId]) await db.delete(guildSettings).where(eq(guildSettings.guildId, id));
    } finally {
      await pool.end();
    }
  });

  async function createLegacyRound(requestId: string, auto = true, roundGuildId = guildId): Promise<AttendanceRound> {
    return service.createRound({
      guildId: roundGuildId, requestId, title: 'ทดสอบเวลาเผยแพร่', mode: 'GENERAL',
      ...buildAttendanceRoundTimes('2026-10-09', '19:00', '21:00', timezone),
      actorDiscordUserId: actor, now,
      ...(auto ? { sourceScheduleId: scheduleId } : {}),
    });
  }

  async function publishJob(round: AttendanceRound) {
    const [job] = await db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.guildId, round.guildId),
      eq(scheduledJobs.deduplicationKey, `attendance:${round.id}:publish`),
    ));
    if (job === undefined) throw new Error('Missing publish job');
    return job;
  }

  it('queues 23:00 and 23:30 Airdrops separately at 22:50 and 23:20 with the original opening and closing times', async () => {
    const createdAt = new Date('2026-10-09T15:39:00.000Z');
    for (const [time, expectedPublishAt, expectedOpenAt, expectedCloseAt] of [
      ['23:00', '2026-10-09T15:50:00.000Z', '2026-10-09T15:55:00.000Z', '2026-10-09T16:20:00.000Z'],
      ['23:30', '2026-10-09T16:20:00.000Z', '2026-10-09T16:25:00.000Z', '2026-10-09T16:50:00.000Z'],
    ] as const) {
      const input = {
        guildId, requestId: `airdrop-${time}`, name: `Airdrop ${time}`, mode: 'AIRDROP',
        weekdays: [1, 2, 3, 4, 5, 6, 7], eventAtLocalTime: time, opensBeforeMinutes: 5, closesAfterMinutes: 20,
        timezone, actorDiscordUserId: actor, now: createdAt,
      } as const;
      const schedule = await service.createRecurringSchedule(input);
      expect((await service.createRecurringSchedule(input)).id).toBe(schedule.id);
      await service.materializeSchedule(guildId, schedule.id, timezone, createdAt);
      const rounds = await db.select().from(attendanceRounds).where(and(
        eq(attendanceRounds.guildId, guildId), eq(attendanceRounds.sourceScheduleId, schedule.id),
      ));
      const today = rounds.find(round => round.attendanceDate === '2026-10-09');
      if (today === undefined) throw new Error('Missing today round');
      expect(rounds.filter(round => round.attendanceDate === today.attendanceDate)).toHaveLength(1);
      expect((await publishJob(today)).runAt.toISOString()).toBe(expectedPublishAt);
      expect(today.opensAt.toISOString()).toBe(expectedOpenAt);
      expect(today.closesAt.toISOString()).toBe(expectedCloseAt);
    }
  });

  it('reschedules legacy pending auto announcements once and preserves round data and other lifecycle jobs', async () => {
    const first = await createLegacyRound('first-auto');
    const second = await createLegacyRound('second-auto');
    const roundsBefore = await db.select().from(attendanceRounds).where(eq(attendanceRounds.guildId, guildId));
    const recordsBefore = await db.select().from(attendanceRecords);
    const jobsBefore = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(await service.rescheduleRecurringAnnouncements(guildId, now)).toBe(2);
    for (const round of [first, second]) {
      expect((await publishJob(round)).runAt.toISOString()).toBe('2026-10-09T11:55:00.000Z');
    }
    expect(await service.rescheduleRecurringAnnouncements(guildId, now)).toBe(0);
    expect(await db.select().from(attendanceRounds).where(eq(attendanceRounds.guildId, guildId))).toEqual(roundsBefore);
    expect(await db.select().from(attendanceRecords)).toEqual(recordsBefore);
    const jobsAfter = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    for (const job of jobsBefore.filter(job => job.jobType !== 'ATTENDANCE_PUBLISH')) {
      expect(jobsAfter.find(candidate => candidate.id === job.id)).toEqual(job);
    }
  });

  it.each(['2026-10-09T15:50:00.000Z', '2026-10-09T15:53:00.000Z', '2026-10-09T16:01:00.000Z'])(
    'queues an immediate announcement when Auto is created after the announcement time at %s', async (createdAt) => {
      const schedule = await service.createRecurringSchedule({
        guildId, requestId: 'late-auto', name: 'Airdrop 23:00', mode: 'AIRDROP',
        weekdays: [1, 2, 3, 4, 5, 6, 7], eventAtLocalTime: '23:00', opensBeforeMinutes: 5, closesAfterMinutes: 20,
        timezone, actorDiscordUserId: actor, now: new Date(createdAt),
      });
      const [round] = await db.select().from(attendanceRounds).where(and(
        eq(attendanceRounds.guildId, guildId), eq(attendanceRounds.sourceScheduleId, schedule.id),
        eq(attendanceRounds.attendanceDate, '2026-10-09'),
      ));
      if (round === undefined) throw new Error('Missing today round');
      expect((await publishJob(round)).runAt.toISOString()).toBe(createdAt);
    },
  );

  it.each(['manual', 'published', 'running', 'completed', 'cancelled', 'cancelled-round', 'closed-round', 'other-guild', 'retry-backoff', 'already-due'] as const)(
    'does not reschedule %s announcements', async (kind) => {
      const round = await createLegacyRound('protected', kind !== 'manual', kind === 'other-guild' ? otherGuildId : guildId);
      const job = await publishJob(round);
      if (kind === 'published') await service.markRoundPublished(round.guildId, round.id, 'channel', 'message');
      if (kind === 'running' || kind === 'completed' || kind === 'cancelled') {
        const statuses = { running: 'RUNNING', completed: 'COMPLETED', cancelled: 'CANCELLED' } as const;
        await db.update(scheduledJobs).set({ status: statuses[kind] }).where(eq(scheduledJobs.id, job.id));
      }
      if (kind === 'retry-backoff') {
        await db.update(scheduledJobs).set({ attempts: 1, runAt: new Date('2026-10-09T12:05:00.000Z') }).where(eq(scheduledJobs.id, job.id));
      }
      if (kind === 'cancelled-round') {
        await db.update(attendanceRounds).set({
          status: 'CANCELLED', cancelledAt: now, cancelledByDiscordUserId: actor, cancellationReason: 'ยกเลิกรอบทดสอบ',
        }).where(eq(attendanceRounds.id, round.id));
      }
      if (kind === 'closed-round') await db.update(attendanceRounds).set({ status: 'CLOSED' }).where(eq(attendanceRounds.id, round.id));
      const before = await publishJob(round);
      const repairAt = kind === 'already-due' ? new Date('2026-10-09T11:56:00.000Z') : now;
      expect(await service.rescheduleRecurringAnnouncements(guildId, repairAt)).toBe(0);
      expect(await publishJob(round)).toEqual(before);
    },
  );
});
