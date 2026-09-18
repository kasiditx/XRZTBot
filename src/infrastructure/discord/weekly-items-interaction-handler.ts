import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import {
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { AuthorizationError, ValidationError } from '../../domain/errors.js';
import { formatLocalDateInput, parseDateInput } from '../../domain/temporal-input.js';
import { hasCapability, resolveAuthority, type AuthorityLevel, type Capability } from '../../modules/authorization/permissions.js';
import type { GuildConfigService } from '../../modules/guild-config/service.js';
import type { InventoryService } from '../../modules/inventory/service.js';
import type { MemberService } from '../../modules/members/service.js';
import { validateWeeklyPaymentImage } from '../../modules/weekly-dues/rules.js';
import { parseWeeklyItemRequirements } from '../../modules/weekly-items/rules.js';
import type { WeeklyItemMemberRule, WeeklyItemsService } from '../../modules/weekly-items/service.js';
import type { GuildSettings } from '../db/schema.js';
import { componentIds } from './components.js';
import type { DailyLogPublisher } from './daily-log-publisher.js';
import {
  buildEvidenceMethodPrompt,
  parseEvidenceModalContext,
  readEvidenceModalInput,
  requireEvidenceInputMode,
  resolveEvidenceImages,
  type EvidenceInputMode,
} from './evidence-images.js';
import { filterRoleVerifiedActiveMembers } from './role-verified-members.js';
import { buildNotice } from './theme.js';
import {
  buildCreateWeeklyItemsModal,
  buildPreparedWeeklyItemsProofLog,
  buildWeeklyItemsAdminPanel,
  buildWeeklyItemsAnnouncement,
  buildWeeklyItemsCancellationModal,
  buildWeeklyItemsManagement,
  buildWeeklyItemsMemberRuleModal,
  buildWeeklyItemsProofLog,
  buildWeeklyItemsProofModal,
  buildWeeklyItemsRejectionModal,
  weeklyItemsComponentIds,
} from './weekly-items-components.js';

export interface WeeklyItemsInteractionDependencies {
  readonly client: Client;
  readonly weeklyItems: WeeklyItemsService;
  readonly inventory: InventoryService;
  readonly guildConfig: GuildConfigService;
  readonly members: MemberService;
  readonly dailyLogs: DailyLogPublisher;
  readonly logger: pino.Logger;
}

export class WeeklyItemsInteractionHandler {
  public constructor(private readonly dependencies: WeeklyItemsInteractionDependencies) {}

  public async handle(interaction: Interaction): Promise<boolean> {
    if (interaction.isButton() && (interaction.customId === componentIds.controlWeeklyItems || interaction.customId.startsWith('weekly-items:'))) {
      await this.handleButton(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('weekly-items:')) {
      await this.handleSelect(interaction);
      return true;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('weekly-items:')) {
      await this.handleModal(interaction);
      return true;
    }
    return false;
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === componentIds.controlWeeklyItems) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await interaction.reply({
        ...buildWeeklyItemsAdminPanel(await this.dependencies.weeklyItems.list(guild.id)),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId === weeklyItemsComponentIds.adminCreate) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const [settings, items] = await Promise.all([
        this.requireSettings(guild.id),
        this.dependencies.inventory.listActiveItems(guild.id),
      ]);
      requireWeeklyItemsChannels(settings);
      if (items.length === 0) throw new ValidationError('ยังไม่มีรายการ Stock สำหรับสร้างรอบส่งของ');
      const startsOn = new Date();
      const endsOn = new Date(startsOn.getTime() + 6 * 86_400_000);
      await interaction.showModal(buildCreateWeeklyItemsModal(
        items,
        formatLocalDateInput(startsOn, settings.timezone),
        formatLocalDateInput(endsOn, settings.timezone),
      ));
      return;
    }
    if (interaction.customId.startsWith('weekly-items:submit:')) {
      await this.requireActiveMember(guild, interaction.user.id);
      const collectionId = entityId(interaction.customId, 'weekly-items:submit:');
      const obligation = await this.dependencies.weeklyItems.prepareSubmission(guild.id, collectionId, interaction.user.id);
      await interaction.reply({
        ...buildEvidenceMethodPrompt(
          `weekly-items:evidence_method:${collectionId}`,
          `หลักฐานส่งของครบ: ${obligation.items.map(({ item, quantity }) => `${item.itemName} ${quantity.toLocaleString('th-TH')}`).join(', ')}`,
        ),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId.startsWith('weekly-items:approve:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const view = await this.dependencies.weeklyItems.approveProof(
        guild.id,
        entityId(interaction.customId, 'weekly-items:approve:'),
        interaction.user.id,
        new Date(),
      );
      await interaction.message.edit(buildWeeklyItemsProofLog(view));
      await this.refreshCollection(guild.id, view.collection.id);
      await interaction.editReply(buildNotice('success', 'อนุมัติรับของแล้ว', 'เพิ่มของเข้า Stock และปิดปุ่มรายการนี้เรียบร้อย', 'Weekly Items'));
      return;
    }
    if (interaction.customId.startsWith('weekly-items:reject:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await interaction.showModal(buildWeeklyItemsRejectionModal(entityId(interaction.customId, 'weekly-items:reject:')));
      return;
    }
    if (interaction.customId.startsWith('weekly-items:member_rule:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const collectionId = entityId(interaction.customId, 'weekly-items:member_rule:');
      const [settings, view] = await Promise.all([
        this.requireSettings(guild.id),
        this.dependencies.weeklyItems.get(guild.id, collectionId),
      ]);
      const members = await filterRoleVerifiedActiveMembers(guild, settings, view.obligations.map(({ member }) => member));
      if (members.length === 0) throw new ValidationError('ไม่มีสมาชิกที่รับยศแล้วในรอบนี้');
      await interaction.showModal(buildWeeklyItemsMemberRuleModal(collectionId, members));
      return;
    }
    if (interaction.customId.startsWith('weekly-items:cancel:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await interaction.showModal(buildWeeklyItemsCancellationModal(entityId(interaction.customId, 'weekly-items:cancel:')));
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === weeklyItemsComponentIds.adminSelect) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const collectionId = interaction.values[0];
      if (collectionId === undefined) throw new ValidationError('กรุณาเลือกรอบส่งของ');
      await interaction.update({ ...buildWeeklyItemsManagement(await this.dependencies.weeklyItems.get(guild.id, collectionId)), content: null });
      return;
    }
    if (interaction.customId.startsWith('weekly-items:evidence_method:')) {
      await this.requireActiveMember(guild, interaction.user.id);
      const collectionId = entityId(interaction.customId, 'weekly-items:evidence_method:');
      await this.dependencies.weeklyItems.prepareSubmission(guild.id, collectionId, interaction.user.id);
      const mode = requireEvidenceInputMode(interaction.values[0]);
      await interaction.showModal(buildWeeklyItemsProofModal(collectionId, mode));
    }
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === 'weekly-items:create_modal') {
      await this.createCollection(interaction, guild);
      return;
    }
    if (interaction.customId.startsWith('weekly-items:submit_modal:')) {
      const context = parseEvidenceModalContext(interaction.customId, 'weekly-items:submit_modal:');
      await this.submitProof(interaction, guild, context.context, context.mode);
      return;
    }
    if (interaction.customId.startsWith('weekly-items:reject_modal:')) {
      await this.rejectProof(interaction, guild, entityId(interaction.customId, 'weekly-items:reject_modal:'));
      return;
    }
    if (interaction.customId.startsWith('weekly-items:member_rule_modal:')) {
      await this.setMemberRule(interaction, guild, entityId(interaction.customId, 'weekly-items:member_rule_modal:'));
      return;
    }
    if (interaction.customId.startsWith('weekly-items:cancel_modal:')) {
      await this.cancelCollection(interaction, guild, entityId(interaction.customId, 'weekly-items:cancel_modal:'));
    }
  }

  private async createCollection(interaction: ModalSubmitInteraction, guild: Guild): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const [settings, items] = await Promise.all([
      this.requireSettings(guild.id),
      this.dependencies.inventory.listActiveItems(guild.id),
    ]);
    requireWeeklyItemsChannels(settings);
    const startsOn = parseDateInput(interaction.fields.getTextInputValue(weeklyItemsComponentIds.createStartsOn), 'วันเริ่มรอบ');
    const endsOn = parseDateInput(interaction.fields.getTextInputValue(weeklyItemsComponentIds.createEndsOn), 'วันสิ้นสุดรอบ');
    const view = await this.dependencies.weeklyItems.create({
      guildId: guild.id,
      requestId: interaction.id,
      title: interaction.fields.getTextInputValue(weeklyItemsComponentIds.createTitle),
      startsOn,
      endsOn,
      requirements: parseWeeklyItemRequirements(
        interaction.fields.getTextInputValue(weeklyItemsComponentIds.createRequirements),
        items,
      ),
      timezone: settings.timezone,
      actorDiscordUserId: interaction.user.id,
      now: new Date(),
    });
    await interaction.editReply(buildNotice(
      'success',
      'สร้างรอบส่งของแล้ว',
      `📦 **${view.collection.title}**\nรายการของ: **${view.requirements.length.toString()} รายการ**\nสมาชิกในรอบ: **${view.obligations.length.toString()} คน**`,
      'Weekly Items',
    ));
  }

  private async submitProof(
    interaction: ModalSubmitInteraction,
    guild: Guild,
    collectionId: string,
    evidenceMode: EvidenceInputMode,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.requireActiveMember(guild, interaction.user.id);
    const settings = await this.requireSettings(guild.id);
    const channel = await fetchSendableChannel(
      this.dependencies.client,
      settings.weeklyItemsLogChannelId,
      'Channel รายการส่งของประจำสัปดาห์',
    );
    const evidence = readEvidenceModalInput(
      interaction.fields,
      evidenceMode,
      weeklyItemsComponentIds.proofFile,
      weeklyItemsComponentIds.proofMediaLink,
    );
    const [attachment] = await resolveEvidenceImages({
      mode: evidenceMode,
      ...evidence,
      maximumImages: 1,
      maximumBytesPerImage: 10 * 1_024 * 1_024,
      filenamePrefix: 'weekly-items-proof',
    });
    if (attachment === undefined) throw new ValidationError('ต้องส่งรูปหลักฐาน 1 รูป');
    validateWeeklyPaymentImage({ contentType: attachment.contentType, size: attachment.size });
    const obligation = await this.dependencies.weeklyItems.prepareSubmission(guild.id, collectionId, interaction.user.id);
    const collection = await this.dependencies.weeklyItems.get(guild.id, collectionId);
    const proofId = randomUUID();
    const logMessage = await this.dependencies.dailyLogs.send(channel, {
      guildId: guild.id,
      timezone: settings.timezone,
      message: {
        ...buildPreparedWeeklyItemsProofLog(proofId, collection.collection, obligation),
        files: [{ attachment: attachment.attachment, name: attachment.name }],
      },
    });
    try {
      const persistedAttachment = [...logMessage.attachments.values()][0];
      if (persistedAttachment === undefined) throw new Error('Discord did not persist the weekly item attachment');
      await this.dependencies.weeklyItems.persistProof({
        proofId,
        guildId: guild.id,
        collectionId,
        requestId: interaction.id,
        submittedByDiscordUserId: interaction.user.id,
        attachmentId: persistedAttachment.id,
        logChannelId: channel.id,
        logMessageId: logMessage.id,
        now: new Date(),
      });
    } catch (error: unknown) {
      await logMessage.delete().catch((deleteError: unknown) => {
        this.dependencies.logger.error({ err: deleteError, messageId: logMessage.id }, 'failed to remove orphan weekly item proof');
      });
      throw error;
    }
    await interaction.editReply(buildNotice('success', 'ส่งหลักฐานแล้ว', 'รายการครบตามยอดถูกส่งให้หัวแก๊ง/รองแก๊งตรวจสอบแล้ว', 'Weekly Items'));
  }

  private async rejectProof(interaction: ModalSubmitInteraction, guild: Guild, proofId: string): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const view = await this.dependencies.weeklyItems.rejectProof(
      guild.id,
      proofId,
      interaction.user.id,
      interaction.fields.getTextInputValue(weeklyItemsComponentIds.rejectionReason),
      new Date(),
    );
    await this.updateProofLog(view);
    await this.refreshCollection(guild.id, view.collection.id);
    await interaction.editReply(buildNotice('warning', 'ปฏิเสธหลักฐานแล้ว', 'สมาชิกสามารถส่งหลักฐานใหม่ได้ โดยต้องส่งครบตามยอดปัจจุบัน', 'Weekly Items'));
  }

  private async setMemberRule(interaction: ModalSubmitInteraction, guild: Guild, collectionId: string): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const memberId = interaction.fields.getStringSelectValues(weeklyItemsComponentIds.memberRuleMember)[0];
    if (memberId === undefined) throw new ValidationError('กรุณาเลือกสมาชิก');
    const rule = requireMemberRule(interaction.fields.getStringSelectValues(weeklyItemsComponentIds.memberRuleAction)[0]);
    const [settings, current] = await Promise.all([
      this.requireSettings(guild.id),
      this.dependencies.weeklyItems.get(guild.id, collectionId),
    ]);
    const verified = await filterRoleVerifiedActiveMembers(guild, settings, current.obligations.map(({ member }) => member));
    if (!verified.some((member) => member.discordUserId === memberId)) {
      throw new ValidationError('สมาชิกนี้ยังไม่ได้รับยศหรือไม่มีสถานะใช้งาน');
    }
    await this.dependencies.weeklyItems.setMemberRule(
      guild.id,
      collectionId,
      memberId,
      rule,
      interaction.fields.getTextInputValue(weeklyItemsComponentIds.memberRuleReason),
      interaction.user.id,
      new Date(),
    );
    await this.refreshCollection(guild.id, collectionId);
    await interaction.editReply(buildNotice(
      'success',
      rule === 'EXEMPT' ? 'ยกเว้นสมาชิกแล้ว' : 'กำหนดให้สมาชิกต้องส่งของแล้ว',
      `สมาชิก: <@${memberId}>`,
      'Weekly Items',
    ));
  }

  private async cancelCollection(interaction: ModalSubmitInteraction, guild: Guild, collectionId: string): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    await this.dependencies.weeklyItems.cancelCollection(
      guild.id,
      collectionId,
      interaction.user.id,
      interaction.fields.getTextInputValue(weeklyItemsComponentIds.cancellationReason),
      new Date(),
    );
    await this.refreshCollection(guild.id, collectionId);
    await interaction.editReply(buildNotice('warning', 'ยกเลิกรอบส่งของแล้ว', 'ปิดการส่งหลักฐานและหยุดค่าปรับรอบนี้เรียบร้อย', 'Weekly Items'));
  }

  private async updateProofLog(view: Awaited<ReturnType<WeeklyItemsService['getProof']>>): Promise<void> {
    const channel = await fetchSendableChannel(this.dependencies.client, view.proof.logChannelId, 'Channel รายการส่งของประจำสัปดาห์');
    const message = await channel.messages.fetch(view.proof.logMessageId).catch(() => null);
    if (message !== null) await message.edit(buildWeeklyItemsProofLog(view));
  }

  private async refreshCollection(guildId: string, collectionId: string): Promise<void> {
    const view = await this.dependencies.weeklyItems.get(guildId, collectionId);
    if (view.collection.publicChannelId === null || view.collection.publicMessageId === null) return;
    const channel = await fetchSendableChannel(this.dependencies.client, view.collection.publicChannelId, 'Channel ส่งของประจำสัปดาห์');
    const message = await channel.messages.fetch(view.collection.publicMessageId).catch(() => null);
    if (message !== null) await message.edit(buildWeeklyItemsAnnouncement(view));
  }

  private async requireCapability(guild: Guild, discordUserId: string, capability: Capability): Promise<AuthorityLevel> {
    const [settings, member] = await Promise.all([this.requireSettings(guild.id), guild.members.fetch(discordUserId)]);
    const authority = resolveMemberAuthority(member, settings);
    if (!hasCapability(authority, capability)) throw new AuthorizationError();
    return authority;
  }

  private async requireActiveMember(guild: Guild, discordUserId: string): Promise<void> {
    await this.requireCapability(guild, discordUserId, 'MEMBER_USE');
    const member = await this.dependencies.members.findByDiscordUserId(guild.id, discordUserId);
    if (member?.status !== 'ACTIVE') throw new AuthorizationError('ต้องเป็นสมาชิกสถานะใช้งานจึงใช้ระบบนี้ได้');
  }

  private async requireSettings(guildId: string): Promise<GuildSettings> {
    const settings = await this.dependencies.guildConfig.get(guildId);
    if (settings === null) throw new ValidationError('ยังไม่ได้สร้างการตั้งค่าของ Server นี้');
    return settings;
  }
}

function requireGuild(guild: Guild | null): Guild {
  if (guild === null) throw new ValidationError('คำสั่งนี้ใช้ได้เฉพาะใน Server');
  return guild;
}

function entityId(customId: string, prefix: string): string {
  const value = customId.slice(prefix.length);
  if (value.length === 0) throw new ValidationError('ข้อมูลรายการไม่ถูกต้อง');
  return value;
}

function requireMemberRule(value: string | undefined): WeeklyItemMemberRule {
  if (value !== 'REQUIRED' && value !== 'EXEMPT') throw new ValidationError('สถานะสมาชิกไม่ถูกต้อง');
  return value;
}

function resolveMemberAuthority(member: GuildMember, settings: GuildSettings): AuthorityLevel {
  const authority = resolveAuthority(new Set(member.roles.cache.keys()), settings);
  if (authority === null) throw new AuthorizationError();
  return authority;
}

function requireWeeklyItemsChannels(settings: GuildSettings): void {
  if (settings.weeklyItemsChannelId === null) throw new ValidationError('กรุณาตั้งค่า Channel ส่งของประจำสัปดาห์ก่อน');
  if (settings.weeklyItemsLogChannelId === null) throw new ValidationError('กรุณาตั้งค่า Channel รายการส่งของประจำสัปดาห์ก่อน');
}

async function fetchSendableChannel(client: Client, channelId: string | null, label: string): Promise<SendableChannels> {
  if (channelId === null) throw new ValidationError(`กรุณาตั้งค่า ${label} ก่อน`);
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
    throw new ValidationError(`${label} ไม่ใช่ Text Channel ที่ Bot ส่งข้อความได้`);
  }
  return channel;
}
