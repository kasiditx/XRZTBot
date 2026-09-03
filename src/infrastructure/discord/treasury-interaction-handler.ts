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
import {
  hasCapability,
  resolveAuthority,
  type AuthorityLevel,
  type Capability,
} from '../../modules/authorization/permissions.js';
import type { GuildConfigService } from '../../modules/guild-config/service.js';
import type { MemberService } from '../../modules/members/service.js';
import type {
  TreasuryWithdrawalRequestView,
  TreasuryWithdrawalService,
} from '../../modules/treasury-withdrawals/service.js';
import type { GuildSettings } from '../db/schema.js';
import { validateTreasuryEvidence } from '../../modules/treasury/rules.js';
import type { TreasuryService } from '../../modules/treasury/service.js';
import { componentIds } from './components.js';
import {
  buildManualTreasuryModal,
  buildOpeningBalanceModal,
  buildPreparedTreasuryEntryLog,
  buildTreasuryAdminPanel,
  buildTreasuryDashboard,
  buildTreasuryEntryLog,
  buildTreasuryManagement,
  buildTreasuryReversalModal,
  buildTreasuryWithdrawalModal,
  buildTreasuryWithdrawalPanel,
  buildTreasuryWithdrawalRejectionModal,
  buildTreasuryWithdrawalRequestLog,
  treasuryComponentIds,
} from './treasury-components.js';
import { buildNotice } from './theme.js';
import {
  buildEvidenceMethodPrompt,
  parseEvidenceModalContext,
  readEvidenceModalInput,
  requireEvidenceInputMode,
  resolveEvidenceImages,
  type EvidenceInputMode,
} from './evidence-images.js';

export interface TreasuryInteractionDependencies {
  readonly client: Client;
  readonly treasury: TreasuryService;
  readonly treasuryWithdrawals: TreasuryWithdrawalService;
  readonly guildConfig: GuildConfigService;
  readonly members: MemberService;
  readonly logger: pino.Logger;
}

export class TreasuryInteractionHandler {
  public constructor(private readonly dependencies: TreasuryInteractionDependencies) {}

  public async handle(interaction: Interaction): Promise<boolean> {
    if (interaction.isButton() && isTreasuryButton(interaction.customId)) {
      await this.handleButton(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('treasury:')) {
      await this.handleSelect(interaction);
      return true;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('treasury:')) {
      await this.handleModal(interaction);
      return true;
    }
    return false;
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === componentIds.controlTreasury) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const dashboard = await this.dependencies.treasury.getDashboard(guild.id, 25);
      await interaction.reply({ ...buildTreasuryAdminPanel(dashboard), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === treasuryComponentIds.adminIncome) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await this.requireTreasuryChannel(guild.id);
      await interaction.reply({
        ...buildEvidenceMethodPrompt('treasury:evidence_method:INCOME', 'หลักฐานรายรับ'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId === treasuryComponentIds.adminExpense) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await this.requireTreasuryChannel(guild.id);
      await interaction.reply({
        ...buildEvidenceMethodPrompt('treasury:evidence_method:EXPENSE', 'หลักฐานรายจ่าย'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId === treasuryComponentIds.adminOpening) {
      await this.requireCapability(guild, interaction.user.id, 'FINANCIAL_REVERSE');
      await this.requireTreasuryChannel(guild.id);
      await interaction.showModal(buildOpeningBalanceModal());
      return;
    }
    if (interaction.customId === treasuryComponentIds.adminPublishPanel) {
      await this.publishDashboard(interaction, guild);
      return;
    }
    if (interaction.customId === treasuryComponentIds.adminPublishWithdrawalPanel) {
      await this.publishWithdrawalPanel(interaction, guild);
      return;
    }
    if (interaction.customId === treasuryComponentIds.withdrawalRequest) {
      await this.requireActiveMember(guild, interaction.user.id);
      await this.requireTreasuryWithdrawalChannel(guild.id);
      await this.requireTreasuryWithdrawalLogChannel(guild.id);
      await interaction.showModal(buildTreasuryWithdrawalModal());
      return;
    }
    if (interaction.customId.startsWith('treasury:withdrawal_approve:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const view = await this.dependencies.treasuryWithdrawals.approve(
        guild.id,
        entityId(interaction.customId, 'treasury:withdrawal_approve:'),
        interaction.user.id,
        new Date(),
      );
      await interaction.update(buildTreasuryWithdrawalRequestLog(view));
      return;
    }
    if (interaction.customId.startsWith('treasury:withdrawal_reject:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await interaction.showModal(buildTreasuryWithdrawalRejectionModal(
        entityId(interaction.customId, 'treasury:withdrawal_reject:'),
      ));
      return;
    }
    if (interaction.customId.startsWith('treasury:withdrawal_cancel:')) {
      const view = await this.dependencies.treasuryWithdrawals.cancel(
        guild.id,
        entityId(interaction.customId, 'treasury:withdrawal_cancel:'),
        interaction.user.id,
        new Date(),
      );
      await interaction.update(buildTreasuryWithdrawalRequestLog(view));
      return;
    }
    if (interaction.customId.startsWith('treasury:reverse:')) {
      await this.requireCapability(guild, interaction.user.id, 'FINANCIAL_REVERSE');
      const entryId = entityId(interaction.customId, 'treasury:reverse:');
      await interaction.showModal(buildTreasuryReversalModal(entryId));
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId.startsWith('treasury:evidence_method:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await this.requireTreasuryChannel(guild.id);
      const entryType = interaction.customId.slice('treasury:evidence_method:'.length);
      if (entryType !== 'INCOME' && entryType !== 'EXPENSE') throw new ValidationError('ประเภทรายการไม่ถูกต้อง');
      await interaction.showModal(buildManualTreasuryModal(entryType, requireEvidenceInputMode(interaction.values[0])));
      return;
    }
    if (interaction.customId !== treasuryComponentIds.adminSelect) return;
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const entryId = interaction.values[0];
    if (entryId === undefined) throw new ValidationError('กรุณาเลือกรายการเงินกองกลาง');
    const entry = await this.dependencies.treasury.getEntry(guild.id, entryId);
    await interaction.update({ ...buildTreasuryManagement(entry), content: null });
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId.startsWith('treasury:manual_modal:')) {
      const evidence = parseEvidenceModalContext(interaction.customId, 'treasury:manual_modal:');
      const rawType = evidence.context;
      if (rawType !== 'INCOME' && rawType !== 'EXPENSE') throw new ValidationError('ประเภทรายการไม่ถูกต้อง');
      await this.persistManualEntry(interaction, guild, rawType, evidence.mode);
      return;
    }
    if (interaction.customId === 'treasury:opening_modal') {
      await this.createOpeningBalance(interaction, guild);
      return;
    }
    if (interaction.customId.startsWith('treasury:reverse_modal:')) {
      await this.reverseEntry(interaction, guild, entityId(interaction.customId, 'treasury:reverse_modal:'));
      return;
    }
    if (interaction.customId === 'treasury:withdrawal_request_modal') {
      await this.createWithdrawalRequest(interaction, guild);
      return;
    }
    if (interaction.customId.startsWith('treasury:withdrawal_reject_modal:')) {
      await this.rejectWithdrawalRequest(
        interaction,
        guild,
        entityId(interaction.customId, 'treasury:withdrawal_reject_modal:'),
      );
    }
  }

  private async createWithdrawalRequest(interaction: ModalSubmitInteraction, guild: Guild): Promise<void> {
    await this.requireActiveMember(guild, interaction.user.id);
    await this.requireTreasuryWithdrawalChannel(guild.id);
    await this.requireTreasuryWithdrawalLogChannel(guild.id);
    const view = await this.dependencies.treasuryWithdrawals.create({
      guildId: guild.id,
      clientRequestId: interaction.id,
      requesterDiscordUserId: interaction.user.id,
      amount: parseMoney(interaction.fields.getTextInputValue(treasuryComponentIds.withdrawalAmount)),
      reason: interaction.fields.getTextInputValue(treasuryComponentIds.withdrawalReason),
      now: new Date(),
    });
    await interaction.reply({
      ...buildNotice('success', 'ส่งคำขอเบิกเงินแล้ว', `จำนวนเงิน: **${view.request.amount.toLocaleString('th-TH')}**\nสถานะ: ⏳ รอหัวแก๊ง/รองแก๊งตรวจสอบ`, 'Treasury Withdrawal'),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async rejectWithdrawalRequest(
    interaction: ModalSubmitInteraction,
    guild: Guild,
    requestId: string,
  ): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const view = await this.dependencies.treasuryWithdrawals.reject(
      guild.id,
      requestId,
      interaction.user.id,
      interaction.fields.getTextInputValue(treasuryComponentIds.withdrawalRejectionReason),
      new Date(),
    );
    await this.updateWithdrawalRequestLog(view);
    await interaction.reply({ ...buildNotice('warning', 'ปฏิเสธคำขอเบิกเงินแล้ว', 'ระบบอัปเดตสถานะคำขอและ Log เรียบร้อย', 'Treasury Withdrawal'), flags: MessageFlags.Ephemeral });
  }

  private async persistManualEntry(
    interaction: ModalSubmitInteraction,
    guild: Guild,
    entryType: 'INCOME' | 'EXPENSE',
    evidenceMode: EvidenceInputMode,
  ): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const channel = await this.requireTreasuryChannel(guild.id);
    const evidenceInput = readEvidenceModalInput(
      interaction.fields,
      evidenceMode,
      treasuryComponentIds.evidence,
      treasuryComponentIds.evidenceMediaLink,
    );
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [attachment] = await resolveEvidenceImages({
      mode: evidenceMode,
      ...evidenceInput,
      maximumImages: 1,
      maximumBytesPerImage: 10 * 1_024 * 1_024,
      filenamePrefix: 'treasury-proof',
    });
    if (attachment === undefined) throw new ValidationError('ต้องส่งรูปหลักฐาน 1 รูป');
    validateTreasuryEvidence({ contentType: attachment.contentType, size: attachment.size });
    const prepared = await this.dependencies.treasury.prepareManualEntry(
      guild.id,
      interaction.id,
      entryType,
      parseMoney(interaction.fields.getTextInputValue(treasuryComponentIds.amount)),
      interaction.fields.getTextInputValue(treasuryComponentIds.description),
      interaction.user.id,
    );

    const logMessage = await channel.send({
      ...buildPreparedTreasuryEntryLog(prepared),
      files: [{ attachment: attachment.attachment, name: attachment.name }],
    });
    try {
      const persistedAttachment = [...logMessage.attachments.values()][0];
      if (persistedAttachment === undefined) throw new Error('Discord did not persist the treasury attachment');
      const entry = await this.dependencies.treasury.persistManualEntry({
        prepared,
        attachmentId: persistedAttachment.id,
        publicChannelId: channel.id,
        publicMessageId: logMessage.id,
        now: new Date(),
      });
      await logMessage.edit(buildTreasuryEntryLog(entry));
    } catch (error: unknown) {
      await logMessage.delete().catch((deleteError: unknown) => {
        this.dependencies.logger.error({ err: deleteError, messageId: logMessage.id }, 'failed to remove orphan treasury log');
      });
      throw error;
    }
    await interaction.editReply(buildNotice(
      'success',
      `บันทึก${entryType === 'INCOME' ? 'รายรับ' : 'รายจ่าย'}แล้ว`,
      'ยอดเงินกองกลางและ Log ได้รับการอัปเดตเรียบร้อย',
      'Treasury',
    ));
  }

  private async createOpeningBalance(interaction: ModalSubmitInteraction, guild: Guild): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'FINANCIAL_REVERSE');
    await this.requireTreasuryChannel(guild.id);
    const entry = await this.dependencies.treasury.createOpeningBalance(
      guild.id,
      interaction.id,
      parseMoney(interaction.fields.getTextInputValue(treasuryComponentIds.amount)),
      interaction.user.id,
      new Date(),
    );
    await interaction.reply({ ...buildNotice('success', 'ตั้งยอดเริ่มต้นแล้ว', `ยอดเงิน: **${entry.amount.toLocaleString('th-TH')}**`, 'Treasury'), flags: MessageFlags.Ephemeral });
  }

  private async reverseEntry(interaction: ModalSubmitInteraction, guild: Guild, entryId: string): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'FINANCIAL_REVERSE');
    await this.requireTreasuryChannel(guild.id);
    const reversal = await this.dependencies.treasury.reverseEntry(
      guild.id,
      interaction.id,
      entryId,
      interaction.fields.getTextInputValue(treasuryComponentIds.reversalReason),
      interaction.user.id,
      new Date(),
    );
    await interaction.reply({
      ...buildNotice('success', 'ย้อนรายการแล้ว', `ยอดเปลี่ยนแปลง: **${reversal.amount > 0 ? '+' : ''}${reversal.amount.toLocaleString('th-TH')}**\nAudit log ได้รับการบันทึกแล้ว`, 'Treasury'),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async publishDashboard(interaction: ButtonInteraction, guild: Guild): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const settings = await this.requireSettings(guild.id);
    const channel = await fetchSendableChannel(this.dependencies.client, settings.treasuryChannelId, 'Channel เงินกองกลาง');
    const content = buildTreasuryDashboard(await this.dependencies.treasury.getDashboard(guild.id));
    const existing = settings.treasuryPanelMessageId === null
      ? null
      : await channel.messages.fetch(settings.treasuryPanelMessageId).catch(() => null);
    const message = await channel.send(content);
    try {
      await this.dependencies.guildConfig.saveTreasuryPanelMessage(guild.id, message.id);
    } catch (error: unknown) {
      await message.delete().catch((deleteError: unknown) => {
        this.dependencies.logger.error({ err: deleteError, messageId: message.id }, 'failed to remove untracked treasury dashboard');
      });
      throw error;
    }
    if (existing !== null) {
      await existing.delete().catch((error: unknown) => {
        this.dependencies.logger.warn({ err: error, messageId: existing.id }, 'failed to remove previous treasury dashboard');
      });
    }
    await interaction.reply({ ...buildNotice('success', 'ส่ง/อัปเดตยอดเงินกองกลางแล้ว', `ปลายทาง: <#${channel.id}>`, 'Treasury'), flags: MessageFlags.Ephemeral });
  }

  private async publishWithdrawalPanel(interaction: ButtonInteraction, guild: Guild): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const settings = await this.requireSettings(guild.id);
    const channel = await fetchSendableChannel(
      this.dependencies.client,
      settings.treasuryWithdrawalChannelId,
      'Channel เบิกเงินแก๊ง',
    );
    const content = buildTreasuryWithdrawalPanel();
    if (settings.treasuryWithdrawalPanelMessageId !== null) {
      const existing = await channel.messages.fetch(settings.treasuryWithdrawalPanelMessageId).catch(() => null);
      if (existing !== null) {
        await existing.edit(content);
        await interaction.reply({ ...buildNotice('success', 'อัปเดตแผงเบิกเงินแล้ว', `ปลายทาง: <#${channel.id}>`, 'Treasury Withdrawal'), flags: MessageFlags.Ephemeral });
        return;
      }
    }
    const message = await channel.send(content);
    await this.dependencies.guildConfig.saveTreasuryWithdrawalPanelMessage(guild.id, message.id);
    await interaction.reply({ ...buildNotice('success', 'ส่งแผงเบิกเงินแล้ว', `ปลายทาง: <#${channel.id}>`, 'Treasury Withdrawal'), flags: MessageFlags.Ephemeral });
  }

  private async requireTreasuryChannel(guildId: string): Promise<SendableChannels> {
    const settings = await this.requireSettings(guildId);
    return fetchSendableChannel(this.dependencies.client, settings.treasuryChannelId, 'Channel เงินกองกลาง');
  }

  private async requireTreasuryWithdrawalChannel(guildId: string): Promise<SendableChannels> {
    const settings = await this.requireSettings(guildId);
    return fetchSendableChannel(
      this.dependencies.client,
      settings.treasuryWithdrawalChannelId,
      'Channel เบิกเงินแก๊ง',
    );
  }

  private async requireTreasuryWithdrawalLogChannel(guildId: string): Promise<SendableChannels> {
    const settings = await this.requireSettings(guildId);
    return fetchSendableChannel(
      this.dependencies.client,
      settings.treasuryWithdrawalLogChannelId,
      'Channel Log เบิกเงินแก๊ง',
    );
  }

  private async updateWithdrawalRequestLog(view: TreasuryWithdrawalRequestView): Promise<void> {
    if (view.request.publicChannelId === null || view.request.publicMessageId === null) {
      throw new ValidationError('คำขอเบิกเงินนี้ยังไม่มี Discord log message');
    }
    const channel = await fetchSendableChannel(
      this.dependencies.client,
      view.request.publicChannelId,
      'Channel Log เบิกเงินแก๊ง',
    );
    const message = await channel.messages.fetch(view.request.publicMessageId);
    await message.edit(buildTreasuryWithdrawalRequestLog(view));
  }

  private async requireActiveMember(guild: Guild, discordUserId: string): Promise<void> {
    const [authority, member] = await Promise.all([
      this.resolveCurrentAuthority(guild, discordUserId),
      this.dependencies.members.findByDiscordUserId(guild.id, discordUserId),
    ]);
    if (!hasCapability(authority, 'MEMBER_USE') || member?.status !== 'ACTIVE') {
      throw new AuthorizationError('ต้องมี Role สมาชิกและสถานะสมาชิกใช้งานจึงขอเบิกเงินได้');
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

function isTreasuryButton(customId: string): boolean {
  return customId === componentIds.controlTreasury || customId.startsWith('treasury:');
}

function requireGuild(guild: Guild | null): Guild {
  if (guild === null) throw new ValidationError('ระบบเงินกองกลางใช้ได้เฉพาะใน Discord Server');
  return guild;
}

function entityId(customId: string, prefix: string): string {
  const id = customId.slice(prefix.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new ValidationError('รหัสรายการไม่ถูกต้อง');
  }
  return id;
}

function parseMoney(value: string): number {
  const normalized = value.trim().replaceAll(',', '');
  const amount = Number(normalized);
  if (!/^\d+$/u.test(normalized) || !Number.isSafeInteger(amount) || amount < 1) {
    throw new ValidationError('จำนวนเงินต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
  }
  return amount;
}

async function fetchSendableChannel(client: Client, channelId: string | null, label: string): Promise<SendableChannels> {
  if (channelId === null) throw new ValidationError(`กรุณาตั้งค่า ${label} ก่อน`);
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
    throw new ValidationError(`${label} ไม่ใช่ Text Channel ที่ Bot ส่งข้อความได้`);
  }
  return channel;
}
