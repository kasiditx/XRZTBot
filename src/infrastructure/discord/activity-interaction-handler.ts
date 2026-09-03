import type pino from 'pino';
import {
  DiscordAPIError,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Guild,
  type Interaction,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { AuthorizationError, ValidationError } from '../../domain/errors.js';
import { formatDateTimeInput, parseDateTimeInput } from '../../domain/temporal-input.js';
import {
  hasCapability,
  resolveAuthority,
  type AuthorityLevel,
} from '../../modules/authorization/permissions.js';
import type { ActivityMode, ActivityService, SubmissionView } from '../../modules/activities/service.js';
import {
  parseScoreDefinitions,
  validateSubmissionImages,
} from '../../modules/activities/rules.js';
import type { GuildConfigService } from '../../modules/guild-config/service.js';
import type { MemberService } from '../../modules/members/service.js';
import type { GuildSettings } from '../db/schema.js';
import {
  activityComponentIds,
  activityCreateModalPrefix,
  buildActivityAdminPanel,
  buildActivityAnnouncement,
  buildActivityManagement,
  buildActivitySubmissionModal,
  buildActivityTypeSelector,
  buildCancelConfirmation,
  buildChangeSubmissionScoreModal,
  buildCreateActivityModal,
  buildLeaderboardEmbeds,
  buildParticipationSummaryEmbeds,
  buildParticipantEditModal,
  buildPreparedSubmissionLog,
  buildScoreAddModal,
  buildScoreEditModal,
  buildScoreSelector,
  buildSubmissionLog,
} from './activity-components.js';
import { componentIds } from './components.js';
import { buildNotice } from './theme.js';
import { filterRoleVerifiedActiveMembers } from './role-verified-members.js';
import {
  buildEvidenceMethodPrompt,
  parseEvidenceModalContext,
  readEvidenceModalInput,
  requireEvidenceInputMode,
  resolveEvidenceImages,
  type EvidenceInputMode,
} from './evidence-images.js';

const SUBMISSION_COOLDOWN_MS = 3_000;

export interface ActivityInteractionDependencies {
  readonly client: Client;
  readonly activities: ActivityService;
  readonly guildConfig: GuildConfigService;
  readonly members: MemberService;
  readonly logger: pino.Logger;
}

export class ActivityInteractionHandler {
  private readonly lastSubmissionAt = new Map<string, number>();

  public constructor(private readonly dependencies: ActivityInteractionDependencies) {}

  public async handle(interaction: Interaction): Promise<boolean> {
    if (interaction.isButton() && isActivityButton(interaction.customId)) {
      await this.handleButton(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && isActivitySelect(interaction.customId)) {
      await this.handleSelect(interaction);
      return true;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('activity:')) {
      await this.handleModal(interaction);
      return true;
    }
    return false;
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === componentIds.controlActivities) {
      await this.requireAdmin(guild, interaction.user.id);
      const current = await this.dependencies.activities.listForAdministration(guild.id);
      await interaction.reply({ ...buildActivityAdminPanel(current), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === activityComponentIds.adminCreate) {
      await this.requireAdmin(guild, interaction.user.id);
      await interaction.reply({ ...buildActivityTypeSelector(), flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.customId.startsWith('activity:score_add:')) {
      await this.requireAdmin(guild, interaction.user.id);
      await interaction.showModal(buildScoreAddModal(entityId(interaction.customId, 'activity:score_add:')));
      return;
    }
    if (interaction.customId.startsWith('activity:score_manage:')) {
      await this.requireAdmin(guild, interaction.user.id);
      const activityId = entityId(interaction.customId, 'activity:score_manage:');
      const activity = await this.dependencies.activities.getWithScores(guild.id, activityId, true);
      await interaction.reply({ ...buildScoreSelector(activityId, activity.scoreItems), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId.startsWith('activity:leaderboard:')) {
      const activityId = entityId(interaction.customId, 'activity:leaderboard:');
      await this.requireMemberOrAdmin(guild, interaction.user.id);
      const [{ activity }, rows] = await Promise.all([
        this.dependencies.activities.getWithScores(guild.id, activityId, true),
        this.dependencies.activities.buildLeaderboard(guild.id, activityId),
      ]);
      await interaction.reply({ embeds: buildLeaderboardEmbeds(activity, rows, activity.status === 'CLOSED'), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId.startsWith('activity:summary:')) {
      const activityId = entityId(interaction.customId, 'activity:summary:');
      await this.requireMemberOrAdmin(guild, interaction.user.id);
      const [{ activity }, summary] = await Promise.all([
        this.dependencies.activities.getWithScores(guild.id, activityId, true),
        this.dependencies.activities.buildParticipationSummary(guild.id, activityId),
      ]);
      await interaction.reply({ embeds: buildParticipationSummaryEmbeds(activity, summary, activity.status === 'CLOSED'), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId.startsWith('activity:submit:')) {
      await this.requireActiveMember(guild, interaction.user.id);
      enforceCooldown(this.lastSubmissionAt, `${guild.id}:${interaction.user.id}`);
      const activityId = entityId(interaction.customId, 'activity:submit:');
      await this.dependencies.activities.getWithScores(guild.id, activityId);
      await interaction.reply({
        ...buildEvidenceMethodPrompt(`activity:evidence_method:${activityId}`, 'ส่งหลักฐานกิจกรรม'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId.startsWith('activity:cancel_confirm:')) {
      const submissionId = entityId(interaction.customId, 'activity:cancel_confirm:');
      const isAdmin = await this.requireMemberOrAdmin(guild, interaction.user.id);
      const view = await this.dependencies.activities.cancelSubmission(guild.id, submissionId, interaction.user.id, isAdmin, new Date());
      await this.updateSubmissionLog(view);
      await interaction.update({ ...buildNotice('success', 'ยกเลิกรายการแล้ว', 'รายการนี้จะไม่ถูกนำไปคำนวณในผลสรุป', 'Activities'), components: [] });
      return;
    }
    if (interaction.customId.startsWith('activity:cancel:')) {
      const submissionId = entityId(interaction.customId, 'activity:cancel:');
      await this.assertSubmissionActor(guild, interaction.user.id, submissionId);
      await interaction.reply({ ...buildCancelConfirmation(submissionId), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId.startsWith('activity:participants:')) {
      const submissionId = entityId(interaction.customId, 'activity:participants:');
      const [, activeMembers] = await Promise.all([
        this.assertSubmissionActor(guild, interaction.user.id, submissionId),
        this.listRoleVerifiedActiveMembers(guild),
      ]);
      if (activeMembers.length === 0) {
        throw new ValidationError('ไม่มีสมาชิกที่อนุมัติและมีสถานะใช้งาน');
      }
      await interaction.showModal(buildParticipantEditModal(submissionId, activeMembers));
      return;
    }
    if (interaction.customId.startsWith('activity:submission_score:')) {
      const submissionId = entityId(interaction.customId, 'activity:submission_score:');
      await this.assertSubmissionActor(guild, interaction.user.id, submissionId);
      const view = await this.dependencies.activities.getSubmission(guild.id, submissionId);
      const { scoreItems } = await this.dependencies.activities.getWithScores(guild.id, view.activity.id);
      await interaction.showModal(buildChangeSubmissionScoreModal(submissionId, scoreItems));
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId.startsWith('activity:evidence_method:')) {
      await this.requireActiveMember(guild, interaction.user.id);
      enforceCooldown(this.lastSubmissionAt, `${guild.id}:${interaction.user.id}`);
      const activityId = entityId(interaction.customId, 'activity:evidence_method:');
      const [activity, activeMembers] = await Promise.all([
        this.dependencies.activities.getWithScores(guild.id, activityId),
        this.listRoleVerifiedActiveMembers(guild),
      ]);
      await interaction.showModal(buildActivitySubmissionModal(
        activity,
        activeMembers,
        requireEvidenceInputMode(requiredSelectedValue(interaction)),
      ));
      return;
    }
    if (interaction.customId === activityComponentIds.createMode) {
      await this.requireAdmin(guild, interaction.user.id);
      const settings = await this.requireSettings(guild.id);
      requireConfiguredActivityChannels(settings);
      const mode = requireActivityMode(requiredSelectedValue(interaction));
      const startsAt = new Date(Date.now() + 30 * 60 * 1_000);
      const endsAt = new Date(startsAt.getTime() + 4 * 60 * 60 * 1_000);
      await interaction.showModal(buildCreateActivityModal(
        mode,
        formatDateTimeInput(startsAt, settings.timezone),
        formatDateTimeInput(endsAt, settings.timezone),
      ));
      return;
    }
    if (interaction.customId === activityComponentIds.adminSelect) {
      await this.requireAdmin(guild, interaction.user.id);
      const activityId = requiredSelectedValue(interaction);
      const activity = await this.dependencies.activities.getWithScores(guild.id, activityId, true);
      await interaction.update({ ...buildActivityManagement(activity), content: null });
      return;
    }
    if (interaction.customId.startsWith('activity:score_select:')) {
      await this.requireAdmin(guild, interaction.user.id);
      const activityId = entityId(interaction.customId, 'activity:score_select:');
      const scoreId = requiredSelectedValue(interaction);
      const { scoreItems } = await this.dependencies.activities.getWithScores(guild.id, activityId, true);
      const score = scoreItems.find((item) => item.id === scoreId);
      if (score === undefined) {
        throw new ValidationError('ไม่พบรายการคะแนน');
      }
      await interaction.showModal(buildScoreEditModal(activityId, score));
    }
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId.startsWith(activityCreateModalPrefix)) {
      await this.createActivity(
        interaction,
        guild,
        requireActivityMode(interaction.customId.slice(activityCreateModalPrefix.length)),
      );
      return;
    }
    if (interaction.customId.startsWith('activity:score_add_modal:')) {
      await this.addScore(interaction, guild, entityId(interaction.customId, 'activity:score_add_modal:'));
      return;
    }
    if (interaction.customId.startsWith('activity:score_edit_modal:')) {
      await this.editScore(interaction, guild);
      return;
    }
    if (interaction.customId.startsWith('activity:submit_modal:')) {
      const evidence = parseEvidenceModalContext(interaction.customId, 'activity:submit_modal:');
      await this.submitActivity(interaction, guild, entityId(evidence.context, ''), evidence.mode);
      return;
    }
    if (interaction.customId.startsWith('activity:participants_modal:')) {
      await this.editParticipants(interaction, guild, entityId(interaction.customId, 'activity:participants_modal:'));
      return;
    }
    if (interaction.customId.startsWith('activity:change_score_modal:')) {
      await this.changeSubmissionScore(interaction, guild, entityId(interaction.customId, 'activity:change_score_modal:'));
    }
  }

  private async createActivity(interaction: ModalSubmitInteraction, guild: Guild, mode: ActivityMode): Promise<void> {
    await this.requireAdmin(guild, interaction.user.id);
    const settings = await this.requireSettings(guild.id);
    requireConfiguredActivityChannels(settings);
    const startsAt = parseDateTimeInput(
      interaction.fields.getTextInputValue(activityComponentIds.createStartsAt),
      settings.timezone,
      'วันเวลาเริ่ม',
    );
    const endsAt = parseDateTimeInput(
      interaction.fields.getTextInputValue(activityComponentIds.createEndsAt),
      settings.timezone,
      'วันเวลาปิด',
    );
    const result = await this.dependencies.activities.create({
      guildId: guild.id,
      requestId: interaction.id,
      title: interaction.fields.getTextInputValue(activityComponentIds.createTitle),
      details: interaction.fields.getTextInputValue(activityComponentIds.createDetails),
      startsAt,
      endsAt,
      mode,
      scoreItems: mode === 'SCORE'
        ? parseScoreDefinitions(interaction.fields.getTextInputValue(activityComponentIds.createScores))
        : [],
      actorDiscordUserId: interaction.user.id,
      now: new Date(),
    });
    await interaction.reply({ ...buildNotice('success', 'สร้างกิจกรรมแล้ว', `🏆 **${result.activity.title}**\nระบบจะประกาศ เปิด และปิดอัตโนมัติตามเวลาที่ตั้ง`, 'Activities'), flags: MessageFlags.Ephemeral });
  }

  private async addScore(interaction: ModalSubmitInteraction, guild: Guild, activityId: string): Promise<void> {
    await this.requireAdmin(guild, interaction.user.id);
    const score = await this.dependencies.activities.addScoreItem(
      guild.id,
      activityId,
      interaction.fields.getTextInputValue(activityComponentIds.scoreName),
      parsePoints(interaction.fields.getTextInputValue(activityComponentIds.scorePoints)),
      interaction.user.id,
    );
    await this.refreshAnnouncement(guild.id, activityId);
    await interaction.reply({ ...buildNotice('success', 'เพิ่มรายการคะแนนแล้ว', `**${score.name}** • ${score.points.toLocaleString('th-TH')} คะแนน`, 'Activities'), flags: MessageFlags.Ephemeral });
  }

  private async editScore(interaction: ModalSubmitInteraction, guild: Guild): Promise<void> {
    await this.requireAdmin(guild, interaction.user.id);
    const ids = parseTwoEntityIds(interaction.customId, 'activity:score_edit_modal:');
    const status = interaction.fields.getTextInputValue(activityComponentIds.scoreActive).trim().toUpperCase();
    if (status !== 'ON' && status !== 'OFF') {
      throw new ValidationError('สถานะรายการคะแนนต้องเป็น ON หรือ OFF');
    }
    const score = await this.dependencies.activities.updateScoreItem(
      guild.id,
      ids.first,
      ids.second,
      interaction.fields.getTextInputValue(activityComponentIds.scoreName),
      parsePoints(interaction.fields.getTextInputValue(activityComponentIds.scorePoints)),
      status === 'ON',
      interaction.user.id,
    );
    await this.refreshAnnouncement(guild.id, ids.first);
    await interaction.reply({ ...buildNotice('success', 'อัปเดตรายการคะแนนแล้ว', `**${score.name}**\nSubmission เดิมถูกคำนวณใหม่อัตโนมัติ`, 'Activities'), flags: MessageFlags.Ephemeral });
  }

  private async submitActivity(
    interaction: ModalSubmitInteraction,
    guild: Guild,
    activityId: string,
    evidenceMode: EvidenceInputMode,
  ): Promise<void> {
    await this.requireActiveMember(guild, interaction.user.id);
    const cooldownKey = `${guild.id}:${interaction.user.id}`;
    enforceCooldown(this.lastSubmissionAt, cooldownKey);
    reserveCooldown(this.lastSubmissionAt, cooldownKey);
    try {
      const evidenceInput = readEvidenceModalInput(
        interaction.fields,
        evidenceMode,
        activityComponentIds.submitFiles,
        activityComponentIds.submitMediaLinks,
      );
      const activity = await this.dependencies.activities.getWithScores(guild.id, activityId);
      const scoreItemId = activity.activity.mode === 'SCORE'
        ? interaction.fields.getStringSelectValues(activityComponentIds.submitScore)[0] ?? null
        : null;
      if (activity.activity.mode === 'SCORE' && scoreItemId === null) {
        throw new ValidationError('กรุณาเลือกรายการคะแนน');
      }
      const participantIds = selectedStringValuesByPrefix(interaction, activityComponentIds.submitParticipants);
      const note = interaction.fields.getTextInputValue(activityComponentIds.submitNote);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const evidenceImages = await resolveEvidenceImages({
        mode: evidenceMode,
        ...evidenceInput,
        maximumImages: 5,
        maximumBytesPerImage: 10 * 1_024 * 1_024,
        filenamePrefix: 'activity-proof',
      });
      validateSubmissionImages(evidenceImages.map((image) => ({ contentType: image.contentType, size: image.size })));
      const [settings, prepared] = await Promise.all([
        this.requireSettings(guild.id),
        this.dependencies.activities.prepareSubmission({
          guildId: guild.id,
          activityId,
          scoreItemId,
          submitterDiscordUserId: interaction.user.id,
          participantDiscordUserIds: participantIds,
          note,
          now: new Date(),
        }),
      ]);
      const logChannel = await fetchSendableChannel(this.dependencies.client, settings.activityLogChannelId, 'Channel Log กิจกรรม');

      const logMessage = await logChannel.send({
        ...buildPreparedSubmissionLog(prepared),
        files: evidenceImages.map(({ attachment, name }) => ({ attachment, name })),
      });
      try {
        const attachmentIds = [...logMessage.attachments.keys()];
        if (attachmentIds.length !== evidenceImages.length) {
          throw new Error('Discord did not persist every activity attachment');
        }
        await this.dependencies.activities.persistSubmission({
          prepared,
          requestId: interaction.id,
          attachmentIds,
          logChannelId: logChannel.id,
          logMessageId: logMessage.id,
          now: new Date(),
        });
      } catch (error: unknown) {
        await logMessage.delete().catch((deleteError: unknown) => {
          this.dependencies.logger.error({ err: deleteError, messageId: logMessage.id }, 'failed to remove orphan activity log');
        });
        throw error;
      }
      await interaction.editReply(buildNotice('success', 'ส่งผลงานกิจกรรมแล้ว', `🏆 **${prepared.activity.title}**\nผู้ร่วมกิจกรรม: **${String(prepared.participants.length)} คน**`, 'Activities'));
    } catch (error: unknown) {
      this.lastSubmissionAt.delete(cooldownKey);
      throw error;
    }
  }

  private async editParticipants(interaction: ModalSubmitInteraction, guild: Guild, submissionId: string): Promise<void> {
    const isAdmin = await this.requireMemberOrAdmin(guild, interaction.user.id);
    const operation = interaction.fields.getStringSelectValues(activityComponentIds.participantOperation)[0];
    if (operation !== 'ADD' && operation !== 'REMOVE') {
      throw new ValidationError('การแก้ไขผู้ร่วมไม่ถูกต้อง');
    }
    const userIds = selectedStringValuesByPrefix(interaction, activityComponentIds.participantUsers);
    const view = await this.dependencies.activities.editParticipants(
      guild.id,
      submissionId,
      interaction.user.id,
      isAdmin,
      operation,
      userIds,
      new Date(),
    );
    await this.updateSubmissionLog(view);
    await interaction.reply({ ...buildNotice('success', 'อัปเดตผู้ร่วมแล้ว', `ผู้ร่วมปัจจุบัน **${String(view.participants.length)} คน**`, 'Activities'), flags: MessageFlags.Ephemeral });
  }

  private async changeSubmissionScore(interaction: ModalSubmitInteraction, guild: Guild, submissionId: string): Promise<void> {
    const isAdmin = await this.requireMemberOrAdmin(guild, interaction.user.id);
    const scoreItemId = interaction.fields.getStringSelectValues(activityComponentIds.changeScore)[0];
    if (scoreItemId === undefined) {
      throw new ValidationError('กรุณาเลือกรายการคะแนน');
    }
    const view = await this.dependencies.activities.changeSubmissionScore(
      guild.id,
      submissionId,
      scoreItemId,
      interaction.user.id,
      isAdmin,
      new Date(),
    );
    if (view.scoreItem === null) {
      throw new ValidationError('รายการนี้ไม่มีคะแนนให้เปลี่ยน');
    }
    await this.updateSubmissionLog(view);
    await interaction.reply({ ...buildNotice('success', 'เปลี่ยนรายการคะแนนแล้ว', `**${view.scoreItem.name}** • ${view.scoreItem.points.toLocaleString('th-TH')} คะแนน`, 'Activities'), flags: MessageFlags.Ephemeral });
  }

  private async assertSubmissionActor(guild: Guild, discordUserId: string, submissionId: string): Promise<void> {
    const [view, isAdmin] = await Promise.all([
      this.dependencies.activities.getSubmission(guild.id, submissionId),
      this.requireMemberOrAdmin(guild, discordUserId),
    ]);
    if (!isAdmin && view.submitter.discordUserId !== discordUserId) {
      throw new AuthorizationError('ปุ่มนี้กดได้เฉพาะผู้ส่งรายการหรือหัวแก๊ง/รองแก๊ง');
    }
  }

  private async requireAdmin(guild: Guild, discordUserId: string): Promise<void> {
    const authority = await this.resolveCurrentAuthority(guild, discordUserId);
    if (!hasCapability(authority, 'ROUTINE_ADMIN')) {
      throw new AuthorizationError();
    }
  }

  private async requireActiveMember(guild: Guild, discordUserId: string): Promise<void> {
    const [authority, member] = await Promise.all([
      this.resolveCurrentAuthority(guild, discordUserId),
      this.dependencies.members.findByDiscordUserId(guild.id, discordUserId),
    ]);
    if (!hasCapability(authority, 'MEMBER_USE') || member?.status !== 'ACTIVE') {
      throw new AuthorizationError('ต้องมี Role สมาชิกและสถานะสมาชิกใช้งานจึงใช้ระบบกิจกรรมได้');
    }
  }

  private async requireMemberOrAdmin(guild: Guild, discordUserId: string): Promise<boolean> {
    const authority = await this.resolveCurrentAuthority(guild, discordUserId);
    const isAdmin = hasCapability(authority, 'ROUTINE_ADMIN');
    if (!isAdmin) {
      await this.requireActiveMember(guild, discordUserId);
    }
    return isAdmin;
  }

  private async resolveCurrentAuthority(guild: Guild, discordUserId: string): Promise<AuthorityLevel> {
    const [settings, discordMember] = await Promise.all([
      this.requireSettings(guild.id),
      guild.members.fetch(discordUserId),
    ]);
    const authority = resolveAuthority(new Set(discordMember.roles.cache.keys()), {
      devRoleId: settings.devRoleId,
      headRoleId: settings.headRoleId,
      deputyRoleId: settings.deputyRoleId,
      activeMemberRoleId: settings.activeMemberRoleId,
    });
    if (authority === null) {
      throw new AuthorizationError();
    }
    return authority;
  }

  private async requireSettings(guildId: string): Promise<GuildSettings> {
    const settings = await this.dependencies.guildConfig.get(guildId);
    if (settings === null) {
      throw new ValidationError('ยังไม่ได้ตั้งค่า Server');
    }
    return settings;
  }

  private async listRoleVerifiedActiveMembers(guild: Guild) {
    const [settings, members] = await Promise.all([
      this.requireSettings(guild.id),
      this.dependencies.members.listActive(guild.id),
    ]);
    return filterRoleVerifiedActiveMembers(guild, settings, members);
  }

  private async updateSubmissionLog(view: SubmissionView): Promise<void> {
    if (view.submission.logMessageId === null) {
      throw new ValidationError('รายการนี้ไม่มี Discord log message');
    }
    const channel = await fetchSendableChannel(this.dependencies.client, view.submission.logChannelId, 'Channel Log กิจกรรม');
    const message = await channel.messages.fetch(view.submission.logMessageId);
    await message.edit(buildSubmissionLog(view));
  }

  private async refreshAnnouncement(guildId: string, activityId: string): Promise<void> {
    const activity = await this.dependencies.activities.getWithScores(guildId, activityId, true);
    if (activity.activity.announcementChannelId === null || activity.activity.announcementMessageId === null) {
      return;
    }
    const channel = await fetchSendableChannel(this.dependencies.client, activity.activity.announcementChannelId, 'Channel กิจกรรม');
    const message = await channel.messages.fetch(activity.activity.announcementMessageId);
    await message.edit(buildActivityAnnouncement(activity, activity.activity.status === 'CLOSED'));
  }
}

function requireActivityMode(value: string | undefined): ActivityMode {
  if (value !== 'SCORE' && value !== 'EVIDENCE' && value !== 'ANNOUNCEMENT') {
    throw new ValidationError('รูปแบบกิจกรรมไม่ถูกต้อง');
  }
  return value;
}

function isActivityButton(customId: string): boolean {
  return customId === componentIds.controlActivities || customId.startsWith('activity:');
}

function isActivitySelect(customId: string): boolean {
  return customId.startsWith('activity:');
}

function requireGuild(guild: Guild | null): Guild {
  if (guild === null) {
    throw new ValidationError('ระบบกิจกรรมใช้ได้เฉพาะใน Discord Server');
  }
  return guild;
}

function entityId(customId: string, prefix: string): string {
  const id = customId.slice(prefix.length);
  if (!isUuid(id)) {
    throw new ValidationError('รหัสรายการไม่ถูกต้อง');
  }
  return id;
}

function parseTwoEntityIds(customId: string, prefix: string): { first: string; second: string } {
  const values = customId.slice(prefix.length).split(':');
  if (values.length !== 2 || !isUuid(values[0] ?? '') || !isUuid(values[1] ?? '')) {
    throw new ValidationError('รหัสรายการคะแนนไม่ถูกต้อง');
  }
  return { first: values[0]!, second: values[1]! };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function requiredSelectedValue(interaction: StringSelectMenuInteraction): string {
  const value = interaction.values[0];
  if (value === undefined) {
    throw new ValidationError('กรุณาเลือกรายการ');
  }
  return value;
}

function selectedStringValuesByPrefix(interaction: ModalSubmitInteraction, customIdPrefix: string): string[] {
  return [...interaction.fields.fields.keys()]
    .filter((customId) => customId === customIdPrefix || customId.startsWith(`${customIdPrefix}:`))
    .flatMap((customId) => interaction.fields.getStringSelectValues(customId));
}

function parsePoints(value: string): number {
  const points = Number(value.trim());
  if (!Number.isSafeInteger(points) || points < 0 || points > 1_000_000_000) {
    throw new ValidationError('คะแนนต้องเป็นจำนวนเต็ม 0–1,000,000,000');
  }
  return points;
}

function enforceCooldown(cooldowns: ReadonlyMap<string, number>, key: string): void {
  const previous = cooldowns.get(key);
  if (previous !== undefined) {
    const remaining = SUBMISSION_COOLDOWN_MS - (Date.now() - previous);
    if (remaining > 0) {
      throw new ValidationError(`กรุณารอ ${String(Math.ceil(remaining / 1_000))} วินาทีก่อนส่งกิจกรรมอีกครั้ง`);
    }
  }
}

function reserveCooldown(cooldowns: Map<string, number>, key: string): void {
  const reservedAt = Date.now();
  cooldowns.set(key, reservedAt);
  const timer = setTimeout(() => {
    if (cooldowns.get(key) === reservedAt) {
      cooldowns.delete(key);
    }
  }, SUBMISSION_COOLDOWN_MS);
  timer.unref();
}

async function fetchSendableChannel(client: Client, channelId: string | null, label: string): Promise<SendableChannels> {
  if (channelId === null) {
    throw new ValidationError(`กรุณาตั้งค่า ${label} ก่อน`);
  }
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (error: unknown) {
    if (error instanceof DiscordAPIError && (error.code === 50_001 || error.code === 50_013)) {
      throw new ValidationError(
        `Bot เข้าใช้ ${label} ไม่ได้ กรุณาอนุญาต View Channel, Send Messages, Embed Links, Attach Files และ Read Message History`,
      );
    }
    throw error;
  }
  if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
    throw new ValidationError(`${label} ไม่ใช่ Text Channel ที่ Bot ส่งข้อความได้`);
  }
  return channel;
}

function requireConfiguredActivityChannels(settings: GuildSettings): void {
  if (settings.activityChannelId === null || settings.activityLogChannelId === null) {
    throw new ValidationError('กรุณาตั้งค่า Channel กิจกรรมและ Channel Log กิจกรรมก่อนสร้างกิจกรรม');
  }
}
