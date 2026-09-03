import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { and, asc, desc, eq, gte, lte, ne } from 'drizzle-orm';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  attendanceRecords,
  attendanceRounds,
  attendanceSchedules,
  leaves,
  members,
  scheduledJobs,
} from '../../infrastructure/db/schema.js';
import { writeAudit } from '../audit/service.js';
import {
  buildAirdropRoundTimes,
  buildAttendanceRoundTimes,
  classifyAttendance,
  parseLocalTime,
  validateWeekdays,
  type AttendanceResult,
  type AttendanceRoundTimes,
} from './rules.js';

export type AttendanceRound = typeof attendanceRounds.$inferSelect;
export type AttendanceRecord = typeof attendanceRecords.$inferSelect;
export type AttendanceSchedule = typeof attendanceSchedules.$inferSelect;
export type Leave = typeof leaves.$inferSelect;
export type AttendanceMode = AttendanceRound['mode'];

export interface MemberAttendanceView {
  readonly memberId: string;
  readonly discordUserId: string;
  readonly inGameName: string;
  readonly checkedInAt: Date | null;
  readonly proofChannelId: string | null;
  readonly proofMessageId: string | null;
  readonly result: AttendanceRecord['result'];
}

export interface LeaveView {
  readonly leave: Leave;
  readonly discordUserId: string;
  readonly inGameName: string;
}

export interface AttendanceRoundView {
  readonly round: AttendanceRound;
  readonly present: readonly MemberAttendanceView[];
  readonly leave: readonly MemberAttendanceView[];
  readonly emergencyLeave: readonly MemberAttendanceView[];
  readonly absent: readonly MemberAttendanceView[];
  readonly pending: readonly MemberAttendanceView[];
  readonly activeLeaves: readonly LeaveView[];
}

export interface CreateRoundInput extends AttendanceRoundTimes {
  readonly guildId: string;
  readonly requestId: string;
  readonly title: string;
  readonly mode: AttendanceMode;
  readonly eventAt?: Date;
  readonly actorDiscordUserId: string;
  readonly now: Date;
  readonly sourceScheduleId?: string;
}

interface CreateRecurringScheduleBaseInput {
  readonly guildId: string;
  readonly requestId: string;
  readonly name: string;
  readonly weekdays: readonly number[];
  readonly timezone: string;
  readonly actorDiscordUserId: string;
  readonly now: Date;
}

export type CreateRecurringScheduleInput = CreateRecurringScheduleBaseInput & ({
  readonly mode: 'GENERAL';
  readonly opensAtLocalTime: string;
  readonly closesAtLocalTime: string;
} | {
  readonly mode: 'AIRDROP';
  readonly eventAtLocalTime: string;
  readonly opensBeforeMinutes: number;
  readonly closesAfterMinutes: number;
});

export interface AttendanceProofInput {
  readonly attachmentId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly sha256: string;
}

export interface SubmitLeaveInput {
  readonly guildId: string;
  readonly requestId: string;
  readonly discordUserId: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly reason: string;
  readonly timezone: string;
  readonly now: Date;
}

const REMINDER_BEFORE_MS = 15 * 60 * 1_000;
const MATERIALIZATION_DAYS = 21;

export class AttendanceService {
  public constructor(private readonly db: Database) {}

  /** Creates a manual attendance round and its durable publish/open/reminder/close jobs. */
  public async createRound(input: CreateRoundInput): Promise<AttendanceRound> {
    validateCreateRound(input);
    return this.db.transaction(async (tx) => createRoundWithTransaction(tx, input));
  }

  /** Creates an indefinite recurring schedule and materializes a rolling 21-day window. */
  public async createRecurringSchedule(input: CreateRecurringScheduleInput): Promise<AttendanceSchedule> {
    const name = requireText(input.name, 'ชื่อตารางเช็กชื่อ', 2, 100);
    const weekdays = validateWeekdays(input.weekdays);
    validateScheduleInput(input);

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(attendanceSchedules)
        .where(and(eq(attendanceSchedules.guildId, input.guildId), eq(attendanceSchedules.requestId, input.requestId)))
        .limit(1);
      if (existing !== undefined) {
        return existing;
      }

      const [schedule] = await tx
        .insert(attendanceSchedules)
        .values({
          guildId: input.guildId,
          requestId: input.requestId,
          name,
          mode: input.mode,
          weekdays,
          ...(input.mode === 'GENERAL'
            ? {
                opensAtLocalTime: input.opensAtLocalTime.trim(),
                closesAtLocalTime: input.closesAtLocalTime.trim(),
              }
            : {
                eventAtLocalTime: input.eventAtLocalTime.trim(),
                opensBeforeMinutes: input.opensBeforeMinutes,
                closesAfterMinutes: input.closesAfterMinutes,
              }),
          createdByDiscordUserId: input.actorDiscordUserId,
        })
        .returning();
      if (schedule === undefined) {
        throw new Error('Attendance schedule creation did not return a row');
      }

      await materializeScheduleWithTransaction(tx, schedule, input.timezone, input.now);
      await queueNextScheduleTick(tx, schedule, input.timezone, input.now);
      await writeAttendanceAudit(tx, input.guildId, input.actorDiscordUserId, 'ATTENDANCE_SCHEDULE_CREATED', 'ATTENDANCE_SCHEDULE', schedule.id, null, schedule);
      return schedule;
    });
  }

  public async materializeSchedule(
    guildId: string,
    scheduleId: string,
    timezone: string,
    now: Date,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [schedule] = await tx
        .select()
        .from(attendanceSchedules)
        .where(and(eq(attendanceSchedules.guildId, guildId), eq(attendanceSchedules.id, scheduleId)))
        .limit(1)
        .for('update');
      if (schedule === undefined || !schedule.isActive) {
        return;
      }
      await materializeScheduleWithTransaction(tx, schedule, timezone, now);
      await queueNextScheduleTick(tx, schedule, timezone, now);
    });
  }

  public async listRounds(guildId: string, limit = 25): Promise<AttendanceRound[]> {
    return this.db
      .select()
      .from(attendanceRounds)
      .where(and(eq(attendanceRounds.guildId, guildId), ne(attendanceRounds.status, 'CANCELLED')))
      .orderBy(desc(attendanceRounds.opensAt))
      .limit(limit);
  }

  public async getRound(guildId: string, roundId: string): Promise<AttendanceRound> {
    const [round] = await this.db
      .select()
      .from(attendanceRounds)
      .where(and(eq(attendanceRounds.guildId, guildId), eq(attendanceRounds.id, roundId)))
      .limit(1);
    if (round === undefined) {
      throw new NotFoundError('ไม่พบรอบเช็กชื่อ');
    }
    return round;
  }

  public async openRound(guildId: string, roundId: string, now: Date): Promise<AttendanceRound> {
    return this.db.transaction(async (tx) => {
      const round = await lockRound(tx, guildId, roundId);
      if (round.status === 'CANCELLED' || round.status === 'CLOSED') {
        return round;
      }
      if (now < round.opensAt) {
        throw new ConflictError('ยังไม่ถึงเวลาเปิดเช็กชื่อ');
      }
      await snapshotActiveMembers(tx, guildId, roundId);
      const [updated] = await tx
        .update(attendanceRounds)
        .set({ status: 'OPEN', updatedAt: now })
        .where(eq(attendanceRounds.id, roundId))
        .returning();
      return updated ?? round;
    });
  }

  public async checkIn(guildId: string, roundId: string, discordUserId: string, now: Date): Promise<AttendanceRecord> {
    return this.db.transaction(async (tx) => {
      const round = await lockRound(tx, guildId, roundId);
      validateCheckInWindow(round, now);
      if (round.mode === 'AIRDROP') {
        throw new ValidationError('รอบ Airdrop ต้องแนบรูปตัวละครและรายชื่อในวอ');
      }
      const member = await findActiveMember(tx, guildId, discordUserId);
      const [existing] = await tx
        .select()
        .from(attendanceRecords)
        .where(and(eq(attendanceRecords.roundId, roundId), eq(attendanceRecords.memberId, member.id)))
        .limit(1)
        .for('update');
      if (existing?.checkedInAt !== null && existing?.checkedInAt !== undefined) {
        throw new ConflictError('คุณเช็กชื่อในรอบนี้แล้ว');
      }

      const [record] = await tx
        .insert(attendanceRecords)
        .values({ roundId, memberId: member.id, result: 'PRESENT', checkedInAt: now })
        .onConflictDoUpdate({
          target: [attendanceRecords.roundId, attendanceRecords.memberId],
          set: { result: 'PRESENT', checkedInAt: now, leaveId: null, updatedAt: now },
        })
        .returning();
      if (record === undefined) {
        throw new Error('Attendance check-in did not return a row');
      }
      await writeAttendanceAudit(tx, guildId, discordUserId, 'ATTENDANCE_CHECKED_IN', 'ATTENDANCE_RECORD', `${roundId}:${member.id}`, existing ?? null, record);
      await queueRoundRefresh(tx, guildId, roundId, now);
      return record;
    });
  }

  public async checkInWithProof(
    guildId: string,
    roundId: string,
    discordUserId: string,
    proof: AttendanceProofInput,
    now: Date,
  ): Promise<AttendanceRecord> {
    validateAttendanceProofInput(proof);
    try {
      return await this.db.transaction(async (tx) => {
        const round = await lockRound(tx, guildId, roundId);
        validateCheckInWindow(round, now);
        if (round.mode !== 'AIRDROP') {
          throw new ValidationError('เช็กชื่อทั่วไปไม่ต้องแนบรูปหลักฐาน');
        }
        const member = await findActiveMember(tx, guildId, discordUserId);
        const [existing] = await tx
          .select()
          .from(attendanceRecords)
          .where(and(eq(attendanceRecords.roundId, roundId), eq(attendanceRecords.memberId, member.id)))
          .limit(1)
          .for('update');
        if (existing?.checkedInAt !== null && existing?.checkedInAt !== undefined) {
          throw new ConflictError('คุณเช็กชื่อในรอบนี้แล้ว');
        }
        const [reusedProof] = await tx
          .select({ roundId: attendanceRecords.roundId })
          .from(attendanceRecords)
          .where(eq(attendanceRecords.proofSha256, proof.sha256))
          .limit(1);
        if (reusedProof !== undefined) {
          throw new ConflictError('รูปหลักฐานนี้ถูกใช้เช็กชื่อแล้ว กรุณาแนบรูปใหม่จากรอบปัจจุบัน');
        }

        const [record] = await tx
          .insert(attendanceRecords)
          .values({
            roundId,
            memberId: member.id,
            result: 'PRESENT',
            checkedInAt: now,
            proofAttachmentId: proof.attachmentId,
            proofChannelId: proof.channelId,
            proofMessageId: proof.messageId,
            proofSha256: proof.sha256,
          })
          .onConflictDoUpdate({
            target: [attendanceRecords.roundId, attendanceRecords.memberId],
            set: {
              result: 'PRESENT',
              checkedInAt: now,
              leaveId: null,
              proofAttachmentId: proof.attachmentId,
              proofChannelId: proof.channelId,
              proofMessageId: proof.messageId,
              proofSha256: proof.sha256,
              updatedAt: now,
            },
          })
          .returning();
        if (record === undefined) {
          throw new Error('Attendance proof check-in did not return a row');
        }
        await writeAttendanceAudit(tx, guildId, discordUserId, 'ATTENDANCE_PROOF_CHECKED_IN', 'ATTENDANCE_RECORD', `${roundId}:${member.id}`, existing ?? null, record);
        await queueRoundRefresh(tx, guildId, roundId, now);
        return record;
      });
    } catch (error: unknown) {
      if (isConstraintViolation(error, 'attendance_records_proof_sha256_uq')) {
        throw new ConflictError('รูปหลักฐานนี้ถูกใช้เช็กชื่อแล้ว กรุณาแนบรูปใหม่จากรอบปัจจุบัน');
      }
      throw error;
    }
  }

  public async closeRound(guildId: string, roundId: string, now: Date): Promise<AttendanceRound> {
    return this.db.transaction(async (tx) => {
      const round = await lockRound(tx, guildId, roundId);
      if (round.status === 'CANCELLED' || round.status === 'CLOSED') {
        return round;
      }
      if (now < round.closesAt) {
        throw new ConflictError('ยังไม่ถึงเวลาปิดเช็กชื่อ');
      }
      await snapshotActiveMembers(tx, guildId, roundId);
      const records = await tx.select().from(attendanceRecords).where(eq(attendanceRecords.roundId, roundId));
      const activeLeaves = await findActiveLeavesForRound(tx, guildId, round.attendanceDate);
      const leavesByMember = groupLeavesByMember(activeLeaves);

      for (const record of records) {
        const memberLeaves = leavesByMember.get(record.memberId) ?? [];
        const result = classifyRecord(round, record, memberLeaves);
        await tx
          .update(attendanceRecords)
          .set({ result, leaveId: selectLeaveId(result, record, memberLeaves, round), updatedAt: now })
          .where(and(eq(attendanceRecords.roundId, roundId), eq(attendanceRecords.memberId, record.memberId)));
      }

      const [updated] = await tx
        .update(attendanceRounds)
        .set({ status: 'CLOSED', updatedAt: now })
        .where(eq(attendanceRounds.id, roundId))
        .returning();
      if (updated === undefined) {
        throw new Error('Attendance close did not return a row');
      }
      await writeAttendanceAudit(tx, guildId, 'SYSTEM', 'ATTENDANCE_ROUND_CLOSED', 'ATTENDANCE_ROUND', roundId, round, updated);
      return updated;
    });
  }

  public async submitLeave(input: SubmitLeaveInput): Promise<LeaveView> {
    const reason = requireText(input.reason, 'เหตุผลการลา', 2, 500);
    validateLeaveDates(input.startsOn, input.endsOn);
    const today = DateTime.fromJSDate(input.now, { zone: input.timezone }).toFormat('yyyy-MM-dd');
    if (input.startsOn < today) {
      throw new ValidationError('สมาชิกไม่สามารถส่งใบลาย้อนหลังได้');
    }

    const leave = await this.db.transaction(async (tx) => {
      const member = await findActiveMember(tx, input.guildId, input.discordUserId);
      const [existing] = await tx
        .select()
        .from(leaves)
        .where(and(eq(leaves.guildId, input.guildId), eq(leaves.requestId, input.requestId)))
        .limit(1);
      if (existing !== undefined) {
        return existing;
      }
      const [created] = await tx
        .insert(leaves)
        .values({
          guildId: input.guildId,
          requestId: input.requestId,
          memberId: member.id,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          reason,
          submittedAt: input.now,
        })
        .returning();
      if (created === undefined) {
        throw new Error('Leave submission did not return a row');
      }
      await writeAttendanceAudit(tx, input.guildId, input.discordUserId, 'LEAVE_SUBMITTED', 'LEAVE', created.id, null, created);
      await queueLeavePublish(tx, input.guildId, created.id, input.now);
      const affectedRounds = await findRoundsInDateRange(tx, input.guildId, input.startsOn, input.endsOn);
      for (const round of affectedRounds) {
        if (round.status === 'CLOSED') {
          await recalculateClosedRecordForNewLeave(tx, round, member.id, input.now);
        }
        await queueRoundRefresh(tx, input.guildId, round.id, input.now);
      }
      return created;
    });
    return this.getLeave(input.guildId, leave.id);
  }

  public async editLeave(
    guildId: string,
    leaveId: string,
    actorDiscordUserId: string,
    isAdmin: boolean,
    startsOn: string,
    endsOn: string,
    reason: string,
    timezone: string,
    now: Date,
  ): Promise<LeaveView> {
    const normalizedReason = requireText(reason, 'เหตุผลการลา', 2, 500);
    validateLeaveDates(startsOn, endsOn);
    const today = DateTime.fromJSDate(now, { zone: timezone }).toFormat('yyyy-MM-dd');
    if (!isAdmin && startsOn < today) {
      throw new ValidationError('สมาชิกไม่สามารถแก้ใบลาให้เริ่มย้อนหลังได้');
    }

    await this.db.transaction(async (tx) => {
      const context = await lockLeaveContext(tx, guildId, leaveId);
      requireLeaveOwnerOrAdmin(context.discordUserId, actorDiscordUserId, isAdmin);
      if (context.leave.status !== 'ACTIVE') {
        throw new ConflictError('ใบลานี้ถูกยกเลิกแล้ว');
      }
      if (!isAdmin && context.leave.endsOn < today) {
        throw new ConflictError('ใบลาที่ผ่านไปแล้วแก้ไขได้เฉพาะหัวแก๊ง/รองแก๊ง');
      }
      const [updated] = await tx
        .update(leaves)
        .set({ startsOn, endsOn, reason: normalizedReason, updatedAt: now })
        .where(eq(leaves.id, leaveId))
        .returning();
      await writeAttendanceAudit(tx, guildId, actorDiscordUserId, 'LEAVE_EDITED', 'LEAVE', leaveId, context.leave, updated ?? null);
      const affected = await findRoundsInDateRange(
        tx,
        guildId,
        minDate(context.leave.startsOn, startsOn),
        maxDate(context.leave.endsOn, endsOn),
      );
      for (const round of affected) {
        if (round.status !== 'CLOSED') {
          await queueRoundRefresh(tx, guildId, round.id, now);
        }
      }
    });
    return this.getLeave(guildId, leaveId);
  }

  public async cancelLeave(
    guildId: string,
    leaveId: string,
    actorDiscordUserId: string,
    isAdmin: boolean,
    timezone: string,
    now: Date,
  ): Promise<LeaveView> {
    await this.db.transaction(async (tx) => {
      const context = await lockLeaveContext(tx, guildId, leaveId);
      requireLeaveOwnerOrAdmin(context.discordUserId, actorDiscordUserId, isAdmin);
      if (context.leave.status === 'CANCELLED') {
        return;
      }
      const today = DateTime.fromJSDate(now, { zone: timezone }).toFormat('yyyy-MM-dd');
      if (!isAdmin && context.leave.endsOn < today) {
        throw new ConflictError('ใบลาที่ผ่านไปแล้วยกเลิกได้เฉพาะหัวแก๊ง/รองแก๊ง');
      }
      const [updated] = await tx
        .update(leaves)
        .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
        .where(eq(leaves.id, leaveId))
        .returning();
      await writeAttendanceAudit(tx, guildId, actorDiscordUserId, 'LEAVE_CANCELLED', 'LEAVE', leaveId, context.leave, updated ?? null);
      const affected = await findRoundsInDateRange(tx, guildId, context.leave.startsOn, context.leave.endsOn);
      for (const round of affected) {
        if (round.status !== 'CLOSED') {
          await queueRoundRefresh(tx, guildId, round.id, now);
        }
      }
    });
    return this.getLeave(guildId, leaveId);
  }

  public async getLeave(guildId: string, leaveId: string): Promise<LeaveView> {
    const [row] = await this.db
      .select({ leave: leaves, discordUserId: members.discordUserId, inGameName: members.inGameName })
      .from(leaves)
      .innerJoin(members, eq(leaves.memberId, members.id))
      .where(and(eq(leaves.guildId, guildId), eq(leaves.id, leaveId)))
      .limit(1);
    if (row === undefined) {
      throw new NotFoundError('ไม่พบใบลา');
    }
    return row;
  }

  public async getRoundView(guildId: string, roundId: string): Promise<AttendanceRoundView> {
    const round = await this.getRound(guildId, roundId);
    const rows = await this.db
      .select({
        memberId: members.id,
        discordUserId: members.discordUserId,
        inGameName: members.inGameName,
        checkedInAt: attendanceRecords.checkedInAt,
        proofChannelId: attendanceRecords.proofChannelId,
        proofMessageId: attendanceRecords.proofMessageId,
        result: attendanceRecords.result,
      })
      .from(attendanceRecords)
      .innerJoin(members, eq(attendanceRecords.memberId, members.id))
      .where(eq(attendanceRecords.roundId, roundId))
      .orderBy(asc(members.inGameName));
    const leaveRows = round.status === 'CLOSED'
      ? []
      : await this.db
          .select({ leave: leaves, discordUserId: members.discordUserId, inGameName: members.inGameName })
          .from(leaves)
          .innerJoin(members, eq(leaves.memberId, members.id))
          .where(and(
            eq(leaves.guildId, guildId),
            eq(leaves.status, 'ACTIVE'),
            lte(leaves.startsOn, round.attendanceDate),
            gte(leaves.endsOn, round.attendanceDate),
          ))
          .orderBy(asc(members.inGameName));

    const activeLeaveMemberIds = new Set(leaveRows.map((row) => row.leave.memberId));
    return {
      round,
      present: rows.filter((row) => row.result === 'PRESENT'),
      leave: rows.filter((row) => row.result === 'LEAVE'),
      emergencyLeave: rows.filter((row) => row.result === 'EMERGENCY_LEAVE'),
      absent: rows.filter((row) => row.result === 'ABSENT'),
      pending: rows.filter((row) => row.result === 'PENDING' && !activeLeaveMemberIds.has(row.memberId)),
      activeLeaves: leaveRows,
    };
  }

  public async getReminderRecipients(guildId: string, roundId: string): Promise<string[]> {
    const view = await this.getRoundView(guildId, roundId);
    if (view.round.status === 'CLOSED' || view.round.status === 'CANCELLED') {
      return [];
    }
    const leaveMemberIds = new Set(view.activeLeaves
      .filter((leave) => leave.leave.submittedAt <= view.round.closesAt)
      .map((leave) => leave.leave.memberId));
    return [...view.pending, ...view.absent]
      .filter((member) => member.checkedInAt === null && !leaveMemberIds.has(member.memberId))
      .map((member) => member.discordUserId);
  }

  public async correctAttendance(
    guildId: string,
    roundId: string,
    memberDiscordUserId: string,
    result: AttendanceResult,
    reason: string,
    actorDiscordUserId: string,
    now: Date,
  ): Promise<AttendanceRecord> {
    const normalizedReason = requireText(reason, 'เหตุผลการแก้ไข', 2, 500);
    return this.db.transaction(async (tx) => {
      const round = await lockRound(tx, guildId, roundId);
      if (round.status !== 'CLOSED' && now < round.closesAt) {
        throw new ConflictError('แก้ผลย้อนหลังได้เมื่อรอบเช็กชื่อปิดแล้วเท่านั้น');
      }
      const [member] = await tx
        .select()
        .from(members)
        .where(and(eq(members.guildId, guildId), eq(members.discordUserId, memberDiscordUserId)))
        .limit(1);
      if (member === undefined) {
        throw new NotFoundError('ไม่พบสมาชิกในทะเบียน');
      }
      const [before] = await tx
        .select()
        .from(attendanceRecords)
        .where(and(eq(attendanceRecords.roundId, roundId), eq(attendanceRecords.memberId, member.id)))
        .limit(1)
        .for('update');
      const checkedInAt = result === 'PRESENT' || result === 'EMERGENCY_LEAVE'
        ? before?.checkedInAt ?? round.closesAt
        : null;
      const [record] = await tx
        .insert(attendanceRecords)
        .values({
          roundId,
          memberId: member.id,
          result,
          checkedInAt,
          correctedByDiscordUserId: actorDiscordUserId,
          correctionReason: normalizedReason,
        })
        .onConflictDoUpdate({
          target: [attendanceRecords.roundId, attendanceRecords.memberId],
          set: {
            result,
            checkedInAt,
            correctedByDiscordUserId: actorDiscordUserId,
            correctionReason: normalizedReason,
            updatedAt: now,
          },
        })
        .returning();
      if (record === undefined) {
        throw new Error('Attendance correction did not return a row');
      }
      await writeAttendanceAudit(tx, guildId, actorDiscordUserId, 'ATTENDANCE_CORRECTED', 'ATTENDANCE_RECORD', `${roundId}:${member.id}`, before ?? null, record, normalizedReason);
      await queueRoundRefresh(tx, guildId, roundId, now);
      return record;
    });
  }

  public async markRoundPublished(guildId: string, roundId: string, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(attendanceRounds)
      .set({ announcementChannelId: channelId, announcementMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(attendanceRounds.guildId, guildId), eq(attendanceRounds.id, roundId)));
  }

  public async markLeavePublished(guildId: string, leaveId: string, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(leaves)
      .set({ publicChannelId: channelId, publicMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(leaves.guildId, guildId), eq(leaves.id, leaveId)));
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function createRoundWithTransaction(tx: Transaction, input: CreateRoundInput): Promise<AttendanceRound> {
  const [existing] = await tx
    .select()
    .from(attendanceRounds)
    .where(and(eq(attendanceRounds.guildId, input.guildId), eq(attendanceRounds.requestId, input.requestId)))
    .limit(1);
  if (existing !== undefined) {
    return existing;
  }
  const status = input.opensAt <= input.now ? 'OPEN' : 'SCHEDULED';
  const [round] = await tx
    .insert(attendanceRounds)
    .values({
      guildId: input.guildId,
      requestId: input.requestId,
      title: requireText(input.title, 'ชื่อรอบเช็กชื่อ', 2, 100),
      mode: input.mode,
      attendanceDate: input.attendanceDate,
      ...(input.eventAt === undefined ? {} : { eventAt: input.eventAt }),
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      emergencyLeaveCutoff: input.emergencyLeaveCutoff,
      status,
      createdByDiscordUserId: input.actorDiscordUserId,
      ...(input.sourceScheduleId === undefined ? {} : { sourceScheduleId: input.sourceScheduleId }),
    })
    .returning();
  if (round === undefined) {
    throw new Error('Attendance round creation did not return a row');
  }
  if (status === 'OPEN') {
    await snapshotActiveMembers(tx, input.guildId, round.id);
  }
  await queueRoundLifecycleJobs(tx, round, input.now);
  await writeAttendanceAudit(tx, input.guildId, input.actorDiscordUserId, 'ATTENDANCE_ROUND_CREATED', 'ATTENDANCE_ROUND', round.id, null, round);
  return round;
}

async function materializeScheduleWithTransaction(
  tx: Transaction,
  schedule: AttendanceSchedule,
  timezone: string,
  now: Date,
): Promise<void> {
  const weekdays = validateWeekdays(schedule.weekdays);
  const start = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  for (let offset = 0; offset < MATERIALIZATION_DAYS; offset += 1) {
    const date = start.plus({ days: offset });
    if (!weekdays.includes(date.weekday)) {
      continue;
    }
    const attendanceDate = date.toFormat('yyyy-MM-dd');
    const { times, eventAt } = buildScheduleRoundTimes(schedule, attendanceDate, timezone);
    if (times.closesAt <= now) {
      continue;
    }
    await createRoundWithTransaction(tx, {
      guildId: schedule.guildId,
      requestId: `schedule:${schedule.id}:${attendanceDate}`,
      title: `${schedule.name} · ${attendanceDate}`,
      mode: schedule.mode,
      ...(eventAt === null ? {} : { eventAt }),
      ...times,
      actorDiscordUserId: schedule.createdByDiscordUserId,
      now,
      sourceScheduleId: schedule.id,
    });
  }
}

function buildScheduleRoundTimes(
  schedule: AttendanceSchedule,
  attendanceDate: string,
  timezone: string,
): { times: AttendanceRoundTimes; eventAt: Date | null } {
  if (schedule.mode === 'GENERAL') {
    if (schedule.opensAtLocalTime === null || schedule.closesAtLocalTime === null) {
      throw new Error(`GENERAL attendance schedule ${schedule.id} has incomplete time configuration`);
    }
    return {
      times: buildAttendanceRoundTimes(
        attendanceDate,
        schedule.opensAtLocalTime,
        schedule.closesAtLocalTime,
        timezone,
      ),
      eventAt: null,
    };
  }
  if (
    schedule.eventAtLocalTime === null
    || schedule.opensBeforeMinutes === null
    || schedule.closesAfterMinutes === null
  ) {
    throw new Error(`AIRDROP attendance schedule ${schedule.id} has incomplete time configuration`);
  }
  const eventTime = parseLocalTime(schedule.eventAtLocalTime, 'เวลา Airdrop');
  const event = DateTime.fromISO(attendanceDate, { zone: timezone }).set(eventTime);
  if (!event.isValid) {
    throw new ValidationError('วันเวลา Airdrop หรือ Timezone ไม่ถูกต้อง');
  }
  return {
    times: buildAirdropRoundTimes(
      event.toJSDate(),
      timezone,
      schedule.opensBeforeMinutes,
      schedule.closesAfterMinutes,
    ),
    eventAt: event.toJSDate(),
  };
}

async function queueRoundLifecycleJobs(tx: Transaction, round: AttendanceRound, now: Date): Promise<void> {
  const jobs: Array<{ type: string; key: string; runAt: Date }> = [
    { type: 'ATTENDANCE_PUBLISH', key: 'publish', runAt: now },
    { type: 'ATTENDANCE_OPEN', key: 'open', runAt: round.opensAt },
    { type: 'ATTENDANCE_CLOSE', key: 'close', runAt: round.closesAt },
  ];
  const reminderAt = new Date(round.closesAt.getTime() - REMINDER_BEFORE_MS);
  if (reminderAt >= now) {
    jobs.push({ type: 'ATTENDANCE_REMINDER', key: 'reminder', runAt: reminderAt });
  }
  await tx.insert(scheduledJobs).values(jobs.map((job) => ({
    guildId: round.guildId,
    jobType: job.type,
    deduplicationKey: `attendance:${round.id}:${job.key}`,
    payload: { roundId: round.id },
    runAt: job.runAt,
  })));
}

async function queueNextScheduleTick(
  tx: Transaction,
  schedule: AttendanceSchedule,
  timezone: string,
  now: Date,
): Promise<void> {
  const nextTick = DateTime.fromJSDate(now, { zone: timezone }).plus({ days: 1 }).startOf('day').plus({ minutes: 5 });
  const tickDate = nextTick.toFormat('yyyy-MM-dd');
  await tx
    .insert(scheduledJobs)
    .values({
      guildId: schedule.guildId,
      jobType: 'ATTENDANCE_SCHEDULE_TICK',
      deduplicationKey: `attendance-schedule:${schedule.id}:tick:${tickDate}`,
      payload: { scheduleId: schedule.id },
      runAt: nextTick.toJSDate(),
    })
    .onConflictDoNothing();
}

async function snapshotActiveMembers(tx: Transaction, guildId: string, roundId: string): Promise<void> {
  const activeMembers = await tx
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.guildId, guildId), eq(members.status, 'ACTIVE')));
  if (activeMembers.length === 0) {
    return;
  }
  await tx
    .insert(attendanceRecords)
    .values(activeMembers.map((member) => ({ roundId, memberId: member.id, result: 'PENDING' as const })))
    .onConflictDoNothing();
}

async function findActiveMember(tx: Transaction, guildId: string, discordUserId: string) {
  const [member] = await tx
    .select()
    .from(members)
    .where(and(eq(members.guildId, guildId), eq(members.discordUserId, discordUserId), eq(members.status, 'ACTIVE')))
    .limit(1);
  if (member === undefined) {
    throw new AuthorizationError('ต้องเป็นสมาชิกที่มีสถานะใช้งาน');
  }
  return member;
}

async function lockRound(tx: Transaction, guildId: string, roundId: string): Promise<AttendanceRound> {
  const [round] = await tx
    .select()
    .from(attendanceRounds)
    .where(and(eq(attendanceRounds.guildId, guildId), eq(attendanceRounds.id, roundId)))
    .limit(1)
    .for('update');
  if (round === undefined) {
    throw new NotFoundError('ไม่พบรอบเช็กชื่อ');
  }
  return round;
}

async function findActiveLeavesForRound(tx: Transaction, guildId: string, attendanceDate: string): Promise<Leave[]> {
  return tx
    .select()
    .from(leaves)
    .where(and(
      eq(leaves.guildId, guildId),
      eq(leaves.status, 'ACTIVE'),
      lte(leaves.startsOn, attendanceDate),
      gte(leaves.endsOn, attendanceDate),
    ));
}

async function findRoundsInDateRange(
  tx: Transaction,
  guildId: string,
  startsOn: string,
  endsOn: string,
): Promise<AttendanceRound[]> {
  return tx
    .select()
    .from(attendanceRounds)
    .where(and(
      eq(attendanceRounds.guildId, guildId),
      ne(attendanceRounds.status, 'CANCELLED'),
      gte(attendanceRounds.attendanceDate, startsOn),
      lte(attendanceRounds.attendanceDate, endsOn),
    ));
}

async function recalculateClosedRecordForNewLeave(
  tx: Transaction,
  round: AttendanceRound,
  memberId: string,
  now: Date,
): Promise<void> {
  const [record] = await tx
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.roundId, round.id), eq(attendanceRecords.memberId, memberId)))
    .limit(1)
    .for('update');
  if (record === undefined) {
    return;
  }
  const memberLeaves = await tx
    .select()
    .from(leaves)
    .where(and(
      eq(leaves.guildId, round.guildId),
      eq(leaves.memberId, memberId),
      eq(leaves.status, 'ACTIVE'),
      lte(leaves.startsOn, round.attendanceDate),
      gte(leaves.endsOn, round.attendanceDate),
    ));
  const result = classifyRecord(round, record, memberLeaves);
  await tx
    .update(attendanceRecords)
    .set({ result, leaveId: selectLeaveId(result, record, memberLeaves, round), updatedAt: now })
    .where(and(eq(attendanceRecords.roundId, round.id), eq(attendanceRecords.memberId, memberId)));
}

async function lockLeaveContext(tx: Transaction, guildId: string, leaveId: string) {
  const [context] = await tx
    .select({ leave: leaves, discordUserId: members.discordUserId })
    .from(leaves)
    .innerJoin(members, eq(leaves.memberId, members.id))
    .where(and(eq(leaves.guildId, guildId), eq(leaves.id, leaveId)))
    .limit(1)
    .for('update');
  if (context === undefined) {
    throw new NotFoundError('ไม่พบใบลา');
  }
  return context;
}

function classifyRecord(round: AttendanceRound, record: AttendanceRecord, memberLeaves: readonly Leave[]): AttendanceResult {
  return classifyAttendance({
    opensAt: round.opensAt,
    closesAt: round.closesAt,
    emergencyLeaveCutoff: round.emergencyLeaveCutoff,
    checkedInAt: record.checkedInAt,
    leaves: memberLeaves.map((leave) => ({ submittedAt: leave.submittedAt, coversAttendanceDate: true })),
  });
}

function selectLeaveId(
  result: AttendanceResult,
  record: AttendanceRecord,
  memberLeaves: readonly Leave[],
  round: AttendanceRound,
): string | null {
  if (result === 'LEAVE') {
    return memberLeaves
      .filter((leave) => leave.submittedAt <= round.closesAt)
      .sort((left, right) => left.submittedAt.getTime() - right.submittedAt.getTime())[0]?.id ?? null;
  }
  if (result === 'EMERGENCY_LEAVE' && record.checkedInAt !== null) {
    const checkedInAt = record.checkedInAt;
    return memberLeaves
      .filter((leave) => leave.submittedAt > checkedInAt && leave.submittedAt <= round.emergencyLeaveCutoff)
      .sort((left, right) => left.submittedAt.getTime() - right.submittedAt.getTime())[0]?.id ?? null;
  }
  return null;
}

function groupLeavesByMember(values: readonly Leave[]): Map<string, Leave[]> {
  const grouped = new Map<string, Leave[]>();
  for (const leave of values) {
    const memberLeaves = grouped.get(leave.memberId) ?? [];
    memberLeaves.push(leave);
    grouped.set(leave.memberId, memberLeaves);
  }
  return grouped;
}

function validateCreateRound(input: CreateRoundInput): void {
  if (input.closesAt <= input.opensAt) {
    throw new ValidationError('เวลาปิดต้องอยู่หลังเวลาเปิด');
  }
  if (input.emergencyLeaveCutoff < input.closesAt) {
    throw new ValidationError('เวลาปิดรับลาเหตุฉุกเฉินต้องไม่อยู่ก่อนเวลาปิดเช็กชื่อ');
  }
  if (input.closesAt <= input.now) {
    throw new ValidationError('เวลาปิดเช็กชื่อต้องอยู่ในอนาคต');
  }
  if (input.mode === 'AIRDROP') {
    if (input.eventAt === undefined || input.eventAt < input.opensAt || input.eventAt > input.closesAt) {
      throw new ValidationError('เวลา Airdrop ต้องอยู่ในช่วงเปิดเช็กชื่อ');
    }
  } else if (input.eventAt !== undefined) {
    throw new ValidationError('เช็กชื่อทั่วไปไม่ต้องระบุเวลา Airdrop');
  }
}

function validateScheduleInput(input: CreateRecurringScheduleInput): void {
  if (input.mode === 'GENERAL') {
    parseLocalTime(input.opensAtLocalTime, 'เวลาเปิด');
    parseLocalTime(input.closesAtLocalTime, 'เวลาปิด');
    buildAttendanceRoundTimes('2026-01-01', input.opensAtLocalTime, input.closesAtLocalTime, input.timezone);
    return;
  }
  const eventTime = parseLocalTime(input.eventAtLocalTime, 'เวลา Airdrop');
  const event = DateTime.fromObject({ year: 2026, month: 1, day: 1, ...eventTime }, { zone: input.timezone });
  buildAirdropRoundTimes(event.toJSDate(), input.timezone, input.opensBeforeMinutes, input.closesAfterMinutes);
}

function validateCheckInWindow(round: AttendanceRound, now: Date): void {
  if (round.status === 'CANCELLED' || round.status === 'CLOSED' || now < round.opensAt || now > round.closesAt) {
    throw new ConflictError('รอบเช็กชื่อยังไม่เปิดหรือปิดแล้ว');
  }
}

function validateAttendanceProofInput(proof: AttendanceProofInput): void {
  requireText(proof.attachmentId, 'รหัสไฟล์หลักฐาน', 1, 100);
  requireText(proof.channelId, 'รหัส Channel หลักฐาน', 1, 100);
  requireText(proof.messageId, 'รหัสข้อความหลักฐาน', 1, 100);
  if (!/^[0-9a-f]{64}$/u.test(proof.sha256)) {
    throw new ValidationError('ลายนิ้วมือรูปหลักฐานไม่ถูกต้อง');
  }
}

function isConstraintViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const databaseError = error as { readonly code?: unknown; readonly constraint?: unknown };
  return databaseError.code === '23505' && databaseError.constraint === constraint;
}

function validateLeaveDates(startsOn: string, endsOn: string): void {
  const isoPattern = /^\d{4}-\d{2}-\d{2}$/u;
  const start = DateTime.fromISO(startsOn, { zone: 'utc' });
  const end = DateTime.fromISO(endsOn, { zone: 'utc' });
  if (!isoPattern.test(startsOn) || !isoPattern.test(endsOn)
    || !start.isValid || !end.isValid || endsOn < startsOn) {
    throw new ValidationError('ช่วงวันที่ลาไม่ถูกต้อง');
  }
}

function requireText(value: string, label: string, minimum: number, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ValidationError(`${label}ต้องมี ${String(minimum)}–${String(maximum)} ตัวอักษร`);
  }
  return normalized;
}

function requireLeaveOwnerOrAdmin(ownerDiscordUserId: string, actorDiscordUserId: string, isAdmin: boolean): void {
  if (!isAdmin && ownerDiscordUserId !== actorDiscordUserId) {
    throw new AuthorizationError('แก้ไขใบลาได้เฉพาะเจ้าของใบลาหรือหัวแก๊ง/รองแก๊ง');
  }
}

async function queueRoundRefresh(tx: Transaction, guildId: string, roundId: string, runAt: Date): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'ATTENDANCE_REFRESH',
    deduplicationKey: `attendance:${roundId}:refresh:${randomUUID()}`,
    payload: { roundId },
    runAt,
  });
}

async function queueLeavePublish(tx: Transaction, guildId: string, leaveId: string, runAt: Date): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'LEAVE_PUBLISH',
    deduplicationKey: `leave:${leaveId}:publish`,
    payload: { leaveId },
    runAt,
  });
}

async function writeAttendanceAudit(
  tx: Transaction,
  guildId: string,
  actorDiscordUserId: string,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason?: string,
): Promise<void> {
  await writeAudit(tx, {
    guildId,
    actorDiscordUserId,
    action,
    entityType,
    entityId,
    before,
    after,
    ...(reason === undefined ? {} : { reason }),
  });
}

function minDate(left: string, right: string): string {
  return left <= right ? left : right;
}

function maxDate(left: string, right: string): string {
  return left >= right ? left : right;
}
