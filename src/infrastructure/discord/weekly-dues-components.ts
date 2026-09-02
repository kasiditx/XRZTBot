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
import type {
  PreparedWeeklyPayment,
  WeeklyCollectionView,
  WeeklyPaymentProofView,
} from '../../modules/weekly-dues/service.js';
import type { MemberSelectionOption } from './role-verified-members.js';

export const weeklyComponentIds = {
  adminCreate: 'weekly:admin_create',
  adminSelect: 'weekly:admin_select',
  createStartsOn: 'weekly:create_starts_on',
  createEndsOn: 'weekly:create_ends_on',
  createAmount: 'weekly:create_amount',
  createInitialFine: 'weekly:create_initial_fine',
  createRecurringFine: 'weekly:create_recurring_fine',
  paymentAmount: 'weekly:payment_amount',
  paymentFile: 'weekly:payment_file',
  overrideMember: 'weekly:override_member',
  overrideAmount: 'weekly:override_amount',
  rejectionReason: 'weekly:rejection_reason',
} as const;

export const weeklyCreateModalId = 'weekly:create_modal';

export function buildWeeklyAdminPanel(values: readonly WeeklyCollectionView[]) {
  const create = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(weeklyComponentIds.adminCreate).setLabel('สร้างรอบส่งเงิน').setEmoji('➕').setStyle(ButtonStyle.Success),
  );
  if (values.length === 0) {
    return {
      content: formatPanelText('🗓️', 'ระบบส่งเงินรายสัปดาห์', 'ยังไม่มีรอบเรียกเก็บ', 'กดสร้างรอบส่งเงินเพื่อเริ่มต้น'),
      components: [create],
    };
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(weeklyComponentIds.adminSelect)
    .setPlaceholder('เลือกรอบเพื่อดูหรือกำหนดยอดเฉพาะคน')
    .addOptions(values.slice(0, 25).map(({ collection }) => ({
      label: collection.title.slice(0, 100),
      description: `${collection.startsOn}–${collection.endsOn} · ${collection.isClosed ? 'ปิดแล้ว' : 'เปิดอยู่'}`.slice(0, 100),
      value: collection.id,
    })));
  return {
    content: formatPanelText('🗓️', 'ระบบส่งเงินรายสัปดาห์', 'จัดการรอบเรียกเก็บและยอดเฉพาะสมาชิก', 'เลือกรอบด้านล่างเพื่อดูสถานะ'),
    components: [create, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  };
}

export function buildCreateWeeklyModal(startsOn: string, endsOn: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(weeklyCreateModalId)
    .setTitle('สร้างรอบส่งเงินรายสัปดาห์')
    .addLabelComponents(
      labelText('วันเริ่ม (DD/MM/YYYY)', weeklyComponentIds.createStartsOn, '27/08/2569', 7, 10, startsOn),
      labelText('วันสิ้นสุด (DD/MM/YYYY)', weeklyComponentIds.createEndsOn, '02/09/2569', 7, 10, endsOn),
      labelText('ยอดมาตรฐานต่อคน', weeklyComponentIds.createAmount, '100000', 1, 15),
      labelText('ค่าปรับครั้งแรกหลังหมดเวลา', weeklyComponentIds.createInitialFine, '50000', 1, 15),
      labelText('ค่าปรับเพิ่มทุก 24 ชม.', weeklyComponentIds.createRecurringFine, '50000', 1, 15),
    );
}

export function buildWeeklyAnnouncement(view: WeeklyCollectionView) {
  const { collection } = view;
  const descriptions = buildWeeklyDescriptions(view);
  const embeds = descriptions.map((description, index) => new EmbedBuilder()
    .setColor(collection.isClosed ? 0x747f8d : 0x5865f2)
    .setTitle(`💰 ${collection.title}${index === 0 ? '' : ' (ต่อ)'}`)
    .setDescription(description)
    .setFooter({ text: collection.isClosed ? 'ปิดรอบแล้ว' : 'แนบรูปหลักฐาน 1 รูปและรอหัวแก๊ง/รองแก๊งตรวจสอบ' })
    .setTimestamp(collection.updatedAt));
  const pay = new ButtonBuilder()
    .setCustomId(`weekly:pay:${collection.id}`)
    .setLabel(collection.isClosed ? 'ปิดรอบแล้ว' : 'ส่งหลักฐาน')
    .setEmoji('📸')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(collection.isClosed);
  return { embeds, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(pay)] };
}

function buildWeeklyDescriptions(view: WeeklyCollectionView): string[] {
  const { collection, obligations } = view;
  const lines = [
    `ช่วงวันที่ **${collection.startsOn} – ${collection.endsOn}**`,
    `ยอดมาตรฐาน **${collection.standardAmount.toLocaleString('th-TH')}**`,
    `ค่าปรับเมื่อหมดเวลา **${collection.overdueFineAmount.toLocaleString('th-TH')}** และเพิ่ม **${collection.recurringFineAmount.toLocaleString('th-TH')}** ทุก 24 ชั่วโมง`,
    '',
    `**สถานะสมาชิก (${obligations.length.toString()} คน)**`,
    ...obligations.map(({ obligation, member }) =>
      `${statusEmoji(obligation.status)} <@${member.discordUserId}> — ${obligation.amount.toLocaleString('th-TH')} · ${thaiStatus(obligation.status)}`),
  ];
  return splitWeeklyDescription(lines);
}

function splitWeeklyDescription(lines: readonly string[]): string[] {
  // MiruEmbedBuilder decorates every line before sending it to Discord.
  const maximumLength = 3_200;
  const descriptions: string[] = [];
  let current = '';
  for (const line of lines) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (current.length > 0 && candidate.length > maximumLength) {
      descriptions.push(current);
      current = `**สถานะสมาชิก (ต่อ)**\n${line}`;
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) descriptions.push(current);
  return descriptions.length === 0 ? ['—'] : descriptions;
}

export function buildWeeklyManagement(view: WeeklyCollectionView) {
  const content = buildWeeklyAnnouncement(view);
  const override = new ButtonBuilder()
    .setCustomId(`weekly:override:${view.collection.id}`)
    .setLabel('กำหนดยอดเฉพาะสมาชิก')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(view.collection.isClosed);
  return { embeds: content.embeds, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(override)] };
}

export function buildWeeklyOverrideModal(collectionId: string, members: readonly MemberSelectionOption[]): ModalBuilder {
  const member = new StringSelectMenuBuilder()
    .setCustomId(weeklyComponentIds.overrideMember)
    .setPlaceholder('เลือกสมาชิกในรอบ')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(memberOptions(members));
  return new ModalBuilder()
    .setCustomId(`weekly:override_modal:${collectionId}`)
    .setTitle('กำหนดยอดเฉพาะสมาชิก')
    .addLabelComponents(
      new LabelBuilder().setLabel('สมาชิก').setStringSelectMenuComponent(member),
      labelText('ยอดใหม่', weeklyComponentIds.overrideAmount, '100000', 1, 15),
    );
}

export function buildWeeklyPaymentModal(view: WeeklyCollectionView, amount: number): ModalBuilder {
  const amountInput = new TextInputBuilder()
    .setCustomId(weeklyComponentIds.paymentAmount)
    .setStyle(TextInputStyle.Short)
    .setValue(String(amount))
    .setMinLength(1)
    .setMaxLength(15)
    .setRequired(true);
  const file = new FileUploadBuilder()
    .setCustomId(weeklyComponentIds.paymentFile)
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`weekly:pay_modal:${view.collection.id}`)
    .setTitle('ส่งเงินรายสัปดาห์')
    .addLabelComponents(
      new LabelBuilder().setLabel('จำนวนเงินเต็มจำนวน').setTextInputComponent(amountInput),
      new LabelBuilder().setLabel('รูปหลักฐาน 1 รูป').setFileUploadComponent(file),
    );
}

export function buildPreparedWeeklyProofLog(prepared: PreparedWeeklyPayment) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('⏳ หลักฐานส่งเงินรายสัปดาห์รอตรวจ')
    .addFields(
      { name: 'สมาชิก', value: `<@${prepared.member.discordUserId}> (${prepared.member.inGameName})`, inline: true },
      { name: 'จำนวนเงิน', value: `**${prepared.amount.toLocaleString('th-TH')}**`, inline: true },
      { name: 'รอบ', value: prepared.collection.title },
    )
    .setTimestamp();
  return { embeds: [embed], components: proofActions(prepared.proofId, false) };
}

export function buildWeeklyProofLog(view: WeeklyPaymentProofView) {
  const embed = new EmbedBuilder()
    .setColor(view.proof.status === 'APPROVED' ? 0x57f287 : view.proof.status === 'REJECTED' ? 0xed4245 : 0xfee75c)
    .setTitle(view.proof.status === 'APPROVED' ? '✅ อนุมัติเงินรายสัปดาห์' : view.proof.status === 'REJECTED' ? '❌ ปฏิเสธเงินรายสัปดาห์' : '⏳ หลักฐานรอตรวจ')
    .addFields(
      { name: 'สมาชิก', value: `<@${view.member.discordUserId}> (${view.member.inGameName})`, inline: true },
      { name: 'จำนวนเงิน', value: `**${view.proof.amount.toLocaleString('th-TH')}**`, inline: true },
      { name: 'รอบ', value: view.collection.title },
    )
    .setTimestamp(view.proof.updatedAt);
  if (view.proof.rejectionReason !== null) embed.addFields({ name: 'เหตุผลที่ปฏิเสธ', value: view.proof.rejectionReason });
  return { embeds: [embed], components: proofActions(view.proof.id, view.proof.status !== 'PENDING') };
}

export function buildWeeklyRejectionModal(proofId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`weekly:reject_modal:${proofId}`)
    .setTitle('ปฏิเสธหลักฐาน')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(weeklyComponentIds.rejectionReason)
        .setLabel('เหตุผลที่ปฏิเสธ')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(2)
        .setMaxLength(500)
        .setRequired(true),
    ));
}

function proofActions(proofId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`weekly:approve:${proofId}`).setLabel('อนุมัติ').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`weekly:reject:${proofId}`).setLabel('ปฏิเสธ').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
}

function labelText(label: string, customId: string, placeholder: string, minimum: number, maximum: number, value?: string): LabelBuilder {
  const input = new TextInputBuilder()
      .setCustomId(customId)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(placeholder)
      .setMinLength(minimum)
      .setMaxLength(maximum)
      .setRequired(true);
  if (value !== undefined) input.setValue(value);
  return new LabelBuilder().setLabel(label).setTextInputComponent(input);
}

function thaiStatus(status: WeeklyCollectionView['obligations'][number]['obligation']['status']): string {
  const values = {
    UNPAID: 'ยังไม่ส่ง',
    EXEMPT: 'ยกเว้น',
    PENDING_VERIFICATION: 'รอตรวจ',
    PAID: 'ชำระแล้ว',
    CONVERTED_TO_FINE: 'เป็นค่าปรับแล้ว',
  } as const;
  return values[status];
}

function statusEmoji(status: WeeklyCollectionView['obligations'][number]['obligation']['status']): string {
  if (status === 'PAID' || status === 'EXEMPT') return '✅';
  if (status === 'PENDING_VERIFICATION') return '⏳';
  if (status === 'CONVERTED_TO_FINE') return '💸';
  return '❌';
}

function memberOptions(members: readonly MemberSelectionOption[]) {
  return members.slice(0, 25).map((member) => ({
    label: member.inGameName.slice(0, 100),
    description: `@${member.discordUserId}`,
    value: member.discordUserId,
  }));
}
