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
  escapeMarkdown,
} from 'discord.js';
import { MiruEmbedBuilder as EmbedBuilder, formatPanelText } from './theme.js';
import type {
  PreparedTreasuryEntry,
  TreasuryDashboard,
  TreasuryEntry,
} from '../../modules/treasury/service.js';
import type { TreasuryWithdrawalRequestView } from '../../modules/treasury-withdrawals/service.js';

export const treasuryComponentIds = {
  adminIncome: 'treasury:admin_income',
  adminExpense: 'treasury:admin_expense',
  adminOpening: 'treasury:admin_opening',
  adminPublishPanel: 'treasury:admin_publish_panel',
  adminPublishWithdrawalPanel: 'treasury:admin_publish_withdrawal_panel',
  adminSelect: 'treasury:admin_select',
  withdrawalRequest: 'treasury:withdrawal_request',
  withdrawalAmount: 'treasury:withdrawal_amount',
  withdrawalReason: 'treasury:withdrawal_reason',
  withdrawalRejectionReason: 'treasury:withdrawal_rejection_reason',
  amount: 'treasury:amount',
  description: 'treasury:description',
  evidence: 'treasury:evidence',
  reversalReason: 'treasury:reversal_reason',
} as const;

export function buildTreasuryAdminPanel(dashboard: TreasuryDashboard) {
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(treasuryComponentIds.adminIncome).setLabel('เพิ่มรายรับ').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(treasuryComponentIds.adminExpense).setLabel('เพิ่มรายจ่าย').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(treasuryComponentIds.adminOpening).setLabel('ยอดตั้งต้น').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(treasuryComponentIds.adminPublishPanel).setLabel('ส่ง/อัปเดตยอดรวม').setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(treasuryComponentIds.adminPublishWithdrawalPanel)
      .setLabel('ส่งแผงเบิกเงิน')
      .setStyle(ButtonStyle.Primary),
  );
  if (dashboard.recentEntries.length === 0) {
    return {
      content: formatPanelText('🏦', 'ระบบเงินกองกลาง', `ยอดปัจจุบัน **${dashboard.balance.toLocaleString('th-TH')}**\nยังไม่มีรายการรับ–จ่าย`, 'เลือกเมนูด้านล่างเพื่อเริ่มต้น'),
      components: [actions],
    };
  }
  const selector = new StringSelectMenuBuilder()
    .setCustomId(treasuryComponentIds.adminSelect)
    .setPlaceholder('เลือกรายการเพื่อดูหรือย้อนรายการ')
    .addOptions(dashboard.recentEntries.slice(0, 25).map((entry) => ({
      label: `${entry.amount > 0 ? '+' : ''}${entry.amount.toLocaleString('th-TH')} · ${entry.description}`.slice(0, 100),
      description: `${thaiEntryType(entry.entryType)} · คงเหลือ ${entry.balanceAfter.toLocaleString('th-TH')}`.slice(0, 100),
      value: entry.id,
    })));
  return {
    content: formatPanelText('🏦', 'ระบบเงินกองกลาง', `ยอดปัจจุบัน **${dashboard.balance.toLocaleString('th-TH')}**`, 'เลือกรายการด้านล่างเพื่อดูหรือย้อนรายการ'),
    components: [actions, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)],
  };
}

export function buildTreasuryWithdrawalPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('💸 เบิกเงินแก๊ง')
    .setDescription(
      'กดปุ่มเพื่อส่งคำขอเบิกเงิน ระบุจำนวนเงินและวัตถุประสงค์\n'
      + 'เมื่อหัวแก๊ง/รองแก๊งอนุมัติ Bot จะหักยอดเงินกองกลางอัตโนมัติ',
    )
    .setFooter({ text: 'ใช้ได้เฉพาะสมาชิกที่ลงทะเบียนและมีสถานะใช้งาน' });
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(treasuryComponentIds.withdrawalRequest)
      .setLabel('ขอเบิกเงิน')
      .setEmoji('💸')
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [actions] };
}

export function buildTreasuryWithdrawalModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('treasury:withdrawal_request_modal')
    .setTitle('ขอเบิกเงินแก๊ง')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('จำนวนเงิน')
        .setTextInputComponent(textInput(treasuryComponentIds.withdrawalAmount, '100000', 1, 15)),
      new LabelBuilder()
        .setLabel('วัตถุประสงค์การเบิก')
        .setTextInputComponent(textInput(
          treasuryComponentIds.withdrawalReason,
          'ระบุว่านำเงินไปใช้อะไร',
          2,
          500,
          TextInputStyle.Paragraph,
        )),
    );
}

export function buildTreasuryWithdrawalRequestLog(view: TreasuryWithdrawalRequestView) {
  const status = withdrawalStatusDisplay(view.request.status);
  const embed = new EmbedBuilder()
    .setColor(status.color)
    .setTitle('💸 คำขอเบิกเงินแก๊ง')
    .addFields(
      {
        name: 'ผู้ขอเบิก',
        value: `<@${view.requester.discordUserId}> (${escapeMarkdown(view.requester.inGameName)})`,
        inline: true,
      },
      { name: 'จำนวนเงิน', value: `**${view.request.amount.toLocaleString('th-TH')}**`, inline: true },
      { name: 'สถานะ', value: status.label, inline: true },
      { name: 'วัตถุประสงค์', value: escapeMarkdown(view.request.reason) },
    )
    .setTimestamp(view.request.createdAt);

  if (view.request.decidedByDiscordUserId !== null) {
    embed.addFields({ name: 'ดำเนินการโดย', value: `<@${view.request.decidedByDiscordUserId}>`, inline: true });
  }
  if (view.request.rejectionReason !== null) {
    embed.addFields({ name: 'เหตุผลปฏิเสธ', value: escapeMarkdown(view.request.rejectionReason) });
  }
  if (view.request.status !== 'PENDING') {
    return { embeds: [embed], components: [] };
  }

  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`treasury:withdrawal_approve:${view.request.id}`)
      .setLabel('อนุมัติ')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`treasury:withdrawal_reject:${view.request.id}`)
      .setLabel('ปฏิเสธ')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`treasury:withdrawal_cancel:${view.request.id}`)
      .setLabel('ยกเลิกคำขอ')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [actions] };
}

export function buildTreasuryWithdrawalRejectionModal(requestId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`treasury:withdrawal_reject_modal:${requestId}`)
    .setTitle('ปฏิเสธคำขอเบิกเงิน')
    .addComponents(inputRow(
      treasuryComponentIds.withdrawalRejectionReason,
      'เหตุผลปฏิเสธ',
      2,
      500,
      TextInputStyle.Paragraph,
    ));
}

export function buildManualTreasuryModal(entryType: 'INCOME' | 'EXPENSE'): ModalBuilder {
  const file = new FileUploadBuilder()
    .setCustomId(treasuryComponentIds.evidence)
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`treasury:manual_modal:${entryType}`)
    .setTitle(entryType === 'INCOME' ? 'เพิ่มรายรับ' : 'เพิ่มรายจ่าย')
    .addLabelComponents(
      new LabelBuilder().setLabel('จำนวนเงิน').setTextInputComponent(textInput(treasuryComponentIds.amount, '100000', 1, 15)),
      new LabelBuilder().setLabel('รายละเอียด').setTextInputComponent(textInput(treasuryComponentIds.description, 'ระบุที่มาหรือวัตถุประสงค์', 2, 500, TextInputStyle.Paragraph)),
      new LabelBuilder().setLabel('รูปหลักฐาน 1 รูป').setFileUploadComponent(file),
    );
}

export function buildOpeningBalanceModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('treasury:opening_modal')
    .setTitle('ตั้งยอดเริ่มต้น')
    .addComponents(inputRow(treasuryComponentIds.amount, 'ยอดตั้งต้น', 1, 15));
}

export function buildTreasuryDashboard(dashboard: TreasuryDashboard) {
  const recent = dashboard.recentEntries.length === 0
    ? 'ยังไม่มีรายการ'
    : dashboard.recentEntries.map((entry) => (
      `• ${entry.amount > 0 ? '+' : ''}${entry.amount.toLocaleString('th-TH')} — ${entry.description} · <t:${String(Math.floor(entry.createdAt.getTime() / 1_000))}:d>`
    )).join('\n').slice(0, 4_000);
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('💰 เงินกองกลาง')
    .setDescription(`ยอดคงเหลือ\n# ${dashboard.balance.toLocaleString('th-TH')}`)
    .addFields({ name: 'รายการล่าสุด', value: recent })
    .setFooter({ text: 'ยอดคำนวณจาก ledger และห้ามติดลบ' })
    .setTimestamp();
  return { embeds: [embed], components: [] };
}

export function buildPreparedTreasuryEntryLog(prepared: PreparedTreasuryEntry) {
  const amountChange = prepared.entryType === 'INCOME' ? prepared.amount : -prepared.amount;
  return {
    embeds: [entryEmbed({
      entryType: prepared.entryType,
      amount: amountChange,
      description: prepared.description,
      balanceAfter: prepared.estimatedBalanceAfter,
      createdAt: new Date(),
      createdByDiscordUserId: prepared.actorDiscordUserId,
    })],
    components: [],
  };
}

export function buildTreasuryEntryLog(entry: TreasuryEntry) {
  return { embeds: [entryEmbed(entry)], components: [] };
}

export function buildTreasuryManagement(entry: TreasuryEntry) {
  const protectedSourceTypes = new Set([
    'FINE_PAYMENT',
    'WEEKLY_PAYMENT',
    'TREASURY_WITHDRAWAL_REQUEST',
  ]);
  const reversible = entry.entryType !== 'REVERSAL'
    && (entry.sourceType === null || !protectedSourceTypes.has(entry.sourceType));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`treasury:reverse:${entry.id}`)
      .setLabel('ย้อนรายการ')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!reversible),
  );
  return { embeds: [entryEmbed(entry)], components: [row] };
}

export function buildTreasuryReversalModal(entryId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`treasury:reverse_modal:${entryId}`)
    .setTitle('ย้อนรายการเงินกองกลาง')
    .addComponents(inputRow(treasuryComponentIds.reversalReason, 'เหตุผลย้อนรายการ', 2, 500, TextInputStyle.Paragraph));
}

function entryEmbed(entry: Pick<TreasuryEntry, 'entryType' | 'amount' | 'description' | 'balanceAfter' | 'createdAt' | 'createdByDiscordUserId'>): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(entry.amount > 0 ? 0x57f287 : 0xed4245)
    .setTitle(`${entry.amount > 0 ? '📥' : '📤'} ${thaiEntryType(entry.entryType)}`)
    .addFields(
      { name: 'จำนวนเงิน', value: `**${entry.amount > 0 ? '+' : ''}${entry.amount.toLocaleString('th-TH')}**`, inline: true },
      { name: 'ยอดคงเหลือ', value: `**${entry.balanceAfter.toLocaleString('th-TH')}**`, inline: true },
      { name: 'ผู้ทำรายการ', value: entry.createdByDiscordUserId === 'SYSTEM' ? 'System' : `<@${entry.createdByDiscordUserId}>`, inline: true },
      { name: 'รายละเอียด', value: entry.description },
    )
    .setTimestamp(entry.createdAt);
}

function thaiEntryType(entryType: TreasuryEntry['entryType']): string {
  const labels = {
    OPENING_BALANCE: 'ยอดตั้งต้น',
    INCOME: 'รายรับ',
    EXPENSE: 'รายจ่าย',
    REVERSAL: 'ย้อนรายการ',
  } as const;
  return labels[entryType];
}

function withdrawalStatusDisplay(status: TreasuryWithdrawalRequestView['request']['status']): {
  readonly label: string;
  readonly color: number;
} {
  switch (status) {
    case 'PENDING':
      return { label: '⏳ รออนุมัติ', color: 0xfee75c };
    case 'APPROVED':
      return { label: '✅ อนุมัติแล้ว', color: 0x57f287 };
    case 'REJECTED':
      return { label: '❌ ปฏิเสธแล้ว', color: 0xed4245 };
    case 'CANCELLED':
      return { label: '🚫 ยกเลิกแล้ว', color: 0x747f8d };
  }
}

function inputRow(
  customId: string,
  label: string,
  minimum: number,
  maximum: number,
  style = TextInputStyle.Short,
): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(customId).setLabel(label).setStyle(style).setMinLength(minimum).setMaxLength(maximum).setRequired(true),
  );
}

function textInput(
  customId: string,
  placeholder: string,
  minimum: number,
  maximum: number,
  style = TextInputStyle.Short,
): TextInputBuilder {
  return new TextInputBuilder()
    .setCustomId(customId)
    .setStyle(style)
    .setPlaceholder(placeholder)
    .setMinLength(minimum)
    .setMaxLength(maximum)
    .setRequired(true);
}
