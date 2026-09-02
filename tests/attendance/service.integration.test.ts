import { and, eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import {
  attendanceRecords,
  guildSettings,
  members,
  scheduledJobs,
} from '../../src/infrastructure/db/schema.js';
import { buildAttendanceRoundTimes } from '../../src/modules/attendance/rules.js';
import { AttendanceService, type AttendanceRound } from '../../src/modules/attendance/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('AttendanceService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: AttendanceService;
  let round: AttendanceRound;
  const guildId = 'attendance-integration-guild';
  const alpha = '200000000000000001';
  const beta = '200000000000000002';
  const charlie = '200000000000000003';
  const timezone = 'Asia/Bangkok';

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new AttendanceService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId, timezone }).onConflictDoNothing();
    await db.insert(members).values([
      { guildId, discordUserId: alpha, inGameName: 'Alpha', status: 'ACTIVE' },
      { guildId, discordUserId: beta, inGameName: 'Beta', status: 'ACTIVE' },
      { guildId, discordUserId: charlie, inGameName: 'Charlie', status: 'ACTIVE' },
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates an idempotent open round and durable lifecycle jobs', async () => {
    const input = {
      guildId,
      requestId: 'attendance-create-1',
      title: 'เช็กชื่อประจำวัน',
      ...buildAttendanceRoundTimes('2026-08-27', '19:00', '21:30', timezone),
      actorDiscordUserId: alpha,
      now: new Date('2026-08-27T12:05:00.000Z'),
    } as const;
    round = await service.createRound(input);
    const duplicate = await service.createRound(input);
    expect(duplicate.id).toBe(round.id);
    expect(round.status).toBe('OPEN');

    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(jobs.filter((job) => (job.payload as { roundId?: string }).roundId === round.id).map((job) => job.jobType).sort()).toEqual([
      'ATTENDANCE_CLOSE',
      'ATTENDANCE_OPEN',
      'ATTENDANCE_PUBLISH',
      'ATTENDANCE_REMINDER',
    ]);
  });

  it('shows only unchecked members without timely leave in the reminder', async () => {
    await service.checkIn(guildId, round.id, alpha, new Date('2026-08-27T12:10:00.000Z'));
    await service.submitLeave({
      guildId,
      requestId: 'leave-beta',
      discordUserId: beta,
      startsOn: '2026-08-27',
      endsOn: '2026-08-27',
      reason: 'ติดธุระ',
      timezone,
      now: new Date('2026-08-27T10:00:00.000Z'),
    });
    expect(await service.getReminderRecipients(guildId, round.id)).toEqual([charlie]);
  });

  it('closes as present, leave, and absent using the locked rules', async () => {
    await service.closeRound(guildId, round.id, new Date('2026-08-27T14:30:01.000Z'));
    const view = await service.getRoundView(guildId, round.id);
    expect(view.present.map((member) => member.inGameName)).toEqual(['Alpha']);
    expect(view.leave.map((member) => member.inGameName)).toEqual(['Beta']);
    expect(view.absent.map((member) => member.inGameName)).toEqual(['Charlie']);
  });

  it('reclassifies checked-in member as emergency leave but keeps late non-check-in absent', async () => {
    await service.submitLeave({
      guildId,
      requestId: 'leave-alpha-emergency',
      discordUserId: alpha,
      startsOn: '2026-08-27',
      endsOn: '2026-08-27',
      reason: 'เหตุฉุกเฉิน',
      timezone,
      now: new Date('2026-08-27T15:00:00.000Z'),
    });
    await service.submitLeave({
      guildId,
      requestId: 'leave-charlie-late',
      discordUserId: charlie,
      startsOn: '2026-08-27',
      endsOn: '2026-08-27',
      reason: 'แจ้งหลังปิด',
      timezone,
      now: new Date('2026-08-27T15:05:00.000Z'),
    });
    const view = await service.getRoundView(guildId, round.id);
    expect(view.emergencyLeave.map((member) => member.inGameName)).toEqual(['Alpha']);
    expect(view.absent.map((member) => member.inGameName)).toEqual(['Charlie']);
  });

  it('lets Admin correct a closed result and records the correction', async () => {
    await service.correctAttendance(guildId, round.id, charlie, 'LEAVE', 'Admin ตรวจหลักฐานแล้ว', alpha, new Date('2026-08-27T15:10:00.000Z'));
    const [record] = await db
      .select({ result: attendanceRecords.result, reason: attendanceRecords.correctionReason })
      .from(attendanceRecords)
      .innerJoin(members, eq(attendanceRecords.memberId, members.id))
      .where(and(eq(attendanceRecords.roundId, round.id), eq(members.discordUserId, charlie)));
    expect(record).toEqual({ result: 'LEAVE', reason: 'Admin ตรวจหลักฐานแล้ว' });
  });

  it('materializes recurring rounds and a next-day durable tick idempotently', async () => {
    const schedule = await service.createRecurringSchedule({
      guildId,
      requestId: 'attendance-schedule-1',
      name: 'รอบทุกวัน',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      opensAtLocalTime: '19:00',
      closesAtLocalTime: '21:30',
      timezone,
      actorDiscordUserId: alpha,
      now: new Date('2026-08-28T02:00:00.000Z'),
    });
    await service.materializeSchedule(guildId, schedule.id, timezone, new Date('2026-08-28T02:00:00.000Z'));
    const rounds = await service.listRounds(guildId, 25);
    expect(rounds.some((candidate) => candidate.sourceScheduleId === schedule.id)).toBe(true);
    const ticks = await db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.guildId, guildId),
      eq(scheduledJobs.jobType, 'ATTENDANCE_SCHEDULE_TICK'),
    ));
    expect(ticks).toHaveLength(1);
  });
});
