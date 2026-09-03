import { createHash } from 'node:crypto';
import type pino from 'pino';
import {
  MessageFlags,
  type Attachment,
  type ButtonInteraction,
  type Client,
  type Guild,
  type Interaction,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { AuthorizationError, ValidationError } from '../../domain/errors.js';
import {
  formatDateInput,
  formatDateTimeInput,
  formatLocalDateInput,
  parseDateInput,
  parseDateTimeInput,
} from '../../domain/temporal-input.js';
import {
  hasCapability,
  resolveAuthority,
  type AuthorityLevel,
} from '../../modules/authorization/permissions.js';
import type { AttendanceMode, AttendanceService } from '../../modules/attendance/service.js';
import {
  buildAirdropRoundTimes,
  buildGeneralRoundTimes,
  validateAttendanceProof,
  type AttendanceResult,
} from '../../modules/attendance/rules.js';
import type { GuildConfigService } from '../../modules/guild-config/service.js';
import type { MemberService } from '../../modules/members/service.js';
import type { GuildSettings } from '../db/schema.js';
import {
  attendanceComponentIds,
  attendanceCreateModalPrefix,
  attendanceProofModalPrefix,
  attendanceRecurringModalPrefix,
  buildAttendanceAdminPanel,
  buildAttendanceManagement,
  buildAttendanceModeSelector,
  buildAttendanceProofLog,
  buildAttendanceProofModal,
  buildCorrectionModal,
  buildCreateRoundModal,
  buildLeaveCancelConfirmation,
  buildLeaveEditModal,
  buildLeaveLog,
  buildLeaveModal,
  buildLeavePanel,
  buildRecurringScheduleModal,
  leaveEditModalPrefix,
  leaveSubmitModalId,
} from './attendance-components.js';
import { componentIds } from './components.js';
import { buildNotice } from './theme.js';
import { filterRoleVerifiedActiveMembers } from './role-verified-members.js';

export interface AttendanceInteractionDependencies {
  readonly client: Client;
  readonly attendance: AttendanceService;
  readonly guildConfig: GuildConfigService;
  readonly members: MemberService;
  readonly logger: pino.Logger;
}

export class AttendanceInteractionHandler {
  public constructor(private readonly dependencies: AttendanceInteractionDependencies) {}

  public async handle(interaction: Interaction): Promise<boolean> {
    if (interaction.isButton() && isAttendanceButton(interaction.customId)) {
      await this.handleButton(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('attendance:')) {
      await this.handleSelect(interaction);
      return true;
    }
    if (interaction.isModalSubmit() && isAttendanceModal(interaction.customId)) {
      await this.handleModal(interaction);
      return true;
    }
    return false;
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === componentIds.controlAttendance) {
      await this.requireAdmin(guild, interaction.user.id);
      const rounds = await this.dependencies.attendance.listRounds(guild.id);
      await interaction.reply({ ...buildAttendanceAdminPanel(rounds), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === attendanceComponentIds.adminCreate) {
      await this.requireAdmin(guild, interaction.user.id);
      const settings = await this.requireSettings(guild.id);
      requireAttendanceChannels(settings);
      await interaction.reply({ ...buildAttendanceModeSelector('MANUAL'), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === attendanceComponentIds.adminRecurring) {
      await this.requireAdmin(guild, interaction.user.id);
      const settings = await this.requireSettings(guild.id);
      requireAttendanceChannels(settings);
      await interaction.reply({ ...buildAttendanceModeSelector('AUTO'), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === attendanceComponentIds.adminPublishLeave) {
      await this.publishLeavePanel(interaction, guild);
      return;
    }
    if (interaction.customId === attendanceComponentIds.leaveSubmit) {
      await this.requireActiveMember(guild, interaction.user.id);
      const settings = await this.requireSettings(guild.id);
      requireLeaveChannels(settings);
      const today = formatLocalDateInput(new Date(), settings.timezone);
      await interaction.showModal(buildLeaveModal(today, today));
      return;
    }
    if (interaction.customId.startsWith('attendance:check_in:')) {
      await this.requireActiveMember(guild, interaction.user.id);
      const roundId = entityId(interaction.customId, 'attendance:check_in:');
      const round = await this.dependencies.attendance.getRound(guild.id, roundId);
      if (round.mode === 'AIRDROP') {
        await interaction.showModal(buildAttendanceProofModal(roundId));
        return;
      }
      await this.dependencies.attendance.checkIn(guild.id, roundId, interaction.user.id, new Date());
      await interaction.reply({ ...buildNotice('success', 'เช็กชื่อสำเร็จ', 'รายชื่อผู้มาเข้าร่วมจะอัปเดตอัตโนมัติ', 'Attendance'), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId.startsWith('attendance:correct:')) {
      await this.requireAdmin(guild, interaction.user.id);
      const roundId = entityId(interaction.customId, 'attendance:correct:');
      const round = await this.dependencies.attendance.getRound(guild.id, roundId);
      if (round.status !== 'CLOSED') {
        throw new ValidationError('แก้ผลย้อนหลังได้หลังรอบปิดแล้วเท่านั้น');
      }
      const settings = await this.requireSettings(guild.id);
      const members = await filterRoleVerifiedActiveMembers(
        guild,
        settings,
        await this.dependencies.members.listActive(guild.id),
      );
      if (members.length === 0) throw new ValidationError('ไม่มีสมาชิกที่รับยศแล้วให้เลือก');
      await interaction.showModal(buildCorrectionModal(roundId, members));
      return;
    }
    if (interaction.customId.startsWith('leave:edit:')) {
      const leaveId = entityId(interaction.customId, 'leave:edit:');
      const view = await this.requireLeaveActor(guild, interaction.user.id, leaveId);
      await interaction.showModal(buildLeaveEditModal(
        view,
        formatDateInput(view.leave.startsOn),
        formatDateInput(view.leave.endsOn),
      ));
      return;
    }
    if (interaction.customId.startsWith('leave:cancel_confirm:')) {
      const leaveId = entityId(interaction.customId, 'leave:cancel_confirm:');
      const isAdmin = await this.requireMemberOrAdmin(guild, interaction.user.id);
      const settings = await this.requireSettings(guild.id);
      const view = await this.dependencies.attendance.cancelLeave(
        guild.id,
        leaveId,
        interaction.user.id,
        isAdmin,
        settings.timezone,
        new Date(),
      );
      await this.updateLeaveLog(view);
      await interaction.update({ ...buildNotice('success', 'ยกเลิกใบลาแล้ว', 'ระบบอัปเดตสถานะใบลาเรียบร้อย', 'Leave'), components: [] });
      return;
    }
    if (interaction.customId.startsWith('leave:cancel:')) {
      const leaveId = entityId(interaction.customId, 'leave:cancel:');
      await this.requireLeaveActor(guild, interaction.user.id, leaveId);
      await interaction.reply({ ...buildLeaveCancelConfirmation(leaveId), flags: MessageFlags.Ephemeral });
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === attendanceComponentIds.createType) {
      await this.requireAdmin(guild, interaction.user.id);
      const settings = await this.requireSettings(guild.id);
      requireAttendanceChannels(settings);
      const mode = requireAttendanceMode(interaction.values[0]);
      const now = new Date();
      const eventAt = new Date(now.getTime() + 10 * 60 * 1_000);
      const closesAt = new Date(now.getTime() + 60 * 60 * 1_000);
      await interaction.showModal(buildCreateRoundModal(mode, {
        title: mode === 'AIRDROP' ? `Airdrop ${formatDateTimeInput(eventAt, settings.timezone).slice(-5)}` : 'เช็กชื่อทั่วไป',
        eventAt: formatDateTimeInput(eventAt, settings.timezone),
        opensAt: formatDateTimeInput(now, settings.timezone),
        closesAt: formatDateTimeInput(closesAt, settings.timezone),
      }));
      return;
    }
    if (interaction.customId === attendanceComponentIds.recurringType) {
      await this.requireAdmin(guild, interaction.user.id);
      await this.requireSettings(guild.id);
      await interaction.showModal(buildRecurringScheduleModal(requireAttendanceMode(interaction.values[0])));
      return;
    }
    if (interaction.customId !== attendanceComponentIds.adminRoundSelect) return;
    await this.requireAdmin(guild, interaction.user.id);
    const roundId = interaction.values[0];
    if (roundId === undefined) throw new ValidationError('กรุณาเลือกรอบเช็กชื่อ');
    const view = await this.dependencies.attendance.getRoundView(guild.id, roundId);
    await interaction.update({ ...buildAttendanceManagement(view), content: null });
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId.startsWith(attendanceCreateModalPrefix)) {
      await this.createRound(
        interaction,
        guild,
        requireAttendanceMode(interaction.customId.slice(attendanceCreateModalPrefix.length)),
      );
      return;
    }
    if (interaction.customId.startsWith(attendanceRecurringModalPrefix)) {
      await this.createRecurringSchedule(
        interaction,
        guild,
        requireAttendanceMode(interaction.customId.slice(attendanceRecurringModalPrefix.length)),
      );
      return;
    }
    if (interaction.customId.startsWith(attendanceProofModalPrefix)) {
      await this.submitAttendanceProof(
        interaction,
        guild,
        entityId(interaction.customId, attendanceProofModalPrefix),
      );
      return;
    }
    if (interaction.customId === leaveSubmitModalId) {
      await this.submitLeave(interaction, guild);
      return;
    }
    if (interaction.customId.startsWith(leaveEditModalPrefix)) {
      await this.editLeave(interaction, guild, entityId(interaction.customId, leaveEditModalPrefix));
      return;
    }
    if (interaction.customId.startsWith('attendance:correct_modal:')) {
      await this.correctAttendance(interaction, guild, entityId(interaction.customId, 'attendance:correct_modal:'));
    }
  }

  private async createRound(interaction: ModalSubmitInteraction, guild: Guild, mode: AttendanceMode): Promise<void> {
    await this.requireAdmin(guild, interaction.user.id);
    const settings = await this.requireSettings(guild.id);
    requireAttendanceChannels(settings);
    const now = new Date();
    const eventAt = mode === 'AIRDROP'
      ? parseDateTimeInput(
          interaction.fields.getTextInputValue(attendanceComponentIds.createEventAt),
          settings.timezone,
          'เวลา Airdrop',
        )
      : undefined;
    const times = eventAt === undefined
      ? buildGeneralRoundTimes(
          parseDateTimeInput(
            interaction.fields.getTextInputValue(attendanceComponentIds.createOpensAt),
            settings.timezone,
            'วันเวลาเปิด',
          ),
          parseDateTimeInput(
            interaction.fields.getTextInputValue(attendanceComponentIds.createClosesAt),
            settings.timezone,
            'วันเวลาปิด',
          ),
          settings.timezone,
        )
      : buildAirdropRoundTimes(
          eventAt,
          settings.timezone,
          parseMinuteOffset(interaction.fields.getTextInputValue(attendanceComponentIds.createBeforeMinutes), 'นาทีก่อน Airdrop'),
          parseMinuteOffset(interaction.fields.getTextInputValue(attendanceComponentIds.createAfterMinutes), 'นาทีหลัง Airdrop'),
        );
    const round = await this.dependencies.attendance.createRound({
      guildId: guild.id,
      requestId: interaction.id,
      title: interaction.fields.getTextInputValue(attendanceComponentIds.createTitle),
      mode,
      ...(eventAt === undefined ? {} : { eventAt }),
      ...times,
      actorDiscordUserId: interaction.user.id,
      now,
    });
    await interaction.reply({
      ...buildNotice('success', 'สร้างรอบเช็กชื่อแล้ว', `📅 **${round.title}**\nระบบจะประกาศ เปิด เตือนก่อนปิด 15 นาที และสรุปผลอัตโนมัติ`, 'Attendance'),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async createRecurringSchedule(
    interaction: ModalSubmitInteraction,
    guild: Guild,
    mode: AttendanceMode,
  ): Promise<void> {
    await this.requireAdmin(guild, interaction.user.id);
    const settings = await this.requireSettings(guild.id);
    requireAttendanceChannels(settings);
    const common = {
      guildId: guild.id,
      requestId: interaction.id,
      name: interaction.fields.getTextInputValue(attendanceComponentIds.recurringName),
      weekdays: parseWeekdays(interaction.fields.getTextInputValue(attendanceComponentIds.recurringWeekdays)),
      timezone: settings.timezone,
      actorDiscordUserId: interaction.user.id,
      now: new Date(),
    } as const;
    const schedule = mode === 'AIRDROP'
      ? await this.dependencies.attendance.createRecurringSchedule({
          ...common,
          mode,
          eventAtLocalTime: interaction.fields.getTextInputValue(attendanceComponentIds.recurringEventAt),
          opensBeforeMinutes: parseMinuteOffset(interaction.fields.getTextInputValue(attendanceComponentIds.recurringBeforeMinutes), 'นาทีก่อน Airdrop'),
          closesAfterMinutes: parseMinuteOffset(interaction.fields.getTextInputValue(attendanceComponentIds.recurringAfterMinutes), 'นาทีหลัง Airdrop'),
        })
      : await this.dependencies.attendance.createRecurringSchedule({
          ...common,
          mode,
          opensAtLocalTime: interaction.fields.getTextInputValue(attendanceComponentIds.recurringOpensAt),
          closesAtLocalTime: interaction.fields.getTextInputValue(attendanceComponentIds.recurringClosesAt),
        });
    await interaction.reply({
      ...buildNotice('success', 'ตั้งเวลาเช็กชื่อประจำแล้ว', `⏰ **${schedule.name}**\nสร้างรอบล่วงหน้า 21 วัน และระบบจะเติมรอบใหม่ให้อัตโนมัติ`, 'Attendance'),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async submitAttendanceProof(
    interaction: ModalSubmitInteraction,
    guild: Guild,
    roundId: string,
  ): Promise<void> {
    const uploaded = [...interaction.fields.getUploadedFiles(attendanceComponentIds.proofFile, true).values()];
    const attachment = uploaded[0];
    if (attachment === undefined || uploaded.length !== 1) {
      throw new ValidationError('กรุณาแนบรูปหลักฐาน 1 รูป');
    }
    validateAttendanceProof({ contentType: attachment.contentType, size: attachment.size });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.requireActiveMember(guild, interaction.user.id);
    const [round, member, settings, file] = await Promise.all([
      this.dependencies.attendance.getRound(guild.id, roundId),
      this.dependencies.members.findByDiscordUserId(guild.id, interaction.user.id),
      this.requireSettings(guild.id),
      downloadAttendanceProof(attachment),
    ]);
    if (round.mode !== 'AIRDROP') {
      throw new ValidationError('เช็กชื่อทั่วไปไม่ต้องแนบรูปหลักฐาน');
    }
    if (member === null || member.status !== 'ACTIVE') {
      throw new AuthorizationError('ต้องเป็นสมาชิกที่มีสถานะใช้งาน');
    }
    const channel = await fetchSendableChannel(
      this.dependencies.client,
      round.announcementChannelId ?? settings.attendanceChannelId,
      'Channel เช็กชื่อ',
    );

    const proofMessage = await channel.send({
      ...buildAttendanceProofLog(round, member),
      files: [{ attachment: file.bytes, name: attendanceProofFilename(attachment) }],
    });
    try {
      const persistedAttachment = [...proofMessage.attachments.values()][0];
      if (persistedAttachment === undefined) {
        throw new Error('Discord did not persist the attendance proof attachment');
      }
      await this.dependencies.attendance.checkInWithProof(
        guild.id,
        roundId,
        interaction.user.id,
        {
          attachmentId: persistedAttachment.id,
          channelId: channel.id,
          messageId: proofMessage.id,
          sha256: file.sha256,
        },
        new Date(),
      );
    } catch (error: unknown) {
      await proofMessage.delete().catch((deleteError: unknown) => {
        this.dependencies.logger.error({ err: deleteError, messageId: proofMessage.id }, 'failed to remove orphan attendance proof');
      });
      throw error;
    }
    await interaction.editReply(buildNotice(
      'success',
      'เช็กชื่อ Airdrop สำเร็จ',
      'บันทึกรูปหลักฐานแล้ว ระบบนับผลเป็นมาในรอบนี้',
      'Attendance',
    ));
  }

  private async publishLeavePanel(interaction: ButtonInteraction, guild: Guild): Promise<void> {
    await this.requireAdmin(guild, interaction.user.id);
    const settings = await this.requireSettings(guild.id);
    const channel = await fetchSendableChannel(this.dependencies.client, settings.leaveChannelId, 'Channel แจ้งลา');
    if (settings.leavePanelMessageId !== null) {
      const existing = await channel.messages.fetch(settings.leavePanelMessageId).catch(() => null);
      if (existing !== null) {
        await existing.edit(buildLeavePanel());
        await interaction.reply({ ...buildNotice('success', 'อัปเดต Panel แจ้งลาแล้ว', `ปลายทาง: <#${channel.id}>`, 'Leave'), flags: MessageFlags.Ephemeral });
        return;
      }
    }
    const message = await channel.send(buildLeavePanel());
    await this.dependencies.guildConfig.saveLeavePanelMessage(guild.id, message.id);
    await interaction.reply({ ...buildNotice('success', 'ส่ง Panel แจ้งลาแล้ว', `ปลายทาง: <#${channel.id}>`, 'Leave'), flags: MessageFlags.Ephemeral });
  }

  private async submitLeave(interaction: ModalSubmitInteraction, guild: Guild): Promise<void> {
    await this.requireActiveMember(guild, interaction.user.id);
    const settings = await this.requireSettings(guild.id);
    requireLeaveChannels(settings);
    const view = await this.dependencies.attendance.submitLeave({
      guildId: guild.id,
      requestId: interaction.id,
      discordUserId: interaction.user.id,
      startsOn: parseDateInput(interaction.fields.getTextInputValue(attendanceComponentIds.leaveStartsOn), 'วันเริ่มลา'),
      endsOn: parseDateInput(interaction.fields.getTextInputValue(attendanceComponentIds.leaveEndsOn), 'วันสิ้นสุดลา'),
      reason: interaction.fields.getTextInputValue(attendanceComponentIds.leaveReason),
      timezone: settings.timezone,
      now: new Date(),
    });
    await interaction.reply({
      ...buildNotice('success', 'บันทึกใบลาแล้ว', `📅 **${view.leave.startsOn} – ${view.leave.endsOn}**\nใบลามีผลทันทีและไม่ต้องรออนุมัติ`, 'Leave'),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async editLeave(interaction: ModalSubmitInteraction, guild: Guild, leaveId: string): Promise<void> {
    const isAdmin = await this.requireMemberOrAdmin(guild, interaction.user.id);
    const settings = await this.requireSettings(guild.id);
    const view = await this.dependencies.attendance.editLeave(
      guild.id,
      leaveId,
      interaction.user.id,
      isAdmin,
      parseDateInput(interaction.fields.getTextInputValue(attendanceComponentIds.leaveStartsOn), 'วันเริ่มลา'),
      parseDateInput(interaction.fields.getTextInputValue(attendanceComponentIds.leaveEndsOn), 'วันสิ้นสุดลา'),
      interaction.fields.getTextInputValue(attendanceComponentIds.leaveReason),
      settings.timezone,
      new Date(),
    );
    await this.updateLeaveLog(view);
    await interaction.reply({ ...buildNotice('success', 'แก้ไขใบลาแล้ว', 'ช่วงวันลาและเหตุผลได้รับการอัปเดต', 'Leave'), flags: MessageFlags.Ephemeral });
  }

  private async correctAttendance(interaction: ModalSubmitInteraction, guild: Guild, roundId: string): Promise<void> {
    await this.requireAdmin(guild, interaction.user.id);
    const memberId = interaction.fields.getStringSelectValues(attendanceComponentIds.correctionMember)[0];
    const result = interaction.fields.getStringSelectValues(attendanceComponentIds.correctionResult)[0];
    if (memberId === undefined || !isAttendanceResult(result)) {
      throw new ValidationError('กรุณาเลือกสมาชิกและผลที่ถูกต้อง');
    }
    const settings = await this.requireSettings(guild.id);
    const members = await filterRoleVerifiedActiveMembers(
      guild,
      settings,
      await this.dependencies.members.listActive(guild.id),
    );
    if (!members.some((member) => member.discordUserId === memberId)) {
      throw new ValidationError('สมาชิกนี้ยังไม่ได้รับยศหรือไม่มีสถานะใช้งาน');
    }
    await this.dependencies.attendance.correctAttendance(
      guild.id,
      roundId,
      memberId,
      result,
      interaction.fields.getTextInputValue(attendanceComponentIds.correctionReason),
      interaction.user.id,
      new Date(),
    );
    await interaction.reply({ ...buildNotice('success', 'แก้ผลย้อนหลังแล้ว', 'ผลเช็กชื่อและ Audit log ได้รับการบันทึกเรียบร้อย', 'Attendance'), flags: MessageFlags.Ephemeral });
  }

  private async requireLeaveActor(guild: Guild, discordUserId: string, leaveId: string) {
    const [view, isAdmin] = await Promise.all([
      this.dependencies.attendance.getLeave(guild.id, leaveId),
      this.requireMemberOrAdmin(guild, discordUserId),
    ]);
    if (!isAdmin && view.discordUserId !== discordUserId) {
      throw new AuthorizationError('ปุ่มนี้กดได้เฉพาะเจ้าของใบลาหรือหัวแก๊ง/รองแก๊ง');
    }
    return view;
  }

  private async requireAdmin(guild: Guild, discordUserId: string): Promise<void> {
    const authority = await this.resolveCurrentAuthority(guild, discordUserId);
    if (!hasCapability(authority, 'ROUTINE_ADMIN')) throw new AuthorizationError();
  }

  private async requireActiveMember(guild: Guild, discordUserId: string): Promise<void> {
    const [authority, member] = await Promise.all([
      this.resolveCurrentAuthority(guild, discordUserId),
      this.dependencies.members.findByDiscordUserId(guild.id, discordUserId),
    ]);
    if (!hasCapability(authority, 'MEMBER_USE') || member?.status !== 'ACTIVE') {
      throw new AuthorizationError('ต้องมี Role สมาชิกและสถานะสมาชิกใช้งานจึงเช็กชื่อหรือแจ้งลาได้');
    }
  }

  private async requireMemberOrAdmin(guild: Guild, discordUserId: string): Promise<boolean> {
    const authority = await this.resolveCurrentAuthority(guild, discordUserId);
    const isAdmin = hasCapability(authority, 'ROUTINE_ADMIN');
    if (!isAdmin) await this.requireActiveMember(guild, discordUserId);
    return isAdmin;
  }

  private async resolveCurrentAuthority(guild: Guild, discordUserId: string): Promise<AuthorityLevel> {
    const [settings, member] = await Promise.all([this.requireSettings(guild.id), guild.members.fetch(discordUserId)]);
    const authority = resolveAuthority(new Set(member.roles.cache.keys()), {
      devRoleId: settings.devRoleId,
      headRoleId: settings.headRoleId,
      deputyRoleId: settings.deputyRoleId,
      activeMemberRoleId: settings.activeMemberRoleId,
    });
    if (authority === null) throw new AuthorizationError();
    return authority;
  }

  private async requireSettings(guildId: string): Promise<GuildSettings> {
    const settings = await this.dependencies.guildConfig.get(guildId);
    if (settings === null) throw new ValidationError('ยังไม่ได้ตั้งค่า Server');
    return settings;
  }

  private async updateLeaveLog(view: Awaited<ReturnType<AttendanceService['getLeave']>>): Promise<void> {
    if (view.leave.publicChannelId === null || view.leave.publicMessageId === null) return;
    const channel = await fetchSendableChannel(this.dependencies.client, view.leave.publicChannelId, 'Channel แจ้งลา');
    const message = await channel.messages.fetch(view.leave.publicMessageId).catch(() => null);
    if (message !== null) {
      await message.edit(buildLeaveLog(view));
      return;
    }
    const replacement = await channel.send(buildLeaveLog(view));
    await this.dependencies.attendance.markLeavePublished(view.leave.guildId, view.leave.id, channel.id, replacement.id);
  }
}

function isAttendanceButton(customId: string): boolean {
  return customId === componentIds.controlAttendance || customId.startsWith('attendance:') || customId.startsWith('leave:');
}

function isAttendanceModal(customId: string): boolean {
  return customId.startsWith('attendance:') || customId.startsWith('leave:');
}

function requireGuild(guild: Guild | null): Guild {
  if (guild === null) throw new ValidationError('ระบบเช็กชื่อใช้ได้เฉพาะใน Discord Server');
  return guild;
}

function entityId(customId: string, prefix: string): string {
  const id = customId.slice(prefix.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new ValidationError('รหัสรายการไม่ถูกต้อง');
  }
  return id;
}

function parseWeekdays(value: string): number[] {
  const values = value.split(',').map((item) => Number(item.trim()));
  if (values.some((item) => !Number.isInteger(item) || item < 1 || item > 7)) {
    throw new ValidationError('วันประจำต้องเป็นเลข 1–7 คั่นด้วย comma เช่น 1,2,3,4,5');
  }
  return values;
}

function isAttendanceResult(value: string | undefined): value is AttendanceResult {
  return value === 'PRESENT' || value === 'LEAVE' || value === 'EMERGENCY_LEAVE' || value === 'ABSENT';
}

function requireAttendanceMode(value: string | undefined): AttendanceMode {
  if (value !== 'AIRDROP' && value !== 'GENERAL') {
    throw new ValidationError('รูปแบบเช็กชื่อไม่ถูกต้อง');
  }
  return value;
}

function parseMinuteOffset(value: string, label: string): number {
  const normalized = value.trim();
  const minutes = Number(normalized);
  if (!/^\d{1,4}$/u.test(normalized) || !Number.isSafeInteger(minutes) || minutes < 0 || minutes > 1_440) {
    throw new ValidationError(`${label}ต้องเป็นจำนวนเต็มระหว่าง 0–1440`);
  }
  return minutes;
}

async function downloadAttendanceProof(attachment: Attachment): Promise<{ bytes: Buffer; sha256: string }> {
  const url = new URL(attachment.url);
  const allowedHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    throw new ValidationError('แหล่งที่มาของรูปหลักฐานไม่ถูกต้อง');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new ValidationError('ดาวน์โหลดรูปหลักฐานจาก Discord ไม่สำเร็จ กรุณาลองใหม่');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  validateAttendanceProof({ contentType: attachment.contentType, size: bytes.byteLength });
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function attendanceProofFilename(attachment: Attachment): string {
  const extensionByContentType: Readonly<Record<string, string>> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  return `attendance-proof-${attachment.id}.${extensionByContentType[attachment.contentType ?? ''] ?? 'image'}`;
}

function requireAttendanceChannels(settings: GuildSettings): void {
  if (settings.attendanceChannelId === null || settings.leaveChannelId === null) {
    throw new ValidationError('กรุณาตั้งค่า Channel เช็กชื่อและ Channel แจ้งลาก่อน');
  }
}

function requireLeaveChannels(settings: GuildSettings): void {
  if (settings.leaveChannelId === null || settings.leaveLogChannelId === null) {
    throw new ValidationError('กรุณาตั้งค่า Channel แจ้งลาและ Channel Log แจ้งลาก่อน');
  }
}

async function fetchSendableChannel(client: Client, channelId: string | null, label: string): Promise<SendableChannels> {
  if (channelId === null) throw new ValidationError(`กรุณาตั้งค่า ${label} ก่อน`);
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
    throw new ValidationError(`${label} ไม่ใช่ Text Channel ที่ Bot ส่งข้อความได้`);
  }
  return channel;
}
