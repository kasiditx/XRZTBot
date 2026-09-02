import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { MiruEmbedBuilder as EmbedBuilder, formatPanelText } from './theme.js';
import { stockDashboardLine, type InventoryBatchView, type InventoryItem, type StockDashboard } from '../../modules/inventory/service.js';
import type { DepositRequestView, PreparedDeposit } from '../../modules/deposits/service.js';
import type { WithdrawalRequestView } from '../../modules/withdrawals/service.js';

export const stockComponentIds = {
  adminOpening: 'stock:admin_opening',
  adminMovement: 'stock:admin_movement',
  adminPublishPanel: 'stock:admin_publish_panel',
  adminBatchSelect: 'stock:admin_batch_select',
  adminWithdrawalSelect: 'stock:admin_withdrawal_select',
  adminDepositSelect: 'stock:admin_deposit_select',
  openingModal: 'stock:opening_modal',
  movementModal: 'stock:movement_modal',
  csvFile: 'stock:csv_file',
  memberSelectPrefix: 'stock:member_select:',
  memberPagePrefix: 'stock:member_page:',
  memberReviewPrefix: 'stock:member_review:',
  memberClearPrefix: 'stock:member_clear:',
  withdrawalModalPrefix: 'stock:withdrawal_modal:',
  depositModalPrefix: 'stock:deposit_modal:',
  selectedItemQuantity: 'stock:selected_item_quantity',
  withdrawalReason: 'stock:withdrawal_reason',
  depositSource: 'stock:deposit_source',
  depositFile: 'stock:deposit_file',
  depositRejectionReason: 'stock:deposit_rejection_reason',
  withdrawalRejectionReason: 'stock:withdrawal_rejection_reason',
  fulfillmentItems: 'stock:fulfillment_items',
  fulfillmentReason: 'stock:fulfillment_reason',
  reversalReason: 'stock:reversal_reason',
} as const;

export function buildStockAdminPanel(
  batches: readonly InventoryBatchView[],
  withdrawals: readonly WithdrawalRequestView[],
  deposits: readonly DepositRequestView[],
) {
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(stockComponentIds.adminOpening).setLabel('Import ยอดตั้งต้น').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(stockComponentIds.adminMovement).setLabel('เพิ่ม/หักด้วย CSV').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(stockComponentIds.adminPublishPanel).setLabel('ส่ง/อัปเดต Stock').setStyle(ButtonStyle.Success),
  );
  const components: (
    ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
  )[] = [actions];
  if (batches.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(stockComponentIds.adminBatchSelect)
      .setPlaceholder('เลือก batch เพื่อดูหรือย้อนรายการ')
      .addOptions(batches.slice(0, 25).map(({ batch }) => ({
        label: batch.batchRef.slice(0, 100),
        description: `${thaiSourceType(batch.sourceType)} · ${batch.reason}`.slice(0, 100),
        value: batch.id,
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  if (withdrawals.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(stockComponentIds.adminWithdrawalSelect)
      .setPlaceholder('เลือกคำขอเบิกของเพื่อดำเนินการ')
      .addOptions(withdrawals.slice(0, 25).map(({ request, requester }) => ({
        label: `${requester.inGameName} · ${thaiWithdrawalStatus(request.status)}`.slice(0, 100),
        description: request.reason.slice(0, 100),
        value: request.id,
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  if (deposits.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(stockComponentIds.adminDepositSelect)
      .setPlaceholder('เลือกคำขอส่งของเข้าแก๊ง')
      .addOptions(deposits.slice(0, 25).map(({ request, sender }) => ({
        label: `${sender.inGameName} · ${thaiDepositStatus(request.status)}`.slice(0, 100),
        description: request.source.slice(0, 100),
        value: request.id,
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  return {
    content: formatPanelText('📦', 'ระบบ Stock แก๊ง', 'จัดการ Stock คำขอเบิก และรายการส่งของเข้าแก๊ง', 'เลือกหมวดจากปุ่มหรือรายการด้านล่าง'),
    components,
  };
}

export function buildStockCsvModal(kind: 'OPENING' | 'MOVEMENT'): ModalBuilder {
  const file = new FileUploadBuilder()
    .setCustomId(stockComponentIds.csvFile)
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(kind === 'OPENING' ? stockComponentIds.openingModal : stockComponentIds.movementModal)
    .setTitle(kind === 'OPENING' ? 'Import ยอดตั้งต้น Stock' : 'เพิ่ม/หัก Stock ด้วย CSV')
    .addLabelComponents(new LabelBuilder().setLabel('ไฟล์ CSV 1 ไฟล์ (ไม่เกิน 2 MB)').setFileUploadComponent(file));
}

export type StockDashboardMode = 'MEMBER' | 'LOG';

export function buildStockDashboard(dashboard: StockDashboard, mode: StockDashboardMode = 'MEMBER') {
  const itemLines = dashboard.items.length === 0
    ? 'ยังไม่มีรายการ stock'
    : dashboard.items.map(stockDashboardLine).join('\n');
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('📦 Stock แก๊ง')
    .setDescription(itemLines)
    .setFooter({ text: `หน้า ${dashboard.page.toString()}/${dashboard.totalPages.toString()} · ทั้งหมด ${dashboard.totalItems.toString()} รายการ` })
    .setTimestamp();
  if (dashboard.totalPages <= 1) {
    if (mode === 'LOG') return { embeds: [embed], components: [] };
    return {
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('stock:withdraw').setLabel('ขอเบิกของ').setEmoji('📝').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('stock:deposit').setLabel('ส่งของเข้าแก๊ง').setEmoji('📥').setStyle(ButtonStyle.Success),
      )],
    };
  }
  const viewPrefix = mode === 'LOG' ? 'stock:log_view' : 'stock:view';
  const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${viewPrefix}:previous:${String(Math.max(1, dashboard.page - 1))}`)
      .setLabel('ก่อนหน้า')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(dashboard.page <= 1),
    new ButtonBuilder()
      .setCustomId(`${viewPrefix}:next:${String(Math.min(dashboard.totalPages, dashboard.page + 1))}`)
      .setLabel('ถัดไป')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(dashboard.page >= dashboard.totalPages),
  );
  if (mode === 'MEMBER') {
    navigation.addComponents(
      new ButtonBuilder().setCustomId('stock:withdraw').setLabel('ขอเบิกของ').setEmoji('📝').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('stock:deposit').setLabel('ส่งของเข้าแก๊ง').setEmoji('📥').setStyle(ButtonStyle.Success),
    );
  }
  return { embeds: [embed], components: [navigation] };
}

export type StockMemberAction = 'WITHDRAWAL' | 'DEPOSIT';

export function buildStockItemPicker(
  action: StockMemberAction,
  dashboard: StockDashboard,
  sessionToken: string,
  selectedItemIds: ReadonlySet<string>,
) {
  const isWithdrawal = action === 'WITHDRAWAL';
  const selectedCount = selectedItemIds.size;
  const embed = new EmbedBuilder()
    .setColor(isWithdrawal ? 0x5865f2 : 0x57f287)
    .setTitle(isWithdrawal ? '📝 เลือกของที่ต้องการเบิก' : '📥 เลือกของที่ต้องการส่งเข้าแก๊ง')
    .setDescription(dashboard.items.length === 0
      ? 'ยังไม่มีรายการสิ่งของใน Stock'
      : `เลือกได้หลายรายการและเปลี่ยนหน้าได้ ระบบจะเก็บไว้ในตะกร้า\n🛒 เลือกแล้ว **${selectedCount.toString()} รายการ** · สูงสุด 25 รายการ`)
    .setFooter({ text: `หน้า ${dashboard.page.toString()}/${dashboard.totalPages.toString()} · Stock ทั้งหมด ${dashboard.totalItems.toString()} รายการ` });
  if (dashboard.items.length === 0) return { embeds: [embed], components: [] };

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${stockComponentIds.memberSelectPrefix}${action}:${sessionToken}:${dashboard.page.toString()}`)
    .setPlaceholder(isWithdrawal ? 'เลือกของที่จะเพิ่มลงตะกร้า' : 'เลือกของที่จะส่งเข้าแก๊ง')
    .setMinValues(1)
    .setMaxValues(dashboard.items.length)
    .addOptions(dashboard.items.map((item) => ({
      label: truncate(`${item.itemName}`, 100),
      description: truncate(`คงเหลือ ${item.quantity.toLocaleString('th-TH')} ชิ้น`, 100),
      value: item.id,
      default: selectedItemIds.has(item.id),
    })));
  const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${stockComponentIds.memberPagePrefix}${action}:${sessionToken}:${String(Math.max(1, dashboard.page - 1))}`)
      .setLabel('ก่อนหน้า')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(dashboard.page <= 1),
    new ButtonBuilder()
      .setCustomId(`${stockComponentIds.memberPagePrefix}${action}:${sessionToken}:${String(Math.min(dashboard.totalPages, dashboard.page + 1))}`)
      .setLabel('ถัดไป')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(dashboard.page >= dashboard.totalPages),
    new ButtonBuilder()
      .setCustomId(`${stockComponentIds.memberReviewPrefix}${action}:${sessionToken}`)
      .setLabel(`กรอกจำนวน (${selectedCount.toString()})`)
      .setEmoji('🛒')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(selectedCount === 0),
    new ButtonBuilder()
      .setCustomId(`${stockComponentIds.memberClearPrefix}${action}:${sessionToken}:${dashboard.page.toString()}`)
      .setLabel('ล้างตะกร้า')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(selectedCount === 0),
  );
  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), navigation],
  };
}

export function buildDepositModal(sessionToken: string, items: readonly InventoryItem[]): ModalBuilder {
  const file = new FileUploadBuilder()
    .setCustomId(stockComponentIds.depositFile)
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`${stockComponentIds.depositModalPrefix}${sessionToken}`)
    .setTitle(`ส่งของเข้าแก๊ง · ${items.length.toString()} รายการ`)
    .addLabelComponents(
      new LabelBuilder().setLabel('รายการและจำนวน').setDescription('แก้เฉพาะตัวเลขหลังเครื่องหมาย =').setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(stockComponentIds.selectedItemQuantity)
          .setStyle(TextInputStyle.Paragraph)
          .setValue(buildQuantityTemplate(items))
          .setMinLength(5)
          .setMaxLength(4_000)
          .setRequired(true),
      ),
      new LabelBuilder().setLabel('ที่มาของของ').setDescription('เช่น Loop, Airdrop หรือกิจกรรมอื่น').setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(stockComponentIds.depositSource)
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(2)
          .setMaxLength(200)
          .setRequired(true),
      ),
      new LabelBuilder().setLabel('รูปหลักฐาน 1 รูป (ไม่เกิน 10 MB)').setFileUploadComponent(file),
    );
}

export function buildPreparedDepositLog(prepared: PreparedDeposit, attachmentUrl: string) {
  const embed = buildDepositEmbed({
    requestId: prepared.requestId,
    sender: prepared.sender,
    source: prepared.source,
    status: 'PENDING',
    rejectionReason: null,
    decidedByDiscordUserId: null,
    updatedAt: new Date(),
    items: prepared.items,
  }).setImage(attachmentUrl);
  return { embeds: [embed], components: depositActions(prepared.requestId, false) };
}

export function buildDepositLog(view: DepositRequestView, attachmentUrl?: string) {
  const embed = buildDepositEmbed({
    requestId: view.request.id,
    sender: view.sender,
    source: view.request.source,
    status: view.request.status,
    rejectionReason: view.request.rejectionReason,
    decidedByDiscordUserId: view.request.decidedByDiscordUserId,
    updatedAt: view.request.updatedAt,
    items: view.items,
  });
  if (attachmentUrl !== undefined) embed.setImage(attachmentUrl);
  return {
    embeds: [embed],
    components: depositActions(view.request.id, view.request.status !== 'PENDING'),
  };
}

export function buildDepositRejectionModal(requestId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`stock:deposit_reject_modal:${requestId}`)
    .setTitle('ปฏิเสธรายการส่งของ')
    .addComponents(inputRow(stockComponentIds.depositRejectionReason, 'เหตุผลที่ปฏิเสธ', 2, 500, TextInputStyle.Paragraph));
}

export function buildBatchLog(view: InventoryBatchView) {
  const { batch, movements } = view;
  const lines = movements.slice(0, 40).map(({ movement, item }) => (
    `${movement.quantityChange > 0 ? '📥 +' : '📤 '}${movement.quantityChange.toLocaleString('th-TH')} · **${item.itemName}** · ${movement.quantityBefore.toLocaleString('th-TH')} → ${movement.quantityAfter.toLocaleString('th-TH')}`
  ));
  if (movements.length > 40) lines.push(`… และอีก ${(movements.length - 40).toString()} รายการ (ดูทั้งหมดใน CSV)`);
  const embed = new EmbedBuilder()
    .setColor(batch.sourceType === 'REVERSAL' ? 0xfee75c : 0x5865f2)
    .setTitle(`📦 Stock batch — ${batch.batchRef}`)
    .setDescription(lines.join('\n').slice(0, 4_000) || 'ไม่มี movement เพราะยอดตั้งต้นเป็น 0 ทั้งหมด')
    .addFields(
      { name: 'ประเภท', value: thaiSourceType(batch.sourceType), inline: true },
      { name: 'ผู้ทำรายการ', value: batch.createdByDiscordUserId === 'SYSTEM' ? 'System' : `<@${batch.createdByDiscordUserId}>`, inline: true },
      { name: 'รายละเอียด', value: batch.reason },
    )
    .setTimestamp(batch.createdAt);
  if (batch.reversedAt !== null) embed.addFields({ name: 'สถานะ', value: `ถูกย้อนแล้วโดย <@${batch.reversedByDiscordUserId ?? 'SYSTEM'}>` });
  return { embeds: [embed], components: [] };
}

export function buildBatchManagement(view: InventoryBatchView) {
  const log = buildBatchLog(view);
  const reversible = view.batch.sourceType === 'STOCK_CSV' && view.batch.reversedAt === null;
  return {
    embeds: log.embeds,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`stock:reverse:${view.batch.id}`)
        .setLabel('ย้อน batch')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!reversible),
    )],
  };
}

export function buildStockReversalModal(batchId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`stock:reverse_modal:${batchId}`)
    .setTitle('ย้อน Stock batch')
    .addComponents(inputRow(stockComponentIds.reversalReason, 'เหตุผลย้อนรายการ', 2, 500, TextInputStyle.Paragraph));
}

export function buildWithdrawalModal(sessionToken: string, items: readonly InventoryItem[]): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${stockComponentIds.withdrawalModalPrefix}${sessionToken}`)
    .setTitle(`ขอเบิกของ · ${items.length.toString()} รายการ`)
    .addComponents(
      inputRow(stockComponentIds.selectedItemQuantity, 'รายการและจำนวน (แก้เฉพาะเลขหลัง =)', 5, 4_000, TextInputStyle.Paragraph, buildQuantityTemplate(items, true)),
      inputRow(stockComponentIds.withdrawalReason, 'เหตุผลเบิกของ', 2, 500, TextInputStyle.Paragraph),
    );
}

export function buildWithdrawalLog(view: WithdrawalRequestView) {
  const { request, requester, items, fulfillments } = view;
  const summaryEmbed = new EmbedBuilder()
    .setColor(withdrawalColor(request.status))
    .setTitle(`📝 คำขอเบิกของ — ${requester.inGameName}`)
    .addFields(
      { name: 'สมาชิก', value: `<@${requester.discordUserId}>`, inline: true },
      { name: 'สถานะ', value: thaiWithdrawalStatus(request.status), inline: true },
      { name: 'เหตุผล', value: request.reason },
    )
    .setTimestamp(request.updatedAt);
  if (request.decidedByDiscordUserId !== null) {
    summaryEmbed.addFields({ name: 'ผู้ดำเนินการ', value: `<@${request.decidedByDiscordUserId}>`, inline: true });
  }
  if (request.rejectionReason !== null) {
    summaryEmbed.addFields({ name: 'เหตุผลที่ปฏิเสธ', value: request.rejectionReason });
  }
  const itemsEmbed = new EmbedBuilder()
    .setColor(withdrawalColor(request.status))
    .setTitle(`⌗・รายการขอเบิก (${items.length.toString()})`)
    .addFields(items.map(({ item, requestedQuantity, fulfilledQuantity }, index) => ({
      name: `${String(index + 1).padStart(2, '0')}・${truncate(item.itemName, 70)}`,
      value: [
        `จำนวนที่ขอ: **${requestedQuantity.toLocaleString('th-TH')} ชิ้น**`,
        `จ่ายแล้ว: **${fulfilledQuantity.toLocaleString('th-TH')} ชิ้น**`,
        `Stock คงเหลือ: **${item.quantity.toLocaleString('th-TH')} ชิ้น**`,
      ].join('\n'),
    })));
  if (fulfillments.length > 0) {
    summaryEmbed.addFields({
      name: 'ประวัติการจ่ายล่าสุด',
      value: fulfillments.slice(-5).map((fulfillment) => (
        `• <@${fulfillment.fulfilledByDiscordUserId}> · <t:${String(Math.floor(fulfillment.createdAt.getTime() / 1_000))}:f>${fulfillment.partialReason === null ? '' : ` · ${fulfillment.partialReason}`}`
      )).join('\n'),
    });
  }
  const fulfillmentButton = new ButtonBuilder()
    .setCustomId(`stock:fulfill:${request.id}`)
    .setLabel(request.status === 'FULFILLED' ? 'จ่ายครบแล้ว' : 'จ่ายของ')
    .setStyle(ButtonStyle.Success)
    .setDisabled(request.status === 'FULFILLED' || request.status === 'CANCELLED');
  const rejectionButton = new ButtonBuilder()
    .setCustomId(`stock:withdrawal_reject:${request.id}`)
    .setLabel(request.status === 'CANCELLED' ? 'ปฏิเสธแล้ว' : 'ปฏิเสธ')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(request.status !== 'PENDING');
  return {
    embeds: [summaryEmbed, itemsEmbed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(fulfillmentButton, rejectionButton)],
  };
}

export function buildWithdrawalRejectionModal(requestId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`stock:withdrawal_reject_modal:${requestId}`)
    .setTitle('ปฏิเสธคำขอเบิกของ')
    .addComponents(inputRow(stockComponentIds.withdrawalRejectionReason, 'เหตุผลที่ปฏิเสธ', 2, 500, TextInputStyle.Paragraph));
}

export function buildFulfillmentModal(view: WithdrawalRequestView): ModalBuilder {
  const pendingItems = view.items.filter(({ requestedQuantity, fulfilledQuantity }) => fulfilledQuantity < requestedQuantity);
  const remaining = pendingItems.map(({ item, requestedQuantity, fulfilledQuantity }, index) => (
    `${String(index + 1).padStart(2, '0')} · ${truncate(item.itemName.replaceAll('\n', ' '), 80)} · Stock เหลือ ${item.quantity.toLocaleString('th-TH')} = ${String(requestedQuantity - fulfilledQuantity)}`
  )).join('\n');
  const reason = new TextInputBuilder()
    .setCustomId(stockComponentIds.fulfillmentReason)
    .setLabel('เหตุผลเมื่อจ่ายไม่ครบ (เว้นว่างถ้าจ่ายครบ)')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(false);
  return new ModalBuilder()
    .setCustomId(`stock:fulfill_modal:${view.request.id}`)
    .setTitle('จ่ายของตามคำขอ')
    .addComponents(
      inputRow(stockComponentIds.fulfillmentItems, 'รายการและจำนวนที่จะจ่าย (แก้เลขหลัง =)', 5, 4_000, TextInputStyle.Paragraph, remaining),
      new ActionRowBuilder<TextInputBuilder>().addComponents(reason),
    );
}

function inputRow(
  customId: string,
  label: string,
  minimum: number,
  maximum: number,
  style = TextInputStyle.Short,
  value?: string,
): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style)
    .setMinLength(minimum)
    .setMaxLength(maximum)
    .setRequired(true);
  if (value !== undefined) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function buildQuantityTemplate(items: readonly InventoryItem[], showAvailableQuantity = false): string {
  return items.map((item, index) => (
    `${String(index + 1).padStart(2, '0')} · ${truncate(item.itemName.replaceAll('\n', ' '), 80)}${showAvailableQuantity ? ` · คงเหลือ ${item.quantity.toLocaleString('th-TH')} ชิ้น` : ''} = 1`
  )).join('\n');
}

function thaiSourceType(sourceType: string): string {
  const values: Record<string, string> = {
    OPENING_CSV: 'ยอดตั้งต้น CSV',
    STOCK_CSV: 'เพิ่ม/หักด้วย CSV',
    WITHDRAWAL: 'จ่ายของเบิก',
    DEPOSIT: 'รับของเข้าแก๊ง',
    REVERSAL: 'ย้อนรายการ',
  };
  return values[sourceType] ?? sourceType;
}

function thaiWithdrawalStatus(status: WithdrawalRequestView['request']['status']): string {
  const values = {
    PENDING: 'รอจ่าย',
    PARTIALLY_FULFILLED: 'จ่ายบางส่วน',
    FULFILLED: 'จ่ายครบแล้ว',
    CANCELLED: 'ปฏิเสธ',
  } as const;
  return values[status];
}

function withdrawalColor(status: WithdrawalRequestView['request']['status']): number {
  if (status === 'FULFILLED') return 0x57f287;
  if (status === 'PARTIALLY_FULFILLED') return 0xfee75c;
  if (status === 'CANCELLED') return 0xed4245;
  return 0x5865f2;
}

function buildDepositEmbed(input: {
  readonly requestId: string;
  readonly sender: DepositRequestView['sender'];
  readonly source: string;
  readonly status: DepositRequestView['request']['status'];
  readonly rejectionReason: string | null;
  readonly decidedByDiscordUserId: string | null;
  readonly updatedAt: Date;
  readonly items: readonly DepositRequestView['items'][number][];
}): EmbedBuilder {
  const title = input.status === 'APPROVED'
    ? '✅ รับของเข้า Stock แล้ว'
    : input.status === 'REJECTED'
      ? '❌ ปฏิเสธรายการส่งของ'
      : '⏳ ส่งของเข้าแก๊ง — รอตรวจสอบ';
  const embed = new EmbedBuilder()
    .setColor(depositColor(input.status))
    .setTitle(title)
    .addFields(
      { name: 'ผู้ส่ง', value: `<@${input.sender.discordUserId}> (${input.sender.inGameName})`, inline: true },
      { name: 'สถานะ', value: thaiDepositStatus(input.status), inline: true },
      { name: 'ที่มา', value: input.source },
      ...depositItemFields(input.items),
    )
    .setFooter({ text: `รหัสรายการ ${input.requestId}` })
    .setTimestamp(input.updatedAt);
  if (input.decidedByDiscordUserId !== null) {
    embed.addFields({ name: 'ผู้ตรวจสอบ', value: `<@${input.decidedByDiscordUserId}>`, inline: true });
  }
  if (input.rejectionReason !== null) embed.addFields({ name: 'เหตุผลที่ปฏิเสธ', value: input.rejectionReason });
  return embed;
}

function depositItemFields(items: readonly DepositRequestView['items'][number][]) {
  const namedLines = items.map(({ item, quantity }) => (
    `**${item.itemName.slice(0, 80)}** — **${quantity.toLocaleString('th-TH')} ชิ้น**`
  ));
  const compactLines = items.map(({ item, quantity }) => (
    `**${item.itemName.slice(0, 30)}** — **${quantity.toLocaleString('th-TH')}**`
  ));
  const lines = namedLines.reduce((total, line) => total + line.length + 1, 0) <= 4_200
    ? namedLines
    : compactLines;
  const fields: { name: string; value: string }[] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const line of lines) {
    if (current.length > 0 && currentLength + line.length + 1 > 1_024) {
      fields.push({ name: fields.length === 0 ? `รายการ (${items.length.toString()})` : 'รายการ (ต่อ)', value: current.join('\n') });
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += line.length + 1;
  }
  if (current.length > 0) {
    fields.push({ name: fields.length === 0 ? `รายการ (${items.length.toString()})` : 'รายการ (ต่อ)', value: current.join('\n') });
  }
  return fields;
}

function depositActions(requestId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`stock:deposit_approve:${requestId}`).setLabel('อนุมัติรับเข้า Stock').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`stock:deposit_reject:${requestId}`).setLabel('ปฏิเสธ').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
}

function thaiDepositStatus(status: DepositRequestView['request']['status']): string {
  const values = {
    PENDING: 'รอตรวจสอบ',
    APPROVED: 'รับเข้า Stock แล้ว',
    REJECTED: 'ปฏิเสธ',
    CANCELLED: 'ยกเลิก',
  } as const;
  return values[status];
}

function depositColor(status: DepositRequestView['request']['status']): number {
  if (status === 'APPROVED') return 0x57f287;
  if (status === 'REJECTED') return 0xed4245;
  if (status === 'CANCELLED') return 0x747f8d;
  return 0xfee75c;
}
