import { randomUUID } from 'node:crypto';
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
import { buildNotice, MiruEmbedBuilder as EmbedBuilder } from './theme.js';
import { AuthorizationError, ValidationError } from '../../domain/errors.js';
import { hasCapability, resolveAuthority, type AuthorityLevel, type Capability } from '../../modules/authorization/permissions.js';
import type { GuildConfigService } from '../../modules/guild-config/service.js';
import type { DepositRequestView, DepositService } from '../../modules/deposits/service.js';
import type { InventoryService } from '../../modules/inventory/service.js';
import {
  parseSelectedInventoryQuantities,
  validateDepositImage,
  validateStockCsvAttachment,
} from '../../modules/inventory/rules.js';
import type { MemberService } from '../../modules/members/service.js';
import type { WithdrawalService } from '../../modules/withdrawals/service.js';
import type { GuildSettings } from '../db/schema.js';
import { componentIds } from './components.js';
import {
  buildBatchLog,
  buildBatchManagement,
  buildDepositLog,
  buildDepositModal,
  buildDepositRejectionModal,
  buildFulfillmentModal,
  buildPreparedDepositLog,
  buildStockAdminPanel,
  buildStockCsvModal,
  buildStockDashboard,
  buildStockItemPicker,
  buildStockReversalModal,
  buildWithdrawalLog,
  buildWithdrawalModal,
  buildWithdrawalRejectionModal,
  stockComponentIds,
  type StockMemberAction,
} from './stock-components.js';
import {
  buildEvidenceMethodPrompt,
  parseEvidenceModalContext,
  readEvidenceModalInput,
  requireEvidenceInputMode,
  resolveEvidenceImages,
  type EvidenceInputMode,
} from './evidence-images.js';

const maximumCsvSize = 2 * 1_024 * 1_024;
const maximumDepositImageSize = 10 * 1_024 * 1_024;
const selectionSessionTtlMs = 15 * 60 * 1_000;
const maximumSelectionSessions = 1_000;

interface StockSelectionSession {
  readonly token: string;
  readonly guildId: string;
  readonly discordUserId: string;
  readonly action: StockMemberAction;
  readonly itemIds: Set<string>;
  readonly parentToken: string | null;
  expiresAt: number;
}

export interface StockInteractionDependencies {
  readonly client: Client;
  readonly inventory: InventoryService;
  readonly withdrawals: WithdrawalService;
  readonly deposits: DepositService;
  readonly guildConfig: GuildConfigService;
  readonly members: MemberService;
  readonly logger: pino.Logger;
}

export class StockInteractionHandler {
  private readonly selectionSessions = new Map<string, StockSelectionSession>();

  public constructor(private readonly dependencies: StockInteractionDependencies) {}

  public async handle(interaction: Interaction): Promise<boolean> {
    if (interaction.isButton() && (interaction.customId === componentIds.controlStock || interaction.customId.startsWith('stock:'))) {
      await this.handleButton(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('stock:')) {
      await this.handleSelect(interaction);
      return true;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('stock:')) {
      await this.handleModal(interaction);
      return true;
    }
    return false;
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === componentIds.controlStock) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const [batches, withdrawals, deposits] = await Promise.all([
        this.dependencies.inventory.listRecentBatches(guild.id, 10),
        this.dependencies.withdrawals.list(guild.id, 10),
        this.dependencies.deposits.list(guild.id, 10),
      ]);
      await interaction.reply({ ...buildStockAdminPanel(batches, withdrawals, deposits), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === stockComponentIds.adminOpening) {
      await this.requireCapability(guild, interaction.user.id, 'STOCK_REVERSE');
      await this.requireStockLogChannel(guild.id);
      await interaction.showModal(buildStockCsvModal('OPENING'));
      return;
    }
    if (interaction.customId === stockComponentIds.adminMovement) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await this.requireStockLogChannel(guild.id);
      await interaction.showModal(buildStockCsvModal('MOVEMENT'));
      return;
    }
    if (interaction.customId === stockComponentIds.adminPublishPanel) {
      await this.publishDashboard(interaction, guild);
      return;
    }
    if (interaction.customId === 'stock:withdraw') {
      await this.requireActiveMember(guild, interaction.user.id);
      const session = this.createSelectionSession(guild.id, interaction.user.id, 'WITHDRAWAL');
      await interaction.reply({
        ...buildStockItemPicker('WITHDRAWAL', await this.dependencies.inventory.getDashboard(guild.id, 1, 25), session.token, session.itemIds),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId === 'stock:deposit') {
      await this.requireActiveMember(guild, interaction.user.id);
      await this.requireDepositLogChannel(guild.id);
      const session = this.createSelectionSession(guild.id, interaction.user.id, 'DEPOSIT');
      await interaction.reply({
        ...buildStockItemPicker('DEPOSIT', await this.dependencies.inventory.getDashboard(guild.id, 1, 25), session.token, session.itemIds),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId.startsWith(stockComponentIds.memberPagePrefix)) {
      const component = parseSelectionComponent(interaction.customId, stockComponentIds.memberPagePrefix, true);
      const session = await this.requireSelectionSession(guild, interaction.user.id, component);
      const dashboard = await this.dependencies.inventory.getDashboard(guild.id, component.page, 25);
      await interaction.update(buildStockItemPicker(session.action, dashboard, session.token, session.itemIds));
      return;
    }
    if (interaction.customId.startsWith(stockComponentIds.memberClearPrefix)) {
      const component = parseSelectionComponent(interaction.customId, stockComponentIds.memberClearPrefix, true);
      const session = await this.requireSelectionSession(guild, interaction.user.id, component);
      session.itemIds.clear();
      const dashboard = await this.dependencies.inventory.getDashboard(guild.id, component.page, 25);
      await interaction.update(buildStockItemPicker(session.action, dashboard, session.token, session.itemIds));
      return;
    }
    if (interaction.customId.startsWith(stockComponentIds.memberReviewPrefix)) {
      const component = parseSelectionComponent(interaction.customId, stockComponentIds.memberReviewPrefix, false);
      const session = await this.requireSelectionSession(guild, interaction.user.id, component);
      if (session.itemIds.size === 0) throw new ValidationError('กรุณาเลือกสิ่งของอย่างน้อย 1 รายการ');
      const items = await this.dependencies.inventory.getActiveItems(guild.id, [...session.itemIds]);
      const submission = this.createSelectionSession(
        guild.id,
        interaction.user.id,
        session.action,
        session.token,
        items.map((item) => item.id),
      );
      if (session.action === 'WITHDRAWAL') {
        await interaction.showModal(buildWithdrawalModal(submission.token, items));
        return;
      }
      await interaction.update(buildEvidenceMethodPrompt(
        `stock:deposit_evidence_method:${submission.token}`,
        'หลักฐานส่งของเข้าแก๊ง',
      ));
      return;
    }
    if (interaction.customId.startsWith('stock:view:')) {
      const page = parseStockViewPage(interaction.customId.slice('stock:view:'.length));
      await interaction.update(buildStockDashboard(await this.dependencies.inventory.getDashboard(guild.id, page)));
      return;
    }
    if (interaction.customId.startsWith('stock:log_view:')) {
      const page = parseStockViewPage(interaction.customId.slice('stock:log_view:'.length));
      await interaction.update(buildStockDashboard(await this.dependencies.inventory.getDashboard(guild.id, page), 'LOG'));
      return;
    }
    if (interaction.customId.startsWith('stock:fulfill:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      const request = await this.dependencies.withdrawals.get(guild.id, entityId(interaction.customId, 'stock:fulfill:'));
      await interaction.showModal(buildFulfillmentModal(request));
      return;
    }
    if (interaction.customId.startsWith('stock:withdrawal_reject:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await interaction.showModal(buildWithdrawalRejectionModal(entityId(interaction.customId, 'stock:withdrawal_reject:')));
      return;
    }
    if (interaction.customId.startsWith('stock:deposit_approve:')) {
      await this.approveDeposit(interaction, guild, entityId(interaction.customId, 'stock:deposit_approve:'));
      return;
    }
    if (interaction.customId.startsWith('stock:deposit_reject:')) {
      await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
      await interaction.showModal(buildDepositRejectionModal(entityId(interaction.customId, 'stock:deposit_reject:')));
      return;
    }
    if (interaction.customId.startsWith('stock:reverse:')) {
      await this.requireCapability(guild, interaction.user.id, 'STOCK_REVERSE');
      await interaction.showModal(buildStockReversalModal(entityId(interaction.customId, 'stock:reverse:')));
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId.startsWith('stock:deposit_evidence_method:')) {
      await this.requireActiveMember(guild, interaction.user.id);
      const token = entityId(interaction.customId, 'stock:deposit_evidence_method:');
      const session = await this.requireSelectionSession(guild, interaction.user.id, {
        action: 'DEPOSIT',
        token,
        page: 1,
      });
      const items = await this.dependencies.inventory.getActiveItems(guild.id, [...session.itemIds]);
      await interaction.showModal(buildDepositModal(
        token,
        items,
        requireEvidenceInputMode(interaction.values[0]),
      ));
      return;
    }
    if (interaction.customId.startsWith(stockComponentIds.memberSelectPrefix)) {
      const component = parseSelectionComponent(interaction.customId, stockComponentIds.memberSelectPrefix, true);
      const session = await this.requireSelectionSession(guild, interaction.user.id, component);
      const dashboard = await this.dependencies.inventory.getDashboard(guild.id, component.page, 25);
      const pageIds = new Set(dashboard.items.map((item) => item.id));
      const selectedIds = interaction.values.map((value) => entityId(value, ''));
      if (selectedIds.some((itemId) => !pageIds.has(itemId))) {
        throw new ValidationError('รายการที่เลือกไม่อยู่ในหน้า Stock นี้');
      }
      const nextItemIds = new Set([...session.itemIds].filter((itemId) => !pageIds.has(itemId)));
      selectedIds.forEach((itemId) => nextItemIds.add(itemId));
      if (nextItemIds.size > 25) throw new ValidationError('หนึ่งคำขอเลือกได้สูงสุด 25 รายการ');
      session.itemIds.clear();
      nextItemIds.forEach((itemId) => session.itemIds.add(itemId));
      await interaction.update(buildStockItemPicker(session.action, dashboard, session.token, session.itemIds));
      return;
    }
    const selectedId = interaction.values[0];
    if (selectedId === undefined) throw new ValidationError('กรุณาเลือกรายการ');
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    if (interaction.customId === stockComponentIds.adminBatchSelect) {
      await interaction.update({ ...buildBatchManagement(await this.dependencies.inventory.getBatch(guild.id, selectedId)), content: null });
      return;
    }
    if (interaction.customId === stockComponentIds.adminWithdrawalSelect) {
      await interaction.update({ ...buildWithdrawalLog(await this.dependencies.withdrawals.get(guild.id, selectedId)), content: null });
      return;
    }
    if (interaction.customId === stockComponentIds.adminDepositSelect) {
      await interaction.update({ ...buildDepositLog(await this.dependencies.deposits.get(guild.id, selectedId)), content: null });
    }
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === stockComponentIds.openingModal) {
      await this.applyCsv(interaction, guild, 'OPENING');
      return;
    }
    if (interaction.customId === stockComponentIds.movementModal) {
      await this.applyCsv(interaction, guild, 'MOVEMENT');
      return;
    }
    if (interaction.customId.startsWith(stockComponentIds.withdrawalModalPrefix)) {
      await this.createWithdrawal(interaction, guild, entityId(interaction.customId, stockComponentIds.withdrawalModalPrefix));
      return;
    }
    if (interaction.customId.startsWith(stockComponentIds.depositModalPrefix)) {
      const evidence = parseEvidenceModalContext(interaction.customId, stockComponentIds.depositModalPrefix);
      await this.createDeposit(interaction, guild, entityId(evidence.context, ''), evidence.mode);
      return;
    }
    if (interaction.customId.startsWith('stock:fulfill_modal:')) {
      await this.fulfillWithdrawal(interaction, guild, entityId(interaction.customId, 'stock:fulfill_modal:'));
      return;
    }
    if (interaction.customId.startsWith('stock:withdrawal_reject_modal:')) {
      await this.rejectWithdrawal(interaction, guild, entityId(interaction.customId, 'stock:withdrawal_reject_modal:'));
      return;
    }
    if (interaction.customId.startsWith('stock:reverse_modal:')) {
      await this.reverseBatch(interaction, guild, entityId(interaction.customId, 'stock:reverse_modal:'));
      return;
    }
    if (interaction.customId.startsWith('stock:deposit_reject_modal:')) {
      await this.rejectDeposit(interaction, guild, entityId(interaction.customId, 'stock:deposit_reject_modal:'));
    }
  }

  private async applyCsv(interaction: ModalSubmitInteraction, guild: Guild, kind: 'OPENING' | 'MOVEMENT'): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, kind === 'OPENING' ? 'STOCK_REVERSE' : 'ROUTINE_ADMIN');
    const channel = await this.requireStockLogChannel(guild.id);
    const uploads = [...interaction.fields.getUploadedFiles(stockComponentIds.csvFile, true).values()];
    const attachment = uploads[0];
    if (attachment === undefined || uploads.length !== 1) throw new ValidationError('ต้องแนบ CSV 1 ไฟล์');
    validateStockCsvAttachment({ name: attachment.name, contentType: attachment.contentType, size: attachment.size });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const content = await downloadCsv(attachment);
    const logMessage = await channel.send({
      embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('⏳ กำลังประมวลผล Stock CSV').setDescription(attachment.name).setTimestamp()],
      files: [{ attachment: content, name: attachment.name }],
    });
    try {
      const persistedAttachment = [...logMessage.attachments.values()][0];
      if (persistedAttachment === undefined) throw new Error('Discord did not persist the stock CSV attachment');
      const batch = kind === 'OPENING'
        ? await this.dependencies.inventory.applyOpeningCsv({
            guildId: guild.id,
            content,
            originalAttachmentId: persistedAttachment.id,
            publicChannelId: channel.id,
            publicMessageId: logMessage.id,
            actorDiscordUserId: interaction.user.id,
            now: new Date(),
          })
        : await this.dependencies.inventory.applyMovementCsv({
            guildId: guild.id,
            content,
            originalAttachmentId: persistedAttachment.id,
            publicChannelId: channel.id,
            publicMessageId: logMessage.id,
            actorDiscordUserId: interaction.user.id,
            now: new Date(),
          });
      if (batch.batch.publicMessageId !== logMessage.id) {
        await logMessage.delete();
        await interaction.editReply(buildNotice('info', 'ไฟล์นี้ถูกประมวลผลแล้ว', `Batch: **${batch.batch.batchRef}**\nระบบไม่บันทึกซ้ำเพื่อป้องกันยอด Stock ผิดพลาด`, 'Stock'));
        return;
      }
      await logMessage.edit(buildBatchLog(batch));
      await interaction.editReply(buildNotice('success', 'บันทึก Stock CSV แล้ว', `Batch: **${batch.batch.batchRef}**\nMovement: **${batch.movements.length.toString()} รายการ**`, 'Stock'));
    } catch (error: unknown) {
      await logMessage.delete().catch((deleteError: unknown) => {
        this.dependencies.logger.error({ err: deleteError, messageId: logMessage.id }, 'failed to remove orphan stock CSV log');
      });
      throw error;
    }
  }

  private async createWithdrawal(interaction: ModalSubmitInteraction, guild: Guild, sessionToken: string): Promise<void> {
    const session = await this.requireSelectionSession(guild, interaction.user.id, {
      action: 'WITHDRAWAL',
      token: sessionToken,
      page: 1,
    });
    await this.requireWithdrawalLogChannel(guild.id);
    const items = await this.dependencies.inventory.getActiveItems(guild.id, [...session.itemIds]);
    const quantities = parseSelectedInventoryQuantities(
      interaction.fields.getTextInputValue(stockComponentIds.selectedItemQuantity),
      items.length,
    );
    const view = await this.dependencies.withdrawals.create({
      guildId: guild.id,
      clientRequestId: interaction.id,
      requesterDiscordUserId: interaction.user.id,
      reason: interaction.fields.getTextInputValue(stockComponentIds.withdrawalReason),
      items: items.map((item, index) => ({ itemCode: item.itemCode, quantity: quantities[index] ?? 0 })),
      now: new Date(),
    });
    this.completeSelectionSession(session);
    await interaction.reply({ ...buildNotice('success', 'ส่งคำขอเบิกของแล้ว', `จำนวน: **${view.items.length.toString()} รายการ**\nสถานะ: ⏳ รอหัวแก๊ง/รองแก๊งจ่ายของ`, 'Stock Withdrawal'), flags: MessageFlags.Ephemeral });
  }

  private async createDeposit(
    interaction: ModalSubmitInteraction,
    guild: Guild,
    sessionToken: string,
    evidenceMode: EvidenceInputMode,
  ): Promise<void> {
    const session = await this.requireSelectionSession(guild, interaction.user.id, {
      action: 'DEPOSIT',
      token: sessionToken,
      page: 1,
    });
    const channel = await this.requireDepositLogChannel(guild.id);
    const evidenceInput = readEvidenceModalInput(
      interaction.fields,
      evidenceMode,
      stockComponentIds.depositFile,
      stockComponentIds.depositMediaLink,
    );
    const items = await this.dependencies.inventory.getActiveItems(guild.id, [...session.itemIds]);
    const quantities = parseSelectedInventoryQuantities(
      interaction.fields.getTextInputValue(stockComponentIds.selectedItemQuantity),
      items.length,
    );
    const prepared = await this.dependencies.deposits.prepare(
      guild.id,
      interaction.user.id,
      interaction.fields.getTextInputValue(stockComponentIds.depositSource),
      items.map((item, index) => ({ itemName: item.itemName, quantity: quantities[index] ?? 0 })),
    );

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [attachment] = await resolveEvidenceImages({
      mode: evidenceMode,
      ...evidenceInput,
      maximumImages: 1,
      maximumBytesPerImage: maximumDepositImageSize,
      filenamePrefix: 'deposit-proof',
    });
    if (attachment === undefined) throw new ValidationError('ต้องส่งรูปหลักฐาน 1 รูป');
    validateDepositImage({ contentType: attachment.contentType, size: attachment.size });
    const upload = { attachment: attachment.attachment, name: attachment.name };
    // Discord drops this modal upload if the initial message references it via attachment://.
    // Persist it first, then reference the persisted file from the embed to suppress the duplicate preview.
    const logMessage = await channel.send({ files: [upload] });
    try {
      const persistedMessage = logMessage.attachments.size > 0
        ? logMessage
        : await channel.messages.fetch({ message: logMessage.id, cache: false, force: true });
      const persistedAttachment = [...persistedMessage.attachments.values()][0];
      if (persistedAttachment === undefined) throw new Error('Discord did not persist the deposit attachment');
      await logMessage.edit(buildPreparedDepositLog(prepared, attachmentReference(persistedAttachment)));
      const view = await this.dependencies.deposits.persist({
        prepared,
        clientRequestId: interaction.id,
        senderDiscordUserId: interaction.user.id,
        attachmentId: persistedAttachment.id,
        publicChannelId: channel.id,
        publicMessageId: logMessage.id,
        now: new Date(),
      });
      if (view.request.publicMessageId !== logMessage.id) {
        await logMessage.delete();
        await interaction.editReply(buildNotice('info', 'รายการนี้ถูกบันทึกแล้ว', 'ระบบไม่สร้างรายการซ้ำเพื่อป้องกัน Stock คลาดเคลื่อน', 'Stock Deposit'));
        return;
      }
    } catch (error: unknown) {
      await logMessage.delete().catch((deleteError: unknown) => {
        this.dependencies.logger.error({ err: deleteError, messageId: logMessage.id }, 'failed to remove orphan deposit log');
      });
      throw error;
    }
    this.completeSelectionSession(session);
    await interaction.editReply(buildNotice('success', 'ส่งของเข้าแก๊งแล้ว', `จำนวน: **${prepared.items.length.toString()} รายการ**\nสถานะ: ⏳ รอหัวแก๊ง/รองแก๊งตรวจสอบ`, 'Stock Deposit'));
  }

  private async approveDeposit(interaction: ButtonInteraction, guild: Guild, requestId: string): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const view = await this.dependencies.deposits.approve(guild.id, requestId, interaction.user.id, new Date());
    const attachment = interaction.message.attachments.get(view.request.attachmentId);
    const imageUrl = attachment === undefined
      ? interaction.message.embeds[0]?.image?.url
      : attachmentReference(attachment);
    await interaction.update(buildDepositLog(view, imageUrl));
  }

  private async rejectDeposit(interaction: ModalSubmitInteraction, guild: Guild, requestId: string): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const view = await this.dependencies.deposits.reject(
      guild.id,
      requestId,
      interaction.user.id,
      interaction.fields.getTextInputValue(stockComponentIds.depositRejectionReason),
      new Date(),
    );
    await this.updateDepositLog(view);
    await interaction.reply({ ...buildNotice('warning', 'ปฏิเสธรายการส่งของแล้ว', 'ยอด Stock ไม่ถูกเปลี่ยนแปลง', 'Stock Deposit'), flags: MessageFlags.Ephemeral });
  }

  private async fulfillWithdrawal(interaction: ModalSubmitInteraction, guild: Guild, requestId: string): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const current = await this.dependencies.withdrawals.get(guild.id, requestId);
    const pendingItems = current.items.filter(({ requestedQuantity, fulfilledQuantity }) => fulfilledQuantity < requestedQuantity);
    const quantities = parseSelectedInventoryQuantities(
      interaction.fields.getTextInputValue(stockComponentIds.fulfillmentItems),
      pendingItems.length,
    );
    const view = await this.dependencies.withdrawals.fulfill({
      guildId: guild.id,
      clientRequestId: interaction.id,
      withdrawalRequestId: requestId,
      items: pendingItems.map(({ item }, index) => ({ itemCode: item.itemCode, quantity: quantities[index] ?? 0 })),
      partialReason: interaction.fields.getTextInputValue(stockComponentIds.fulfillmentReason),
      actorDiscordUserId: interaction.user.id,
      now: new Date(),
    });
    await interaction.editReply(buildNotice('success', 'บันทึกการจ่ายของแล้ว', `สถานะคำขอ: **${view.request.status}**`, 'Stock Withdrawal'));
  }

  private async rejectWithdrawal(interaction: ModalSubmitInteraction, guild: Guild, requestId: string): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const view = await this.dependencies.withdrawals.reject({
      guildId: guild.id,
      withdrawalRequestId: requestId,
      actorDiscordUserId: interaction.user.id,
      reason: interaction.fields.getTextInputValue(stockComponentIds.withdrawalRejectionReason),
      now: new Date(),
    });
    await this.updateWithdrawalLog(view);
    await interaction.reply({
      ...buildNotice('warning', 'ปฏิเสธคำขอเบิกของแล้ว', 'ยอด Stock ไม่ถูกเปลี่ยนแปลง', 'Stock Withdrawal'),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async reverseBatch(interaction: ModalSubmitInteraction, guild: Guild, batchId: string): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'STOCK_REVERSE');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reversal = await this.dependencies.inventory.reverseBatch(
      guild.id,
      interaction.id,
      batchId,
      interaction.fields.getTextInputValue(stockComponentIds.reversalReason),
      interaction.user.id,
      new Date(),
    );
    await interaction.editReply(buildNotice('success', 'ย้อน Stock Batch แล้ว', `Batch: **${reversal.batch.batchRef}**\nAudit log ได้รับการบันทึกแล้ว`, 'Stock'));
  }

  private async publishDashboard(interaction: ButtonInteraction, guild: Guild): Promise<void> {
    await this.requireCapability(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const settings = await this.requireSettings(guild.id);
    const channel = await fetchSendableChannel(this.dependencies.client, settings.stockChannelId, 'Channel Stock');
    const content = buildStockDashboard(await this.dependencies.inventory.getDashboard(guild.id));
    if (settings.stockPanelMessageId !== null) {
      const existing = await channel.messages.fetch(settings.stockPanelMessageId).catch(() => null);
      if (existing !== null) {
        await existing.edit(content);
        await interaction.reply({ ...buildNotice('success', 'อัปเดตหน้า Stock แล้ว', `ปลายทาง: <#${channel.id}>`, 'Stock'), flags: MessageFlags.Ephemeral });
        return;
      }
    }
    const message = await channel.send(content);
    await this.dependencies.guildConfig.saveStockPanelMessage(guild.id, message.id);
    await interaction.reply({ ...buildNotice('success', 'ส่งหน้า Stock แล้ว', `ปลายทาง: <#${channel.id}>`, 'Stock'), flags: MessageFlags.Ephemeral });
  }

  private async updateDepositLog(view: DepositRequestView): Promise<void> {
    if (view.request.publicMessageId === null) throw new ValidationError('รายการส่งของนี้ไม่มี Discord log message');
    const channel = await fetchSendableChannel(this.dependencies.client, view.request.publicChannelId, 'Channel Log ส่งของ');
    const message = await channel.messages.fetch(view.request.publicMessageId);
    const attachment = message.attachments.get(view.request.attachmentId);
    const imageUrl = attachment === undefined ? message.embeds[0]?.image?.url : attachmentReference(attachment);
    await message.edit(buildDepositLog(view, imageUrl));
  }

  private async updateWithdrawalLog(view: Awaited<ReturnType<WithdrawalService['get']>>): Promise<void> {
    if (view.request.publicMessageId === null) throw new ValidationError('คำขอเบิกของนี้ไม่มี Discord log message');
    const channel = await fetchSendableChannel(this.dependencies.client, view.request.publicChannelId, 'Channel Log เบิกของ');
    const message = await channel.messages.fetch(view.request.publicMessageId);
    await message.edit(buildWithdrawalLog(view));
  }

  private createSelectionSession(
    guildId: string,
    discordUserId: string,
    action: StockMemberAction,
    parentToken: string | null = null,
    itemIds: readonly string[] = [],
  ): StockSelectionSession {
    this.pruneSelectionSessions();
    while (this.selectionSessions.size >= maximumSelectionSessions) {
      const oldestToken = this.selectionSessions.keys().next().value;
      if (oldestToken === undefined) break;
      this.selectionSessions.delete(oldestToken);
    }
    const session: StockSelectionSession = {
      token: randomUUID(),
      guildId,
      discordUserId,
      action,
      itemIds: new Set(itemIds),
      parentToken,
      expiresAt: Date.now() + selectionSessionTtlMs,
    };
    this.selectionSessions.set(session.token, session);
    return session;
  }

  private async requireSelectionSession(
    guild: Guild,
    discordUserId: string,
    component: ParsedSelectionComponent,
  ): Promise<StockSelectionSession> {
    await this.requireActiveMember(guild, discordUserId);
    if (component.action === 'DEPOSIT') await this.requireDepositLogChannel(guild.id);
    this.pruneSelectionSessions();
    const session = this.selectionSessions.get(component.token);
    if (
      session === undefined
      || session.guildId !== guild.id
      || session.discordUserId !== discordUserId
      || session.action !== component.action
    ) {
      throw new ValidationError('ตะกร้าหมดอายุหรือไม่ใช่ของคุณ กรุณากดเริ่มรายการใหม่');
    }
    session.expiresAt = Date.now() + selectionSessionTtlMs;
    return session;
  }

  private completeSelectionSession(session: StockSelectionSession): void {
    this.selectionSessions.delete(session.token);
    if (session.parentToken !== null) this.selectionSessions.delete(session.parentToken);
  }

  private pruneSelectionSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.selectionSessions) {
      if (session.expiresAt <= now) this.selectionSessions.delete(token);
    }
  }

  private async requireWithdrawalLogChannel(guildId: string): Promise<SendableChannels> {
    const settings = await this.requireSettings(guildId);
    return fetchSendableChannel(
      this.dependencies.client,
      settings.stockLogChannelId ?? settings.withdrawalLogChannelId,
      'Channel Log Stock รวม',
    );
  }

  private async requireDepositLogChannel(guildId: string): Promise<SendableChannels> {
    const settings = await this.requireSettings(guildId);
    return fetchSendableChannel(
      this.dependencies.client,
      settings.stockLogChannelId ?? settings.depositLogChannelId,
      'Channel Log Stock รวม',
    );
  }

  private async requireStockLogChannel(guildId: string): Promise<SendableChannels> {
    const settings = await this.requireSettings(guildId);
    return fetchSendableChannel(
      this.dependencies.client,
      settings.stockLogChannelId ?? settings.stockChannelId,
      'Channel Log Stock รวม',
    );
  }

  private async requireActiveMember(guild: Guild, discordUserId: string): Promise<void> {
    const [authority, member] = await Promise.all([
      this.resolveCurrentAuthority(guild, discordUserId),
      this.dependencies.members.findByDiscordUserId(guild.id, discordUserId),
    ]);
    if (!hasCapability(authority, 'MEMBER_USE') || member?.status !== 'ACTIVE') {
      throw new AuthorizationError('ต้องมี Role สมาชิกและสถานะสมาชิกใช้งานจึงใช้ระบบ Stock ได้');
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

function attachmentReference(attachment: Attachment): string {
  return `attachment://${attachment.name}`;
}

async function downloadCsv(attachment: Attachment): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(attachment.url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new ValidationError('ดาวน์โหลดไฟล์ CSV จาก Discord ไม่สำเร็จ กรุณาลองใหม่');
  }
  if (!response.ok) throw new ValidationError('ดาวน์โหลดไฟล์ CSV จาก Discord ไม่สำเร็จ');
  const content = Buffer.from(await response.arrayBuffer());
  if (content.length < 1 || content.length > maximumCsvSize) throw new ValidationError('ไฟล์ CSV ต้องมีขนาดไม่เกิน 2 MB');
  return content;
}

function requireGuild(guild: Guild | null): Guild {
  if (guild === null) throw new ValidationError('ระบบ Stock ใช้ได้เฉพาะใน Discord Server');
  return guild;
}

function entityId(customId: string, prefix: string): string {
  const id = customId.slice(prefix.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new ValidationError('รหัสรายการไม่ถูกต้อง');
  }
  return id;
}

interface ParsedSelectionComponent {
  readonly action: StockMemberAction;
  readonly token: string;
  readonly page: number;
}

function parseSelectionComponent(customId: string, prefix: string, includesPage: boolean): ParsedSelectionComponent {
  const parts = customId.slice(prefix.length).split(':');
  const expectedLength = includesPage ? 3 : 2;
  if (parts.length !== expectedLength) throw new ValidationError('ข้อมูลตะกร้าไม่ถูกต้อง');
  const actionValue = parts[0];
  if (actionValue !== 'WITHDRAWAL' && actionValue !== 'DEPOSIT') {
    throw new ValidationError('ประเภทตะกร้าไม่ถูกต้อง');
  }
  return {
    action: actionValue,
    token: entityId(parts[1] ?? '', ''),
    page: includesPage ? parsePage(parts[2] ?? '') : 1,
  };
}

function parsePage(value: string): number {
  const page = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(page) || page < 1) throw new ValidationError('หน้า stock ไม่ถูกต้อง');
  return page;
}

function parseStockViewPage(value: string): number {
  const parts = value.split(':');
  if (parts.length === 1) return parsePage(parts[0] ?? '');
  if (parts.length === 2 && (parts[0] === 'previous' || parts[0] === 'next')) {
    return parsePage(parts[1] ?? '');
  }
  throw new ValidationError('หน้า stock ไม่ถูกต้อง');
}

async function fetchSendableChannel(client: Client, channelId: string | null, label: string): Promise<SendableChannels> {
  if (channelId === null) throw new ValidationError(`กรุณาตั้งค่า ${label} ก่อน`);
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
    throw new ValidationError(`${label} ไม่ใช่ Text Channel ที่ Bot ส่งข้อความได้`);
  }
  return channel;
}
