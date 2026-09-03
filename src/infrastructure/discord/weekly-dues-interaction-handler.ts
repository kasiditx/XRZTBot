import type pino from 'pino';
import {
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
import { formatDateInput, formatLocalDateInput, parseDateInput } from '../../domain/temporal-input.js';
import { hasCapability, resolveAuthority, type AuthorityLevel, type Capability } from '../../modules/authorization/permissions.js';
import type { GuildConfigService } from '../../modules/guild-config/service.js';
import type { MemberService } from '../../modules/members/service.js';
import { validateWeeklyPaymentImage } from '../../modules/weekly-dues/rules.js';
import type { WeeklyDuesService, WeeklyPaymentProofView } from '../../modules/weekly-dues/service.js';
import type { GuildSettings } from '../db/schema.js';
import { componentIds } from './components.js';
import {
  buildCreateWeeklyModal,
  buildPreparedWeeklyProofLog,
  buildWeeklyAdminPanel,
  buildWeeklyManagement,
  buildWeeklyOverrideModal,
  buildWeeklyPaymentModal,
  buildWeeklyProofLog,
  buildWeeklyRejectionModal,
  weeklyComponentIds,
  weeklyCreateModalId,
} from './weekly-dues-components.js';
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

export interface WeeklyDuesInteractionDependencies {
  readonly client: Client;
  readonly weeklyDues: WeeklyDuesService;
  readonly guildConfig: GuildConfigService;
  readonly members: MemberService;
  readonly logger: pino.Logger;
}

export class WeeklyDuesInteractionHandler {
  public constructor(private readonly dependencies: WeeklyDuesInteractionDependencies) {}

  public async handle(interaction: Interaction): Promise<boolean> {
    if (interaction.isButton() && (interaction.customId === componentIds.controlWeekly || interaction.customId.startsWith('weekly:'))) {
      await this.handleButton(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('weekly:')) {
      await this.handleSelect(interaction);
      return true;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('weekly:')) {
      await this.handleModal(interaction);
      return true;
    }
    return false;
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === componentIds.controlWeekly) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await interaction.reply({ ...buildWeeklyAdminPanel(await this.dependencies.weeklyDues.list(guild.id)), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === weeklyComponentIds.adminCreate) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const settings = await this.requireSettings(guild.id);
      requireWeeklyChannel(settings);
      const startsOn = new Date();
      const endsOn = new Date(startsOn.getTime() + 6 * 24 * 60 * 60 * 1_000);
      await interaction.showModal(buildCreateWeeklyModal(
        formatLocalDateInput(startsOn, settings.timezone),
        formatLocalDateInput(endsOn, settings.timezone),
      ));
      return;
    }
    if (interaction.customId.startsWith('weekly:pay:')) {
      await this.requireActiveMember(guild, interaction.user.id);
      const view = await this.dependencies.weeklyDues.get(guild.id, entityId(interaction.customId, 'weekly:pay:'));
      const own = view.obligations.find(({ member }) => member.discordUserId === interaction.user.id);
      if (own === undefined) throw new AuthorizationError('คุณไม่มีรายการเรียกเก็บในรอบนี้');
      await interaction.reply({
        ...buildEvidenceMethodPrompt(`weekly:evidence_method:${view.collection.id}`, 'หลักฐานส่งเงินรายสัปดาห์'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId.startsWith('weekly:approve:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const view = await this.dependencies.weeklyDues.approvePayment(guild.id, entityId(interaction.customId, 'weekly:approve:'), interaction.user.id, new Date());
      await interaction.update(buildWeeklyProofLog(view));
      return;
    }
    if (interaction.customId.startsWith('weekly:reject:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await interaction.showModal(buildWeeklyRejectionModal(entityId(interaction.customId, 'weekly:reject:')));
      return;
    }
    if (interaction.customId.startsWith('weekly:override:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const collectionId = entityId(interaction.customId, 'weekly:override:');
      const [settings, view] = await Promise.all([
        this.requireSettings(guild.id),
        this.dependencies.weeklyDues.get(guild.id, collectionId),
      ]);
      const members = await filterRoleVerifiedActiveMembers(
        guild,
        settings,
        view.obligations.map(({ member }) => member),
      );
      if (members.length === 0) throw new ValidationError('ไม่มีสมาชิกที่รับยศแล้วในรอบนี้');
      await interaction.showModal(buildWeeklyOverrideModal(collectionId, members));
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId.startsWith('weekly:evidence_method:')) {
      await this.requireActiveMember(guild, interaction.user.id);
      const collectionId = entityId(interaction.customId, 'weekly:evidence_method:');
      const view = await this.dependencies.weeklyDues.get(guild.id, collectionId);
      const own = view.obligations.find(({ member }) => member.discordUserId === interaction.user.id);
      if (own === undefined) throw new AuthorizationError('คุณไม่มีรายการเรียกเก็บในรอบนี้');
      await interaction.showModal(buildWeeklyPaymentModal(
        view,
        own.obligation.amount,
        requireEvidenceInputMode(interaction.values[0]),
      ));
      return;
    }
    if (interaction.customId !== weeklyComponentIds.adminSelect) return;
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const collectionId = interaction.values[0];
    if (collectionId === undefined) throw new ValidationError('กรุณาเลือกรอบส่งเงิน');
    await interaction.update({ ...buildWeeklyManagement(await this.dependencies.weeklyDues.get(guild.id, collectionId)), content: null });
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === weeklyCreateModalId) {
      await this.createCollection(interaction, guild);
      return;
    }
    if (interaction.customId.startsWith('weekly:pay_modal:')) {
      const evidence = parseEvidenceModalContext(interaction.customId, 'weekly:pay_modal:');
      await this.submitPayment(interaction, guild, entityId(evidence.context, ''), evidence.mode);
      return;
    }
    if (interaction.customId.startsWith('weekly:reject_modal:')) {
      await this.rejectPayment(interaction, guild, entityId(interaction.customId, 'weekly:reject_modal:'));
      return;
    }
    if (interaction.customId.startsWith('weekly:override_modal:')) {
      await this.overrideAmount(interaction, guild, entityId(interaction.customId, 'weekly:override_modal:'));
    }
  }

  private async createCollection(interaction: ModalSubmitInteraction, guild: Guild): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const settings = await this.requireSettings(guild.id);
    requireWeeklyChannel(settings);
    const startsOn = parseDateInput(
      interaction.fields.getTextInputValue(weeklyComponentIds.createStartsOn),
      'วันเริ่มรอบ',
    );
    const endsOn = parseDateInput(
      interaction.fields.getTextInputValue(weeklyComponentIds.createEndsOn),
      'วันสิ้นสุดรอบ',
    );
    const view = await this.dependencies.weeklyDues.create({
      guildId: guild.id,
      requestId: interaction.id,
      title: `ส่งเงินประจำสัปดาห์ ${formatDateInput(startsOn)} – ${formatDateInput(endsOn)}`,
      startsOn,
      endsOn,
      standardAmount: parseMoney(interaction.fields.getTextInputValue(weeklyComponentIds.createAmount), false),
      overdueFineAmount: parseMoney(interaction.fields.getTextInputValue(weeklyComponentIds.createInitialFine), true),
      recurringFineAmount: parseMoney(interaction.fields.getTextInputValue(weeklyComponentIds.createRecurringFine), true),
      timezone: settings.timezone,
      actorDiscordUserId: interaction.user.id,
      now: new Date(),
    });
    await interaction.reply({ ...buildNotice('success', 'สร้างรอบส่งเงินแล้ว', `🗓️ **${view.collection.title}**\nสมาชิกที่ต้องส่ง: **${view.obligations.length.toString()} คน**`, 'Weekly Dues'), flags: MessageFlags.Ephemeral });
  }

  private async submitPayment(
    interaction: ModalSubmitInteraction,
    guild: Guild,
    collectionId: string,
    evidenceMode: EvidenceInputMode,
  ): Promise<void> {
    await this.requireActiveMember(guild, interaction.user.id);
    const settings = await this.requireSettings(guild.id);
    const channel = await fetchSendableChannel(
      this.dependencies.client,
      settings.weeklyDuesLogChannelId,
      'Channel Log ส่งเงินรายสัปดาห์',
    );
    const evidenceInput = readEvidenceModalInput(
      interaction.fields,
      evidenceMode,
      weeklyComponentIds.paymentFile,
      weeklyComponentIds.paymentMediaLink,
    );
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [attachment] = await resolveEvidenceImages({
      mode: evidenceMode,
      ...evidenceInput,
      maximumImages: 1,
      maximumBytesPerImage: 10 * 1_024 * 1_024,
      filenamePrefix: 'weekly-proof',
    });
    if (attachment === undefined) throw new ValidationError('ต้องส่งรูปหลักฐาน 1 รูป');
    validateWeeklyPaymentImage({ contentType: attachment.contentType, size: attachment.size });
    const prepared = await this.dependencies.weeklyDues.preparePayment(
      guild.id,
      collectionId,
      interaction.user.id,
      parseMoney(interaction.fields.getTextInputValue(weeklyComponentIds.paymentAmount), false),
      new Date(),
    );

    const logMessage = await channel.send({
      ...buildPreparedWeeklyProofLog(prepared),
      files: [{ attachment: attachment.attachment, name: attachment.name }],
    });
    try {
      const persistedAttachment = [...logMessage.attachments.values()][0];
      if (persistedAttachment === undefined) throw new Error('Discord did not persist the weekly payment attachment');
      await this.dependencies.weeklyDues.persistPayment({
        prepared,
        requestId: interaction.id,
        submittedByDiscordUserId: interaction.user.id,
        attachmentId: persistedAttachment.id,
        logChannelId: channel.id,
        logMessageId: logMessage.id,
        now: new Date(),
      });
    } catch (error: unknown) {
      await logMessage.delete().catch((deleteError: unknown) => {
        this.dependencies.logger.error({ err: deleteError, messageId: logMessage.id }, 'failed to remove orphan weekly payment proof');
      });
      throw error;
    }
    await interaction.editReply(buildNotice('success', 'ส่งหลักฐานแล้ว', 'กรุณารอหัวแก๊ง/รองแก๊งตรวจสอบและยืนยันยอดเงิน', 'Weekly Dues'));
  }

  private async rejectPayment(interaction: ModalSubmitInteraction, guild: Guild, proofId: string): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const view = await this.dependencies.weeklyDues.rejectPayment(
      guild.id,
      proofId,
      interaction.user.id,
      interaction.fields.getTextInputValue(weeklyComponentIds.rejectionReason),
      new Date(),
    );
    await this.updateProofLog(view);
    await interaction.reply({ ...buildNotice('warning', 'ปฏิเสธหลักฐานแล้ว', 'หากพ้นกำหนด ระบบจะสร้างค่าปรับตามเงื่อนไขทันที', 'Weekly Dues'), flags: MessageFlags.Ephemeral });
  }

  private async overrideAmount(interaction: ModalSubmitInteraction, guild: Guild, collectionId: string): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const memberId = interaction.fields.getStringSelectValues(weeklyComponentIds.overrideMember)[0];
    if (memberId === undefined) throw new ValidationError('กรุณาเลือกสมาชิก');
    const [settings, view] = await Promise.all([
      this.requireSettings(guild.id),
      this.dependencies.weeklyDues.get(guild.id, collectionId),
    ]);
    const members = await filterRoleVerifiedActiveMembers(
      guild,
      settings,
      view.obligations.map(({ member }) => member),
    );
    if (!members.some((member) => member.discordUserId === memberId)) {
      throw new ValidationError('สมาชิกนี้ยังไม่ได้รับยศหรือไม่มีสถานะใช้งาน');
    }
    await this.dependencies.weeklyDues.overrideAmount(
      guild.id,
      collectionId,
      memberId,
      parseMoney(interaction.fields.getTextInputValue(weeklyComponentIds.overrideAmount), false),
      interaction.user.id,
      new Date(),
    );
    await interaction.reply({ ...buildNotice('success', 'บันทึกยอดเฉพาะสมาชิกแล้ว', `สมาชิก: <@${memberId}>`, 'Weekly Dues'), flags: MessageFlags.Ephemeral });
  }

  private async updateProofLog(view: WeeklyPaymentProofView): Promise<void> {
    const channel = await fetchSendableChannel(this.dependencies.client, view.proof.logChannelId, 'Channel Log ส่งเงินรายสัปดาห์');
    const message = await channel.messages.fetch(view.proof.logMessageId);
    await message.edit(buildWeeklyProofLog(view));
  }

  private async requireActiveMember(guild: Guild, discordUserId: string): Promise<void> {
    const [authority, member] = await Promise.all([
      this.resolveCurrentAuthority(guild, discordUserId),
      this.dependencies.members.findByDiscordUserId(guild.id, discordUserId),
    ]);
    if (!hasCapability(authority, 'MEMBER_USE') || member?.status !== 'ACTIVE') {
      throw new AuthorizationError('ต้องมี Role สมาชิกและสถานะสมาชิกใช้งานจึงส่งหลักฐานได้');
    }
  }

  private async requireCapability(guild: Guild, discordUserId: string, capability: Capability): Promise<void> {
    const authority = await this.resolveCurrentAuthority(guild, discordUserId);
    if (!hasCapability(authority, capability)) throw new AuthorizationError();
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
}

function requireGuild(guild: Guild | null): Guild {
  if (guild === null) throw new ValidationError('ระบบส่งเงินรายสัปดาห์ใช้ได้เฉพาะใน Discord Server');
  return guild;
}

function entityId(customId: string, prefix: string): string {
  const id = customId.slice(prefix.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new ValidationError('รหัสรายการไม่ถูกต้อง');
  }
  return id;
}

function parseMoney(value: string, allowZero: boolean): number {
  const normalized = value.trim().replaceAll(',', '');
  const amount = Number(normalized);
  const minimum = allowZero ? 0 : 1;
  if (!/^\d+$/u.test(normalized) || !Number.isSafeInteger(amount) || amount < minimum) {
    throw new ValidationError(`จำนวนเงินต้องเป็นจำนวนเต็มตั้งแต่ ${String(minimum)} ขึ้นไป`);
  }
  return amount;
}

function requireWeeklyChannel(settings: GuildSettings): void {
  if (settings.weeklyDuesChannelId === null) throw new ValidationError('กรุณาตั้งค่า Channel ส่งเงินรายสัปดาห์ก่อน');
}

async function fetchSendableChannel(client: Client, channelId: string | null, label: string): Promise<SendableChannels> {
  if (channelId === null) throw new ValidationError(`กรุณาตั้งค่า ${label} ก่อน`);
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
    throw new ValidationError(`${label} ไม่ใช่ Text Channel ที่ Bot ส่งข้อความได้`);
  }
  return channel;
}
