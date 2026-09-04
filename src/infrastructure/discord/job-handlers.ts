import { z } from 'zod';
import type pino from 'pino';
import { type Client, type SendableChannels } from 'discord.js';
import { ValidationError } from '../../domain/errors.js';
import type { ActivityService } from '../../modules/activities/service.js';
import type { AttendanceService } from '../../modules/attendance/service.js';
import type { FineService } from '../../modules/fines/service.js';
import type { TreasuryService } from '../../modules/treasury/service.js';
import type { TreasuryWithdrawalService } from '../../modules/treasury-withdrawals/service.js';
import type { WeeklyDuesService } from '../../modules/weekly-dues/service.js';
import type { InventoryService } from '../../modules/inventory/service.js';
import type { WithdrawalService } from '../../modules/withdrawals/service.js';
import type { GuildConfigService } from '../../modules/guild-config/service.js';
import type { MemberService } from '../../modules/members/service.js';
import type { AuditService } from '../../modules/audit/service.js';
import type { FightPositionService } from '../../modules/fight-positions/service.js';
import type { JobHandler } from '../../modules/scheduler/service.js';
import {
  buildActivityAnnouncement,
  buildAnnouncementSummaryEmbed,
  buildLeaderboardEmbeds,
  buildParticipationSummaryEmbeds,
} from './activity-components.js';
import { buildAttendanceAnnouncement, buildLeaveLog } from './attendance-components.js';
import { buildFineAnnouncement } from './fine-components.js';
import {
  buildTreasuryDashboard,
  buildTreasuryEntryLog,
  buildTreasuryWithdrawalRequestLog,
} from './treasury-components.js';
import { buildWeeklyAnnouncement } from './weekly-dues-components.js';
import { buildBatchLog, buildStockDashboard, buildWithdrawalLog } from './stock-components.js';
import { buildControlPanel, buildMemberRegistrationRequest, buildMemberRoster } from './components.js';
import { buildAuditLogMessage } from './audit-components.js';
import { syncFightPositionSummary } from './fight-position-publisher.js';
import { buildMiruEmbed } from './theme.js';
import type { DailyLogPublisher } from './daily-log-publisher.js';

const memberRoleSyncSchema = z.object({
  discordUserId: z.string().regex(/^\d+$/),
  addRoleId: z.string().regex(/^\d+$/),
  removeRoleId: z.string().regex(/^\d+$/),
});

const memberAdminRoleSyncSchema = z.object({
  discordUserId: z.string().regex(/^\d+$/),
  headRoleId: z.string().regex(/^\d+$/),
  deputyRoleId: z.string().regex(/^\d+$/),
  desiredRole: z.enum(['HEAD', 'DEPUTY']).nullable(),
});

const memberRegistrationRequestJobSchema = z.object({ memberId: z.string().uuid() });

const activityJobSchema = z.object({
  activityId: z.string().uuid(),
});

const attendanceJobSchema = z.object({ roundId: z.string().uuid() });
const attendanceScheduleJobSchema = z.object({ scheduleId: z.string().uuid() });
const leaveJobSchema = z.object({ leaveId: z.string().uuid() });
const fineJobSchema = z.object({ fineId: z.string().uuid() });
const treasuryJobSchema = z.object({ entryId: z.string().uuid() });
const treasuryWithdrawalJobSchema = z.object({ requestId: z.string().uuid() });
const weeklyJobSchema = z.object({ collectionId: z.string().uuid() });
const stockBatchJobSchema = z.object({ batchId: z.string().uuid() });
const withdrawalJobSchema = z.object({ requestId: z.string().uuid() });
const auditJobSchema = z.object({ auditId: z.string().uuid() });

export function createDiscordJobHandlers(
  client: Client,
  members: MemberService,
  activities: ActivityService,
  attendance: AttendanceService,
  fines: FineService,
  treasury: TreasuryService,
  treasuryWithdrawals: TreasuryWithdrawalService,
  weeklyDues: WeeklyDuesService,
  inventory: InventoryService,
  withdrawals: WithdrawalService,
  audits: AuditService,
  fightPositions: FightPositionService,
  guildConfig: GuildConfigService,
  dailyLogs: DailyLogPublisher,
  logger: pino.Logger,
): ReadonlyMap<string, JobHandler> {
  return new Map<string, JobHandler>([
    [
      'AUDIT_PUBLISH',
      async (job) => {
        const { auditId } = auditJobSchema.parse(job.payload);
        const audit = await audits.findById(job.guildId, auditId);
        if (audit === null) return;

        if (audit.publicChannelId !== null && audit.publicMessageId !== null) {
          const existingChannel = await fetchSendableChannel(client, audit.publicChannelId, 'Channel Audit');
          const existingMessage = await existingChannel.messages.fetch(audit.publicMessageId).catch(() => null);
          if (existingMessage !== null) {
            await existingMessage.edit(buildAuditLogMessage(audit));
            await moveControlPanelToChannelBottom(client, guildConfig, job.guildId, logger);
            return;
          }
        }

        const settings = await guildConfig.get(job.guildId);
        if (settings === null) throw new ValidationError('ไม่พบการตั้งค่า Server');
        const channel = await fetchSendableChannel(client, settings.auditChannelId, 'Channel Audit');
        const message = await dailyLogs.send(channel, {
          guildId: job.guildId,
          timezone: settings.timezone,
          message: {
            ...buildAuditLogMessage(audit),
            nonce: nonceFor(audit.id, 'audit'),
            enforceNonce: true,
          },
        });
        await audits.markPublished(job.guildId, audit.id, channel.id, message.id);
        await moveControlPanelToChannelBottom(client, guildConfig, job.guildId, logger);
      },
    ],
    [
      'MEMBER_ROLE_SYNC',
      async (job) => {
        const payload = memberRoleSyncSchema.parse(job.payload);
        const guild = await client.guilds.fetch(job.guildId);
        const member = await guild.members.fetch(payload.discordUserId);

        if (member.roles.cache.has(payload.removeRoleId)) {
          await member.roles.remove(payload.removeRoleId, 'MiruBot member status synchronization');
        }
        if (!member.roles.cache.has(payload.addRoleId)) {
          await member.roles.add(payload.addRoleId, 'MiruBot member status synchronization');
        }
      },
    ],
    [
      'MEMBER_ADMIN_ROLE_SYNC',
      async (job) => {
        const payload = memberAdminRoleSyncSchema.parse(job.payload);
        const guild = await client.guilds.fetch(job.guildId);
        const member = await guild.members.fetch(payload.discordUserId);
        let desiredRoleId: string | null = null;
        if (payload.desiredRole === 'HEAD') desiredRoleId = payload.headRoleId;
        if (payload.desiredRole === 'DEPUTY') desiredRoleId = payload.deputyRoleId;
        if (payload.desiredRole === 'HEAD') {
          const guildMembers = await guild.members.fetch();
          for (const otherMember of guildMembers.values()) {
            if (otherMember.id !== member.id && otherMember.roles.cache.has(payload.headRoleId)) {
              await otherMember.roles.remove(payload.headRoleId, 'MiruBot head role singleton synchronization');
            }
          }
        }
        const managedRoleIds = [payload.headRoleId, payload.deputyRoleId];
        for (const roleId of managedRoleIds) {
          if (roleId !== desiredRoleId && member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId, 'MiruBot roster title synchronization');
          }
        }
        if (desiredRoleId !== null && !member.roles.cache.has(desiredRoleId)) {
          await member.roles.add(desiredRoleId, 'MiruBot roster title synchronization');
        }
      },
    ],
    [
      'MEMBER_ROSTER_REFRESH',
      async (job) => {
        await refreshMemberRoster(client, members, guildConfig, job.guildId);
      },
    ],
    [
      'MEMBER_REGISTRATION_REQUEST_SYNC',
      async (job) => {
        const { memberId } = memberRegistrationRequestJobSchema.parse(job.payload);
        const member = await members.findById(job.guildId, memberId);
        if (member === null) return;

        if (member.registrationRequestChannelId !== null && member.registrationRequestMessageId !== null) {
          const existingChannel = await fetchSendableChannel(
            client,
            member.registrationRequestChannelId,
            'Channel คำขอลงทะเบียน',
          );
          const existingMessage = await existingChannel.messages.fetch(member.registrationRequestMessageId).catch(() => null);
          if (existingMessage !== null) {
            await existingMessage.edit(buildMemberRegistrationRequest(member));
            return;
          }
        }

        if (member.status !== 'PENDING') return;
        const settings = await guildConfig.get(job.guildId);
        const channel = await fetchSendableChannel(
          client,
          settings?.registrationRequestChannelId ?? null,
          'Channel คำขอลงทะเบียน',
        );
        const message = await channel.send({
          ...buildMemberRegistrationRequest(member),
          nonce: nonceFor(member.id, 'member-register'),
          enforceNonce: true,
        });
        await members.markRegistrationRequestPublished(job.guildId, member.id, channel.id, message.id);
      },
    ],
    [
      'ACTIVITY_PUBLISH',
      async (job) => {
        const { activityId } = activityJobSchema.parse(job.payload);
        const activity = await activities.getWithScores(job.guildId, activityId, true);
        if (activity.activity.announcementMessageId !== null) {
          return;
        }
        const settings = await guildConfig.get(job.guildId);
        const channel = await fetchSendableChannel(client, settings?.activityChannelId ?? null, 'Channel กิจกรรม');
        const message = await channel.send({
          ...buildActivityAnnouncement(activity, activity.activity.status === 'CLOSED'),
          nonce: nonceFor(activityId, 'publish'),
          enforceNonce: true,
        });
        await activities.markPublished(job.guildId, activityId, channel.id, message.id);
      },
    ],
    [
      'ACTIVITY_OPEN',
      async (job) => {
        const { activityId } = activityJobSchema.parse(job.payload);
        await activities.open(job.guildId, activityId, new Date());
        await refreshAnnouncement(client, activities, job.guildId, activityId);
      },
    ],
    [
      'ACTIVITY_REMINDER',
      async (job) => {
        const { activityId } = activityJobSchema.parse(job.payload);
        const { activity } = await activities.getWithScores(job.guildId, activityId, true);
        if (activity.status === 'CANCELLED' || activity.status === 'CLOSED') {
          return;
        }
        const settings = await guildConfig.get(job.guildId);
        const channel = await fetchSendableChannel(client, settings?.activityChannelId ?? null, 'Channel กิจกรรม');
        await channel.send({
          embeds: [buildMiruEmbed({
            tone: 'warning',
            icon: '⏰',
            title: 'กิจกรรมใกล้ปิดรับผลงาน',
            description: `🏆 **${activity.title}**\nปิดรับผลงาน ${discordTimestamp(activity.endsAt, 'R')}\n<t:${String(Math.floor(activity.endsAt.getTime() / 1_000))}:F>`,
            module: 'Activities',
          })],
          nonce: nonceFor(activityId, 'remind'),
          enforceNonce: true,
        });
      },
    ],
    [
      'ACTIVITY_CLOSE',
      async (job) => {
        const { activityId } = activityJobSchema.parse(job.payload);
        const activity = await activities.close(job.guildId, activityId, new Date());
        let resultEmbeds = [buildAnnouncementSummaryEmbed(activity)];
        if (activity.mode === 'SCORE') {
          resultEmbeds = buildLeaderboardEmbeds(activity, await activities.buildLeaderboard(job.guildId, activityId), true);
        } else if (activity.mode === 'EVIDENCE') {
          resultEmbeds = buildParticipationSummaryEmbeds(
            activity,
            await activities.buildParticipationSummary(job.guildId, activityId),
            true,
          );
        }
        const settings = await guildConfig.get(job.guildId);
        const channel = await fetchSendableChannel(client, settings?.activityChannelId ?? null, 'Channel กิจกรรม');
        if (activity.leaderboardMessageId === null || activity.leaderboardChannelId === null) {
          const message = await channel.send({
            embeds: resultEmbeds,
            nonce: nonceFor(activityId, 'final'),
            enforceNonce: true,
          });
          await activities.markLeaderboardPublished(job.guildId, activityId, channel.id, message.id);
        } else {
          const leaderboardChannel = await fetchSendableChannel(client, activity.leaderboardChannelId, 'Channel สรุปกิจกรรม');
          const message = await leaderboardChannel.messages.fetch(activity.leaderboardMessageId);
          await message.edit({ embeds: resultEmbeds });
        }
        await refreshAnnouncement(client, activities, job.guildId, activityId);
      },
    ],
    [
      'ATTENDANCE_PUBLISH',
      async (job) => {
        const { roundId } = attendanceJobSchema.parse(job.payload);
        const view = await attendance.getRoundView(job.guildId, roundId);
        if (view.round.announcementMessageId !== null) {
          await refreshAttendance(client, attendance, job.guildId, roundId);
          return;
        }
        const settings = await guildConfig.get(job.guildId);
        const channel = await fetchSendableChannel(client, settings?.attendanceChannelId ?? null, 'Channel เช็กชื่อ');
        const message = await channel.send({
          ...buildAttendanceAnnouncement(view),
          nonce: nonceFor(roundId, 'att-publish'),
          enforceNonce: true,
        });
        await attendance.markRoundPublished(job.guildId, roundId, channel.id, message.id);
      },
    ],
    [
      'ATTENDANCE_OPEN',
      async (job) => {
        const { roundId } = attendanceJobSchema.parse(job.payload);
        await attendance.openRound(job.guildId, roundId, new Date());
        await refreshAttendance(client, attendance, job.guildId, roundId);
      },
    ],
    [
      'ATTENDANCE_REMINDER',
      async (job) => {
        const { roundId } = attendanceJobSchema.parse(job.payload);
        const [round, recipients] = await Promise.all([
          attendance.getRound(job.guildId, roundId),
          attendance.getReminderRecipients(job.guildId, roundId),
        ]);
        if (recipients.length === 0 || round.status !== 'OPEN') return;
        const settings = await guildConfig.get(job.guildId);
        const channel = await fetchSendableChannel(client, settings?.attendanceChannelId ?? null, 'Channel เช็กชื่อ');
        await channel.send({
          content: recipients.map((userId) => `<@${userId}>`).join(' '),
          embeds: [buildMiruEmbed({
            tone: 'warning',
            icon: '⏰',
            title: 'เหลือ 15 นาทีก่อนปิดเช็กชื่อ',
            description: `สมาชิกที่ยังไม่เช็กชื่อ **${recipients.length.toString()} คน**\nกรุณากดเช็กชื่อก่อนหมดเวลา`,
            module: 'Attendance',
          })],
          allowedMentions: { users: recipients },
          nonce: nonceFor(roundId, 'att-remind'),
          enforceNonce: true,
        });
      },
    ],
    [
      'ATTENDANCE_CLOSE',
      async (job) => {
        const { roundId } = attendanceJobSchema.parse(job.payload);
        await attendance.closeRound(job.guildId, roundId, new Date());
        await refreshAttendance(client, attendance, job.guildId, roundId);
      },
    ],
    [
      'ATTENDANCE_REFRESH',
      async (job) => {
        const { roundId } = attendanceJobSchema.parse(job.payload);
        await refreshAttendance(client, attendance, job.guildId, roundId);
      },
    ],
    [
      'ATTENDANCE_SCHEDULE_TICK',
      async (job) => {
        const { scheduleId } = attendanceScheduleJobSchema.parse(job.payload);
        const settings = await guildConfig.get(job.guildId);
        if (settings === null) throw new ValidationError('ไม่พบการตั้งค่า Server');
        await attendance.materializeSchedule(job.guildId, scheduleId, settings.timezone, new Date());
      },
    ],
    [
      'LEAVE_PUBLISH',
      async (job) => {
        const { leaveId } = leaveJobSchema.parse(job.payload);
        const view = await attendance.getLeave(job.guildId, leaveId);
        if (view.leave.publicChannelId !== null && view.leave.publicMessageId !== null) {
          const existingChannel = await fetchSendableChannel(client, view.leave.publicChannelId, 'Channel แจ้งลา');
          const existingMessage = await existingChannel.messages.fetch(view.leave.publicMessageId).catch(() => null);
          if (existingMessage !== null) {
            await existingMessage.edit(buildLeaveLog(view));
            return;
          }
        }
        const settings = await guildConfig.get(job.guildId);
        if (settings === null) throw new ValidationError('ไม่พบการตั้งค่า Server');
        const channel = await fetchSendableChannel(client, settings.leaveLogChannelId, 'Channel Log แจ้งลา');
        const message = await dailyLogs.send(channel, {
          guildId: job.guildId,
          timezone: settings.timezone,
          message: {
            ...buildLeaveLog(view),
            nonce: nonceFor(leaveId, 'leave'),
            enforceNonce: true,
          },
        });
        await attendance.markLeavePublished(job.guildId, leaveId, channel.id, message.id);
      },
    ],
    [
      'FINE_PUBLISH',
      async (job) => {
        const { fineId } = fineJobSchema.parse(job.payload);
        const view = await fines.get(job.guildId, fineId);
        if (view.fine.publicChannelId !== null && view.fine.publicMessageId !== null) {
          await refreshFine(client, fines, job.guildId, fineId);
          return;
        }
        const settings = await guildConfig.get(job.guildId);
        const channel = await fetchSendableChannel(client, settings?.fineChannelId ?? null, 'Channel ค่าปรับ');
        const message = await channel.send({
          ...buildFineAnnouncement(view),
          nonce: nonceFor(fineId, 'fine-publish'),
          enforceNonce: true,
        });
        await fines.markPublished(job.guildId, fineId, channel.id, message.id);
      },
    ],
    [
      'FINE_SURCHARGE',
      async (job) => {
        const { fineId } = fineJobSchema.parse(job.payload);
        await fines.processSurcharge(job.guildId, fineId, new Date());
        await refreshFine(client, fines, job.guildId, fineId);
      },
    ],
    [
      'FINE_REFRESH',
      async (job) => {
        const { fineId } = fineJobSchema.parse(job.payload);
        await refreshFine(client, fines, job.guildId, fineId);
      },
    ],
    [
      'TREASURY_PUBLISH',
      async (job) => {
        const { entryId } = treasuryJobSchema.parse(job.payload);
        const entry = await treasury.getEntry(job.guildId, entryId);
        if (entry.publicChannelId !== null && entry.publicMessageId !== null) {
          await refreshTreasuryDashboard(client, treasury, guildConfig, job.guildId, logger);
          return;
        }
        const settings = await guildConfig.get(job.guildId);
        if (settings === null) throw new ValidationError('ไม่พบการตั้งค่า Server');
        const channel = await fetchSendableChannel(client, settings.treasuryChannelId, 'Channel เงินกองกลาง');
        const evidence = await treasury.getEvidenceLocation(entry);
        const files = evidence === null ? [] : [await resolveEvidenceFile(client, evidence)];
        const message = await dailyLogs.send(channel, {
          guildId: job.guildId,
          timezone: settings.timezone,
          message: {
            ...buildTreasuryEntryLog(entry),
            files,
            nonce: nonceFor(entryId, 'treasury'),
            enforceNonce: true,
          },
        });
        await treasury.markPublished(job.guildId, entryId, channel.id, message.id);
        await refreshTreasuryDashboard(client, treasury, guildConfig, job.guildId, logger);
      },
    ],
    [
      'TREASURY_REFRESH',
      async (job) => {
        await refreshTreasuryDashboard(client, treasury, guildConfig, job.guildId, logger);
      },
    ],
    [
      'TREASURY_WITHDRAWAL_PUBLISH',
      async (job) => {
        const { requestId } = treasuryWithdrawalJobSchema.parse(job.payload);
        const view = await treasuryWithdrawals.get(job.guildId, requestId);
        if (view.request.publicChannelId !== null && view.request.publicMessageId !== null) {
          await refreshTreasuryWithdrawal(
            client,
            treasuryWithdrawals,
            guildConfig,
            dailyLogs,
            job.guildId,
            requestId,
          );
          return;
        }
        const settings = await guildConfig.get(job.guildId);
        if (settings === null) throw new ValidationError('ไม่พบการตั้งค่า Server');
        const channel = await fetchSendableChannel(
          client,
          settings.treasuryWithdrawalLogChannelId,
          'Channel Log เบิกเงินแก๊ง',
        );
        const message = await dailyLogs.send(channel, {
          guildId: job.guildId,
          timezone: settings.timezone,
          message: {
            ...buildTreasuryWithdrawalRequestLog(view),
            nonce: nonceFor(requestId, 'treasury-withdrawal'),
            enforceNonce: true,
          },
        });
        await treasuryWithdrawals.markPublished(job.guildId, requestId, channel.id, message.id);
      },
    ],
    [
      'TREASURY_WITHDRAWAL_REFRESH',
      async (job) => {
        const { requestId } = treasuryWithdrawalJobSchema.parse(job.payload);
        await refreshTreasuryWithdrawal(
          client,
          treasuryWithdrawals,
          guildConfig,
          dailyLogs,
          job.guildId,
          requestId,
        );
      },
    ],
    [
      'WEEKLY_PUBLISH',
      async (job) => {
        const { collectionId } = weeklyJobSchema.parse(job.payload);
        const view = await weeklyDues.get(job.guildId, collectionId);
        if (view.collection.publicChannelId !== null && view.collection.publicMessageId !== null) {
          await refreshWeekly(client, weeklyDues, job.guildId, collectionId);
          return;
        }
        const settings = await guildConfig.get(job.guildId);
        const channel = await fetchSendableChannel(client, settings?.weeklyDuesChannelId ?? null, 'Channel ส่งเงินรายสัปดาห์');
        const message = await channel.send({
          ...buildWeeklyAnnouncement(view),
          nonce: nonceFor(collectionId, 'weekly-publish'),
          enforceNonce: true,
        });
        await weeklyDues.markPublished(job.guildId, collectionId, channel.id, message.id);
      },
    ],
    [
      'WEEKLY_CONVERT',
      async (job) => {
        const { collectionId } = weeklyJobSchema.parse(job.payload);
        await weeklyDues.processConversion(job.guildId, collectionId, new Date());
        await refreshWeekly(client, weeklyDues, job.guildId, collectionId);
      },
    ],
    [
      'WEEKLY_REFRESH',
      async (job) => {
        const { collectionId } = weeklyJobSchema.parse(job.payload);
        await refreshWeekly(client, weeklyDues, job.guildId, collectionId);
      },
    ],
    [
      'STOCK_BATCH_PUBLISH',
      async (job) => {
        const { batchId } = stockBatchJobSchema.parse(job.payload);
        const batch = await inventory.getBatch(job.guildId, batchId);
        if (batch.batch.publicChannelId !== null && batch.batch.publicMessageId !== null) return;
        const settings = await guildConfig.get(job.guildId);
        if (settings === null) throw new ValidationError('ไม่พบการตั้งค่า Server');
        const channel = await fetchSendableChannel(
          client,
          settings.stockLogChannelId ?? settings.stockChannelId,
          'Channel Log Stock รวม',
        );
        const message = await dailyLogs.send(channel, {
          guildId: job.guildId,
          timezone: settings.timezone,
          message: {
            ...buildBatchLog(batch),
            nonce: nonceFor(batchId, 'stock-batch'),
            enforceNonce: true,
          },
        });
        await inventory.markBatchPublished(job.guildId, batchId, channel.id, message.id);
        await refreshStockDashboard(client, inventory, guildConfig, job.guildId, logger);
      },
    ],
    [
      'STOCK_REFRESH',
      async (job) => {
        await refreshStockDashboard(client, inventory, guildConfig, job.guildId, logger);
      },
    ],
    [
      'STOCK_BATCH_REFRESH',
      async (job) => {
        const { batchId } = stockBatchJobSchema.parse(job.payload);
        const batch = await inventory.getBatch(job.guildId, batchId);
        if (batch.batch.publicChannelId === null || batch.batch.publicMessageId === null) return;
        const channel = await fetchSendableChannel(client, batch.batch.publicChannelId, 'Channel Stock');
        const message = await channel.messages.fetch(batch.batch.publicMessageId).catch(() => null);
        if (message !== null) await message.edit(buildBatchLog(batch));
      },
    ],
    [
      'WITHDRAWAL_PUBLISH',
      async (job) => {
        const { requestId } = withdrawalJobSchema.parse(job.payload);
        const view = await withdrawals.get(job.guildId, requestId);
        if (view.request.publicChannelId !== null && view.request.publicMessageId !== null) {
          await refreshWithdrawal(client, withdrawals, guildConfig, dailyLogs, job.guildId, requestId);
          return;
        }
        const settings = await guildConfig.get(job.guildId);
        if (settings === null) throw new ValidationError('ไม่พบการตั้งค่า Server');
        const channel = await fetchSendableChannel(
          client,
          settings.stockLogChannelId ?? settings.withdrawalLogChannelId,
          'Channel Log Stock รวม',
        );
        const message = await dailyLogs.send(channel, {
          guildId: job.guildId,
          timezone: settings.timezone,
          message: {
            ...buildWithdrawalLog(view),
            nonce: nonceFor(requestId, 'withdrawal'),
            enforceNonce: true,
          },
        });
        await withdrawals.markPublished(job.guildId, requestId, channel.id, message.id);
      },
    ],
    [
      'WITHDRAWAL_REFRESH',
      async (job) => {
        const { requestId } = withdrawalJobSchema.parse(job.payload);
        await refreshWithdrawal(client, withdrawals, guildConfig, dailyLogs, job.guildId, requestId);
      },
    ],
    [
      'FIGHT_POSITION_REFRESH',
      async (job) => {
        await syncFightPositionSummary(client, fightPositions, guildConfig, job.guildId, false);
      },
    ],
  ]);
}

async function refreshStockDashboard(
  client: Client,
  inventory: InventoryService,
  guildConfig: GuildConfigService,
  guildId: string,
  logger: pino.Logger,
): Promise<void> {
  const settings = await guildConfig.get(guildId);
  if (settings === null) return;
  const dashboardData = await inventory.getDashboard(guildId);
  if (settings.stockPanelMessageId !== null) {
    const channel = await fetchSendableChannel(client, settings.stockChannelId, 'Channel Stock');
    await replaceStockDashboard(
      channel,
      settings.stockPanelMessageId,
      buildStockDashboard(dashboardData),
      async (messageId) => guildConfig.saveStockPanelMessage(guildId, messageId),
      logger,
    );
  }
  if (settings.stockLogChannelId !== null) {
    const logChannel = await fetchSendableChannel(client, settings.stockLogChannelId, 'Channel Log Stock รวม');
    await replaceStockDashboard(
      logChannel,
      settings.stockLogDashboardMessageId,
      buildStockDashboard(dashboardData, 'LOG'),
      async (messageId) => guildConfig.saveStockLogDashboardMessage(guildId, messageId),
      logger,
    );
  }
}

async function replaceStockDashboard(
  channel: SendableChannels,
  previousMessageId: string | null,
  dashboard: ReturnType<typeof buildStockDashboard>,
  saveMessageId: (messageId: string) => Promise<void>,
  logger: pino.Logger,
): Promise<void> {
  const previousMessage = previousMessageId === null
    ? null
    : await channel.messages.fetch(previousMessageId).catch(() => null);
  const replacement = await channel.send(dashboard);
  try {
    await saveMessageId(replacement.id);
  } catch (error: unknown) {
    await replacement.delete().catch((cleanupError: unknown) => {
      logger.error({ err: cleanupError, messageId: replacement.id }, 'failed to remove untracked replacement stock panel');
    });
    throw error;
  }
  if (previousMessage !== null) {
    await previousMessage.delete().catch((error: unknown) => {
      logger.warn({ err: error, messageId: previousMessage.id }, 'failed to remove previous stock panel');
    });
  }
}

async function refreshMemberRoster(
  client: Client,
  members: MemberService,
  guildConfig: GuildConfigService,
  guildId: string,
): Promise<void> {
  const settings = await guildConfig.get(guildId);
  if (settings?.memberRosterChannelId === null || settings?.memberRosterChannelId === undefined) return;
  if (settings.memberRosterMessageId === null) return;

  const channel = await fetchSendableChannel(client, settings.memberRosterChannelId, 'Channel รายชื่อสมาชิกปัจจุบัน');
  const content = buildMemberRoster(await members.listActive(guildId));
  const message = await channel.messages.fetch(settings.memberRosterMessageId).catch(() => null);
  if (message !== null) {
    await message.edit(content);
    return;
  }

  const replacement = await channel.send(content);
  await guildConfig.saveMemberRosterMessage(guildId, replacement.id);
}

async function refreshWithdrawal(
  client: Client,
  withdrawals: WithdrawalService,
  guildConfig: GuildConfigService,
  dailyLogs: DailyLogPublisher,
  guildId: string,
  requestId: string,
): Promise<void> {
  const view = await withdrawals.get(guildId, requestId);
  if (view.request.publicChannelId === null || view.request.publicMessageId === null) return;
  const channel = await fetchSendableChannel(client, view.request.publicChannelId, 'Channel Stock');
  const message = await channel.messages.fetch(view.request.publicMessageId).catch(() => null);
  if (message !== null) {
    await message.edit(buildWithdrawalLog(view));
    return;
  }
  const settings = await guildConfig.get(guildId);
  if (settings === null) throw new ValidationError('ไม่พบการตั้งค่า Server');
  const replacement = await dailyLogs.send(channel, {
    guildId,
    timezone: settings.timezone,
    message: buildWithdrawalLog(view),
  });
  await withdrawals.markPublished(guildId, requestId, channel.id, replacement.id);
}

async function refreshTreasuryWithdrawal(
  client: Client,
  withdrawals: TreasuryWithdrawalService,
  guildConfig: GuildConfigService,
  dailyLogs: DailyLogPublisher,
  guildId: string,
  requestId: string,
): Promise<void> {
  const view = await withdrawals.get(guildId, requestId);
  if (view.request.publicChannelId === null || view.request.publicMessageId === null) return;
  const channel = await fetchSendableChannel(
    client,
    view.request.publicChannelId,
    'Channel Log การเงินรวม',
  );
  const message = await channel.messages.fetch(view.request.publicMessageId).catch(() => null);
  if (message !== null) {
    await message.edit(buildTreasuryWithdrawalRequestLog(view));
    return;
  }
  const settings = await guildConfig.get(guildId);
  if (settings === null) throw new ValidationError('ไม่พบการตั้งค่า Server');
  const replacement = await dailyLogs.send(channel, {
    guildId,
    timezone: settings.timezone,
    message: buildTreasuryWithdrawalRequestLog(view),
  });
  await withdrawals.markPublished(guildId, requestId, channel.id, replacement.id);
}

async function refreshWeekly(
  client: Client,
  weeklyDues: WeeklyDuesService,
  guildId: string,
  collectionId: string,
): Promise<void> {
  const view = await weeklyDues.get(guildId, collectionId);
  if (view.collection.publicChannelId === null || view.collection.publicMessageId === null) return;
  const channel = await fetchSendableChannel(client, view.collection.publicChannelId, 'Channel ส่งเงินรายสัปดาห์');
  const message = await channel.messages.fetch(view.collection.publicMessageId).catch(() => null);
  if (message !== null) {
    await message.edit(buildWeeklyAnnouncement(view));
    return;
  }
  const replacement = await channel.send(buildWeeklyAnnouncement(view));
  await weeklyDues.markPublished(guildId, collectionId, channel.id, replacement.id);
}

async function refreshAnnouncement(
  client: Client,
  activities: ActivityService,
  guildId: string,
  activityId: string,
): Promise<void> {
  const activity = await activities.getWithScores(guildId, activityId, true);
  if (activity.activity.announcementChannelId === null || activity.activity.announcementMessageId === null) {
    return;
  }
  const channel = await fetchSendableChannel(client, activity.activity.announcementChannelId, 'Channel กิจกรรม');
  const message = await channel.messages.fetch(activity.activity.announcementMessageId);
  await message.edit(buildActivityAnnouncement(activity, activity.activity.status === 'CLOSED'));
}

async function refreshAttendance(
  client: Client,
  attendance: AttendanceService,
  guildId: string,
  roundId: string,
): Promise<void> {
  const view = await attendance.getRoundView(guildId, roundId);
  if (view.round.announcementChannelId === null || view.round.announcementMessageId === null) return;
  const channel = await fetchSendableChannel(client, view.round.announcementChannelId, 'Channel เช็กชื่อ');
  const message = await channel.messages.fetch(view.round.announcementMessageId).catch(() => null);
  if (message !== null) {
    await message.edit(buildAttendanceAnnouncement(view));
    return;
  }
  const replacement = await channel.send(buildAttendanceAnnouncement(view));
  await attendance.markRoundPublished(guildId, roundId, channel.id, replacement.id);
}

async function refreshFine(
  client: Client,
  fines: FineService,
  guildId: string,
  fineId: string,
): Promise<void> {
  const view = await fines.get(guildId, fineId);
  if (view.fine.publicChannelId === null || view.fine.publicMessageId === null) return;
  const channel = await fetchSendableChannel(client, view.fine.publicChannelId, 'Channel ค่าปรับ');
  const message = await channel.messages.fetch(view.fine.publicMessageId).catch(() => null);
  if (message !== null) {
    await message.edit(buildFineAnnouncement(view));
    return;
  }
  const replacement = await channel.send(buildFineAnnouncement(view));
  await fines.markPublished(guildId, fineId, channel.id, replacement.id);
}

async function refreshTreasuryDashboard(
  client: Client,
  treasury: TreasuryService,
  guildConfig: GuildConfigService,
  guildId: string,
  logger: pino.Logger,
): Promise<void> {
  const settings = await guildConfig.get(guildId);
  const channel = await fetchSendableChannel(client, settings?.treasuryChannelId ?? null, 'Channel เงินกองกลาง');
  const content = buildTreasuryDashboard(await treasury.getDashboard(guildId));
  const existing = settings?.treasuryPanelMessageId === null || settings?.treasuryPanelMessageId === undefined
    ? null
    : await channel.messages.fetch(settings.treasuryPanelMessageId).catch(() => null);
  const message = await channel.send(content);
  try {
    await guildConfig.saveTreasuryPanelMessage(guildId, message.id);
  } catch (error: unknown) {
    await message.delete().catch((deleteError: unknown) => {
      logger.error({ err: deleteError, messageId: message.id }, 'failed to remove untracked treasury dashboard');
    });
    throw error;
  }
  if (existing !== null) {
    await existing.delete().catch((error: unknown) => {
      logger.warn({ err: error, messageId: existing.id }, 'failed to remove previous treasury dashboard');
    });
  }
}

async function resolveEvidenceFile(
  client: Client,
  evidence: { channelId: string; messageId: string; attachmentId: string },
) {
  const channel = await fetchSendableChannel(client, evidence.channelId, 'Channel หลักฐานต้นทาง');
  const message = await channel.messages.fetch(evidence.messageId);
  const attachment = message.attachments.get(evidence.attachmentId);
  if (attachment === undefined) throw new ValidationError('ไม่พบรูปหลักฐานต้นทางของรายการเงินกองกลาง');
  return { attachment: attachment.url, name: attachment.name ?? `treasury-evidence-${attachment.id}` };
}

async function fetchSendableChannel(client: Client, channelId: string | null, label: string): Promise<SendableChannels> {
  if (channelId === null) {
    throw new ValidationError(`กรุณาตั้งค่า ${label}`);
  }
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
    throw new ValidationError(`${label} ไม่ใช่ Text Channel ที่ Bot ส่งข้อความได้`);
  }
  return channel;
}

async function moveControlPanelToChannelBottom(
  client: Client,
  guildConfig: GuildConfigService,
  guildId: string,
  logger: pino.Logger,
): Promise<void> {
  const settings = await guildConfig.get(guildId);
  if (settings === null || settings.controlChannelId === null || settings.controlPanelMessageId === null) return;
  const channel = await fetchSendableChannel(client, settings.controlChannelId, 'Control Channel');
  const existing = await channel.messages.fetch(settings.controlPanelMessageId).catch(() => null);
  if (existing === null) return;

  const replacement = await channel.send(buildControlPanel());
  try {
    await guildConfig.saveControlPanelMessage(guildId, replacement.id);
  } catch (error: unknown) {
    await replacement.delete().catch((cleanupError: unknown) => {
      logger.error({ err: cleanupError, messageId: replacement.id }, 'failed to remove untracked control panel');
    });
    throw error;
  }
  await existing.delete().catch((error: unknown) => {
    logger.warn({ err: error, messageId: existing.id }, 'failed to remove previous control panel');
  });
}

function nonceFor(activityId: string, suffix: string): string {
  return `${activityId.replaceAll('-', '').slice(0, 18)}-${suffix}`.slice(0, 25);
}

function discordTimestamp(value: Date, style: 'R'): string {
  return `<t:${String(Math.floor(value.getTime() / 1_000))}:${style}>`;
}
