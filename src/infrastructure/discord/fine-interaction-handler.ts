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
import { formatDateTimeInput, parseDateTimeInput } from '../../domain/temporal-input.js';
import {
  hasCapability,
  resolveAuthority,
  type AuthorityLevel,
  type Capability,
} from '../../modules/authorization/permissions.js';
import type { FinePaymentProofView, FineService } from '../../modules/fines/service.js';
import { validateFinePaymentImage } from '../../modules/fines/rules.js';
import type { GuildConfigService } from '../../modules/guild-config/service.js';
import type { MemberService } from '../../modules/members/service.js';
import type { GuildSettings } from '../db/schema.js';
import { componentIds } from './components.js';
import {
  buildCreateFineModal,
  buildFineAdminPanel,
  buildFineAnnouncement,
  buildFineCancellationModal,
  buildFineManagement,
  buildFinePaymentModal,
  buildFineProofLog,
  buildFineRejectionModal,
  buildPreparedFineProofLog,
  fineComponentIds,
  fineCreateModalId,
} from './fine-components.js';
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

export interface FineInteractionDependencies {
  readonly client: Client;
  readonly fines: FineService;
  readonly guildConfig: GuildConfigService;
  readonly members: MemberService;
  readonly logger: pino.Logger;
}

export class FineInteractionHandler {
  public constructor(private readonly dependencies: FineInteractionDependencies) {}

  public async handle(interaction: Interaction): Promise<boolean> {
    if (interaction.isButton() && isFineButton(interaction.customId)) {
      await this.handleButton(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('fine:')) {
      await this.handleSelect(interaction);
      return true;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('fine:')) {
      await this.handleModal(interaction);
      return true;
    }
    return false;
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === componentIds.controlFinance) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const values = await this.dependencies.fines.list(guild.id);
      await interaction.reply({ ...buildFineAdminPanel(values), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === fineComponentIds.adminCreate) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const settings = await this.requireSettings(guild.id);
      requireFineChannel(settings);
      const members = await filterRoleVerifiedActiveMembers(
        guild,
        settings,
        await this.dependencies.members.listActive(guild.id),
      );
      if (members.length === 0) throw new ValidationError('ไม่มีสมาชิกที่รับยศแล้วให้เลือก');
      const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      await interaction.showModal(buildCreateFineModal(formatDateTimeInput(dueAt, settings.timezone), members));
      return;
    }
    if (interaction.customId.startsWith('fine:pay:')) {
      await this.requireActiveMember(guild, interaction.user.id);
      const fineId = entityId(interaction.customId, 'fine:pay:');
      const view = await this.dependencies.fines.get(guild.id, fineId);
      if (view.member.discordUserId !== interaction.user.id) {
        throw new AuthorizationError('ส่งหลักฐานได้เฉพาะสมาชิกที่ถูกปรับ');
      }
      await interaction.reply({
        ...buildEvidenceMethodPrompt(`fine:evidence_method:${fineId}`, 'หลักฐานชำระค่าปรับ'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId.startsWith('fine:approve:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const proofId = entityId(interaction.customId, 'fine:approve:');
      const view = await this.dependencies.fines.approvePayment(guild.id, proofId, interaction.user.id, new Date());
      await interaction.update(buildFineProofLog(view));
      return;
    }
    if (interaction.customId.startsWith('fine:reject:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const proofId = entityId(interaction.customId, 'fine:reject:');
      await interaction.showModal(buildFineRejectionModal(proofId));
      return;
    }
    if (interaction.customId.startsWith('fine:cancel:')) {
      await this.requireCapability(guild, interaction.user.id, 'FINANCIAL_REVERSE');
      const fineId = entityId(interaction.customId, 'fine:cancel:');
      await interaction.showModal(buildFineCancellationModal(fineId));
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId.startsWith('fine:evidence_method:')) {
      await this.requireActiveMember(guild, interaction.user.id);
      const fineId = entityId(interaction.customId, 'fine:evidence_method:');
      const view = await this.dependencies.fines.get(guild.id, fineId);
      if (view.member.discordUserId !== interaction.user.id) {
        throw new AuthorizationError('ส่งหลักฐานได้เฉพาะสมาชิกที่ถูกปรับ');
      }
      await interaction.showModal(buildFinePaymentModal(view.fine, requireEvidenceInputMode(interaction.values[0])));
      return;
    }
    if (interaction.customId !== fineComponentIds.adminSelect) return;
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const fineId = interaction.values[0];
    if (fineId === undefined) throw new ValidationError('กรุณาเลือกค่าปรับ');
    const view = await this.dependencies.fines.get(guild.id, fineId);
    await interaction.update({ ...buildFineManagement(view), content: null });
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === fineCreateModalId) {
      await this.createFine(interaction, guild);
      return;
    }
    if (interaction.customId.startsWith('fine:pay_modal:')) {
      const evidence = parseEvidenceModalContext(interaction.customId, 'fine:pay_modal:');
      await this.submitPayment(interaction, guild, entityId(evidence.context, ''), evidence.mode);
      return;
    }
    if (interaction.customId.startsWith('fine:reject_modal:')) {
      await this.rejectPayment(interaction, guild, entityId(interaction.customId, 'fine:reject_modal:'));
      return;
    }
    if (interaction.customId.startsWith('fine:cancel_modal:')) {
      await this.cancelFine(interaction, guild, entityId(interaction.customId, 'fine:cancel_modal:'));
    }
  }

  private async createFine(interaction: ModalSubmitInteraction, guild: Guild): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const settings = await this.requireSettings(guild.id);
    requireFineChannel(settings);
    const memberId = interaction.fields.getStringSelectValues(fineComponentIds.createMember)[0];
    if (memberId === undefined) throw new ValidationError('กรุณาเลือกสมาชิก');
    const selectableMembers = await filterRoleVerifiedActiveMembers(
      guild,
      settings,
      await this.dependencies.members.listActive(guild.id),
    );
    if (!selectableMembers.some((member) => member.discordUserId === memberId)) {
      throw new ValidationError('สมาชิกนี้ยังไม่ได้รับยศหรือไม่มีสถานะใช้งาน');
    }
    const view = await this.dependencies.fines.create({
      guildId: guild.id,
      requestId: interaction.id,
      memberDiscordUserId: memberId,
      reason: interaction.fields.getTextInputValue(fineComponentIds.createReason),
      principalAmount: parseMoney(interaction.fields.getTextInputValue(fineComponentIds.createAmount), false),
      surchargeAmount: parseMoney(interaction.fields.getTextInputValue(fineComponentIds.createSurcharge), true),
      dueAt: parseDateTimeInput(
        interaction.fields.getTextInputValue(fineComponentIds.createDueAt),
        settings.timezone,
        'กำหนดชำระ',
      ),
      actorDiscordUserId: interaction.user.id,
      now: new Date(),
    });
    await interaction.reply({
      ...buildNotice('success', 'สร้างค่าปรับแล้ว', `สมาชิก: <@${view.member.discordUserId}>\nยอดตั้งต้น: **${view.fine.principalAmount.toLocaleString('th-TH')}**`, 'Fines'),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async submitPayment(
    interaction: ModalSubmitInteraction,
    guild: Guild,
    fineId: string,
    evidenceMode: EvidenceInputMode,
  ): Promise<void> {
    await this.requireActiveMember(guild, interaction.user.id);
    const settings = await this.requireSettings(guild.id);
    const channel = await fetchSendableChannel(
      this.dependencies.client,
      settings.fineLogChannelId,
      'Channel Log ค่าปรับ',
    );
    const evidenceInput = readEvidenceModalInput(
      interaction.fields,
      evidenceMode,
      fineComponentIds.paymentFile,
      fineComponentIds.paymentMediaLink,
    );
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [attachment] = await resolveEvidenceImages({
      mode: evidenceMode,
      ...evidenceInput,
      maximumImages: 1,
      maximumBytesPerImage: 10 * 1_024 * 1_024,
      filenamePrefix: 'fine-proof',
    });
    if (attachment === undefined) throw new ValidationError('ต้องส่งรูปหลักฐาน 1 รูป');
    validateFinePaymentImage({ contentType: attachment.contentType, size: attachment.size });
    const prepared = await this.dependencies.fines.preparePayment(
      guild.id,
      fineId,
      interaction.user.id,
      parseMoney(interaction.fields.getTextInputValue(fineComponentIds.paymentAmount), false),
      new Date(),
    );

    const logMessage = await channel.send({
      ...buildPreparedFineProofLog(prepared),
      files: [{ attachment: attachment.attachment, name: attachment.name }],
    });
    try {
      const persistedAttachment = [...logMessage.attachments.values()][0];
      if (persistedAttachment === undefined) throw new Error('Discord did not persist the fine payment attachment');
      await this.dependencies.fines.persistPayment({
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
        this.dependencies.logger.error({ err: deleteError, messageId: logMessage.id }, 'failed to remove orphan fine proof log');
      });
      throw error;
    }
    await interaction.editReply(buildNotice('success', 'ส่งหลักฐานแล้ว', 'กรุณารอหัวแก๊ง/รองแก๊งตรวจสอบและยืนยันการชำระ', 'Fines'));
  }

  private async rejectPayment(interaction: ModalSubmitInteraction, guild: Guild, proofId: string): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const view = await this.dependencies.fines.rejectPayment(
      guild.id,
      proofId,
      interaction.user.id,
      interaction.fields.getTextInputValue(fineComponentIds.rejectionReason),
      new Date(),
    );
    await this.updateProofLog(view);
    await interaction.reply({ ...buildNotice('warning', 'ปฏิเสธหลักฐานแล้ว', 'ระบบคำนวณค่าปรับค้างชำระตามเวลาจริงเรียบร้อย', 'Fines'), flags: MessageFlags.Ephemeral });
  }

  private async cancelFine(interaction: ModalSubmitInteraction, guild: Guild, fineId: string): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'FINANCIAL_REVERSE');
    const view = await this.dependencies.fines.cancelFine(
      guild.id,
      fineId,
      interaction.user.id,
      interaction.fields.getTextInputValue(fineComponentIds.cancellationReason),
      new Date(),
    );
    await this.refreshFine(view.fine.guildId, view.fine.id);
    await interaction.reply({ ...buildNotice('success', 'ยกเลิกค่าปรับแล้ว', 'รายการถูกยกเลิกและบันทึกใน Audit log เรียบร้อย', 'Fines'), flags: MessageFlags.Ephemeral });
  }

  private async updateProofLog(view: FinePaymentProofView): Promise<void> {
    const channel = await fetchSendableChannel(this.dependencies.client, view.proof.logChannelId, 'Channel Log ค่าปรับ');
    const message = await channel.messages.fetch(view.proof.logMessageId);
    await message.edit(buildFineProofLog(view));
  }

  private async refreshFine(guildId: string, fineId: string): Promise<void> {
    const view = await this.dependencies.fines.get(guildId, fineId);
    if (view.fine.publicChannelId === null || view.fine.publicMessageId === null) return;
    const channel = await fetchSendableChannel(this.dependencies.client, view.fine.publicChannelId, 'Channel ค่าปรับ');
    const message = await channel.messages.fetch(view.fine.publicMessageId).catch(() => null);
    if (message !== null) await message.edit(buildFineAnnouncement(view));
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

function isFineButton(customId: string): boolean {
  return customId === componentIds.controlFinance || customId.startsWith('fine:');
}

function requireGuild(guild: Guild | null): Guild {
  if (guild === null) throw new ValidationError('ระบบค่าปรับใช้ได้เฉพาะใน Discord Server');
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

function requireFineChannel(settings: GuildSettings): void {
  if (settings.fineChannelId === null) throw new ValidationError('กรุณาตั้งค่า Channel ค่าปรับก่อน');
}

async function fetchSendableChannel(client: Client, channelId: string | null, label: string): Promise<SendableChannels> {
  if (channelId === null) throw new ValidationError(`กรุณาตั้งค่า ${label} ก่อน`);
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
    throw new ValidationError(`${label} ไม่ใช่ Text Channel ที่ Bot ส่งข้อความได้`);
  }
  return channel;
}
