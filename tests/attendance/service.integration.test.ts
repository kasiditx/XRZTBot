import { and, eq } from 'drizzle-orm';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import {
  attendanceProofs,
  attendanceRecords,
  guildSettings,
  members,
  scheduledJobs,
} from '../../src/infrastructure/db/schema.js';
import { buildAirdropRoundTimes, buildAttendanceRoundTimes } from '../../src/modules/attendance/rules.js';
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
      mode: 'GENERAL',
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
      mode: 'GENERAL',
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

  it('requires a fresh image proof for every Airdrop round', async () => {
    const eventAt = new Date('2026-08-29T14:00:00.000Z');
    const firstRound = await service.createRound({
      guildId,
      requestId: 'airdrop-round-1',
      title: 'Airdrop 21:00',
      mode: 'AIRDROP',
      eventAt,
      ...buildAirdropRoundTimes(eventAt, timezone, 10, 10),
      actorDiscordUserId: alpha,
      now: new Date('2026-08-29T13:51:00.000Z'),
    });

    await expect(service.checkIn(
      guildId,
      firstRound.id,
      alpha,
      new Date('2026-08-29T13:52:00.000Z'),
    )).rejects.toBeInstanceOf(ValidationError);

    const proof = {
      attachmentId: 'proof-attachment-1',
      channelId: 'proof-channel-1',
      messageId: 'proof-message-1',
      sha256: 'a'.repeat(64),
    } as const;
    const record = await service.checkInWithProof(
      guildId,
      firstRound.id,
      alpha,
      proof,
      new Date('2026-08-29T13:52:00.000Z'),
    );
    expect(record).toMatchObject({ result: 'PRESENT', proofSha256: proof.sha256 });

    const secondEventAt = new Date('2026-08-29T16:00:00.000Z');
    const secondRound = await service.createRound({
      guildId,
      requestId: 'airdrop-round-2',
      title: 'Airdrop 23:00',
      mode: 'AIRDROP',
      eventAt: secondEventAt,
      ...buildAirdropRoundTimes(secondEventAt, timezone, 10, 10),
      actorDiscordUserId: alpha,
      now: new Date('2026-08-29T15:51:00.000Z'),
    });
    await expect(service.checkInWithProof(
      guildId,
      secondRound.id,
      alpha,
      { ...proof, attachmentId: 'proof-attachment-2', messageId: 'proof-message-2' },
      new Date('2026-08-29T15:52:00.000Z'),
    )).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects the latest proof, marks the member absent, and accepts a fresh replacement while the round is open', async () => {
    const eventAt = new Date('2026-09-01T14:00:00.000Z');
    const reviewRound = await service.createRound({
      guildId,
      requestId: 'airdrop-proof-review',
      title: 'Airdrop proof review',
      mode: 'AIRDROP',
      eventAt,
      ...buildAirdropRoundTimes(eventAt, timezone, 10, 10),
      actorDiscordUserId: alpha,
      now: new Date('2026-09-01T13:51:00.000Z'),
    });
    const firstProof = {
      attachmentId: 'review-attachment-1',
      channelId: 'review-channel',
      messageId: '300000000000000001',
      sha256: 'b'.repeat(64),
    } as const;
    await service.checkInWithProof(
      guildId,
      reviewRound.id,
      beta,
      firstProof,
      new Date('2026-09-01T13:52:00.000Z'),
    );

    const rejected = await service.rejectProof(
      guildId,
      reviewRound.id,
      firstProof.messageId,
      'รูปไม่เห็นรายชื่อในวอ',
      alpha,
      new Date('2026-09-01T13:53:00.000Z'),
    );
    expect(rejected.proof).toMatchObject({ status: 'REJECTED', rejectionReason: 'รูปไม่เห็นรายชื่อในวอ' });
    expect(rejected.record).toMatchObject({ result: 'ABSENT', checkedInAt: null });

    const replacementProof = {
      attachmentId: 'review-attachment-2',
      channelId: 'review-channel',
      messageId: '300000000000000002',
      sha256: 'c'.repeat(64),
    } as const;
    const replacement = await service.checkInWithProof(
      guildId,
      reviewRound.id,
      beta,
      replacementProof,
      new Date('2026-09-01T13:54:00.000Z'),
    );
    expect(replacement).toMatchObject({
      result: 'PRESENT',
      proofMessageId: replacementProof.messageId,
      correctedByDiscordUserId: null,
      correctionReason: null,
    });
    await expect(service.rejectProof(
      guildId,
      reviewRound.id,
      firstProof.messageId,
      'พยายามกดปุ่มเก่า',
      alpha,
      new Date('2026-09-01T13:55:00.000Z'),
    )).rejects.toBeInstanceOf(ConflictError);

    const proofHistory = await db
      .select({ status: attendanceProofs.status, sha256: attendanceProofs.sha256 })
      .from(attendanceProofs)
      .where(eq(attendanceProofs.roundId, reviewRound.id));
    expect(proofHistory).toEqual(expect.arrayContaining([
      { status: 'REJECTED', sha256: firstProof.sha256 },
      { status: 'PENDING', sha256: replacementProof.sha256 },
    ]));

    const laterEventAt = new Date('2026-09-01T16:00:00.000Z');
    const laterRound = await service.createRound({
      guildId,
      requestId: 'airdrop-rejected-proof-reuse',
      title: 'Airdrop rejected proof reuse',
      mode: 'AIRDROP',
      eventAt: laterEventAt,
      ...buildAirdropRoundTimes(laterEventAt, timezone, 10, 10),
      actorDiscordUserId: alpha,
      now: new Date('2026-09-01T15:51:00.000Z'),
    });
    await expect(service.checkInWithProof(
      guildId,
      laterRound.id,
      charlie,
      {
        ...firstProof,
        attachmentId: 'review-attachment-reused',
        messageId: '300000000000000003',
      },
      new Date('2026-09-01T15:52:00.000Z'),
    )).rejects.toBeInstanceOf(ConflictError);
  });

  it('materializes every configured Airdrop time on the same weekday', async () => {
    const common = {
      guildId,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      mode: 'AIRDROP' as const,
      opensBeforeMinutes: 10,
      closesAfterMinutes: 10,
      timezone,
      actorDiscordUserId: alpha,
      now: new Date('2026-08-30T02:00:00.000Z'),
    };
    const evening = await service.createRecurringSchedule({
      ...common,
      requestId: 'airdrop-auto-evening',
      name: 'Airdrop 21:00',
      eventAtLocalTime: '21:00',
    });
    const midnight = await service.createRecurringSchedule({
      ...common,
      requestId: 'airdrop-auto-midnight',
      name: 'Airdrop 00:00',
      eventAtLocalTime: '00:00',
    });

    const rounds = await service.listRounds(guildId, 100);
    const eveningRound = rounds.find((candidate) => candidate.sourceScheduleId === evening.id && candidate.attendanceDate === '2026-08-30');
    const midnightRound = rounds.find((candidate) => candidate.sourceScheduleId === midnight.id && candidate.attendanceDate === '2026-08-31');
    expect(eveningRound).toMatchObject({ mode: 'AIRDROP' });
    expect(midnightRound).toMatchObject({ mode: 'AIRDROP' });
    expect(midnightRound?.opensAt.toISOString()).toBe('2026-08-30T16:50:00.000Z');
    expect(midnightRound?.closesAt.toISOString()).toBe('2026-08-30T17:10:00.000Z');
  });
});
