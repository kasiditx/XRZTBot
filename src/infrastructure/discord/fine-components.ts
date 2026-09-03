import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { buildEvidenceInputLabel, type EvidenceInputMode } from './evidence-images.js';
import { MiruEmbedBuilder as EmbedBuilder, formatPanelText } from './theme.js';
import type {
  Fine,
  FinePaymentProofView,
  FineView,
  PreparedFinePayment,
} from '../../modules/fines/service.js';
import type { MemberSelectionOption } from './role-verified-members.js';

export const fineComponentIds = {
  adminCreate: 'fine:admin_create',
  adminSelect: 'fine:admin_select',
  createMember: 'fine:create_member',
  createReason: 'fine:create_reason',
  createAmount: 'fine:create_amount',
  createSurcharge: 'fine:create_surcharge',
  createDueAt: 'fine:create_due_at',
  paymentAmount: 'fine:payment_amount',
  paymentFile: 'fine:payment_file',
  paymentMediaLink: 'fine:payment_media_link',
  rejectionReason: 'fine:rejection_reason',
  cancellationReason: 'fine:cancellation_reason',
} as const;

export const fineCreateModalId = 'fine:create_modal';

export function buildFineAdminPanel(values: readonly FineView[]) {
  const createRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(fineComponentIds.adminCreate).setLabel('สร้างค่าปรับ').setEmoji('➕').setStyle(ButtonStyle.Success),
  );
  if (values.length === 0) {
    return {
      content: formatPanelText('💸', 'ระบบค่าปรับ', 'ยังไม่มีรายการค่าปรับ', 'กดสร้างค่าปรับเพื่อเพิ่มรายการแรก'),
      components: [createRow],
    };
  }
  const selector = new StringSelectMenuBuilder()
    .setCustomId(fineComponentIds.adminSelect)
    .setPlaceholder('เลือกค่าปรับเพื่อดูรายละเอียดหรือยกเลิก')
    .addOptions(values.slice(0, 25).map(({ fine, member }) => ({
      label: `${member.inGameName} · ${totalDue(fine).toLocaleString('th-TH')}`.slice(0, 100),
      description: `${thaiFineStatus(fine.status)} · ${fine.reason}`.slice(0, 100),
      value: fine.id,
    })));
  return {
    content: formatPanelText('💸', 'ระบบค่าปรับ', 'สร้างค่าปรับใหม่ หรือเลือกรายการล่าสุดเพื่อจัดการ', 'สถานะและยอดค้างจะคำนวณอัตโนมัติ'),
    components: [createRow, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)],
  };
}

export function buildCreateFineModal(dueAt: string, members: readonly MemberSelectionOption[]): ModalBuilder {
  const member = new StringSelectMenuBuilder()
    .setCustomId(fineComponentIds.createMember)
    .setPlaceholder('เลือกสมาชิกที่ต้องการปรับ')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(memberOptions(members));
  return new ModalBuilder()
    .setCustomId(fineCreateModalId)
    .setTitle('สร้างค่าปรับ')
    .addLabelComponents(
      new LabelBuilder().setLabel('สมาชิก').setStringSelectMenuComponent(member),
      new LabelBuilder().setLabel('เหตุผล').setTextInputComponent(textInput(fineComponentIds.createReason, 'ระบุเหตุผลค่าปรับ', 2, 500, TextInputStyle.Paragraph)),
      new LabelBuilder().setLabel('จำนวนเงิน').setTextInputComponent(textInput(fineComponentIds.createAmount, '100000', 1, 15)),
      new LabelBuilder().setLabel('เพิ่มทุก 24 ชม. (ใส่ 0 ถ้าไม่ทบ)').setTextInputComponent(textInput(fineComponentIds.createSurcharge, '50000', 1, 15)),
      new LabelBuilder().setLabel('กำหนดชำระ (DD/MM/YYYY HH:mm)').setTextInputComponent(
        textInput(fineComponentIds.createDueAt, '28/08/2569 19:00', 12, 16, TextInputStyle.Short, dueAt),
      ),
    );
}

export function buildFineAnnouncement(view: FineView) {
  const { fine, member } = view;
  const total = totalDue(fine);
  const embed = new EmbedBuilder()
    .setColor(fineColor(fine.status))
    .setTitle(`💸 ค่าปรับ — ${member.inGameName}`)
    .addFields(
      { name: 'สมาชิก', value: `<@${member.discordUserId}>`, inline: true },
      { name: 'ยอดปัจจุบัน', value: `**${total.toLocaleString('th-TH')}**`, inline: true },
      { name: 'สถานะ', value: thaiFineStatus(fine.status), inline: true },
      { name: 'เหตุผล', value: fine.reason },
      { name: 'กำหนดชำระ', value: discordTimestamp(fine.dueAt, 'F'), inline: true },
      { name: 'เพิ่มทุก 24 ชั่วโมง', value: fine.surchargeAmount.toLocaleString('th-TH'), inline: true },
      { name: 'ยอดเพิ่มสะสม', value: fine.accruedSurchargeAmount.toLocaleString('th-TH'), inline: true },
    )
    .setFooter({ text: 'ต้องชำระเต็มจำนวนและแนบรูปหลักฐาน 1 รูป' })
    .setTimestamp(fine.updatedAt);
  const button = new ButtonBuilder()
    .setCustomId(`fine:pay:${fine.id}`)
    .setLabel(paymentButtonLabel(fine.status))
    .setEmoji('📸')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(fine.status !== 'UNPAID');
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] };
}

export function buildFineManagement(view: FineView) {
  const announcement = buildFineAnnouncement(view);
  const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`fine:cancel:${view.fine.id}`)
      .setLabel('ยกเลิกค่าปรับ')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(view.fine.status !== 'UNPAID'),
  );
  return { embeds: announcement.embeds, components: [cancelRow] };
}

export function buildFinePaymentModal(fine: Fine, evidenceMode: EvidenceInputMode): ModalBuilder {
  const amount = new TextInputBuilder()
    .setCustomId(fineComponentIds.paymentAmount)
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(15)
    .setValue(String(totalDue(fine)))
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`fine:pay_modal:${evidenceMode}:${fine.id}`)
    .setTitle('ส่งหลักฐานชำระค่าปรับ')
    .addLabelComponents(
      new LabelBuilder().setLabel('จำนวนเงินเต็มจำนวน').setTextInputComponent(amount),
      buildEvidenceInputLabel({
        mode: evidenceMode,
        fileCustomId: fineComponentIds.paymentFile,
        linkCustomId: fineComponentIds.paymentMediaLink,
        maximumImages: 1,
        label: 'รูปหลักฐาน',
      }),
    );
}

export function buildPreparedFineProofLog(prepared: PreparedFinePayment) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('⏳ หลักฐานชำระค่าปรับรอตรวจ')
    .addFields(
      { name: 'สมาชิก', value: `<@${prepared.member.discordUserId}> (${prepared.member.inGameName})`, inline: true },
      { name: 'จำนวนเงิน', value: `**${prepared.amount.toLocaleString('th-TH')}**`, inline: true },
      { name: 'ค่าปรับ', value: prepared.fine.reason },
    )
    .setTimestamp();
  return { embeds: [embed], components: proofActionRows(prepared.proofId, false) };
}

export function buildFineProofLog(view: FinePaymentProofView) {
  const { proof, fine, member } = view;
  const embed = new EmbedBuilder()
    .setColor(proof.status === 'APPROVED' ? 0x57f287 : proof.status === 'REJECTED' ? 0xed4245 : 0xfee75c)
    .setTitle(proofStatusTitle(proof.status))
    .addFields(
      { name: 'สมาชิก', value: `<@${member.discordUserId}> (${member.inGameName})`, inline: true },
      { name: 'จำนวนเงิน', value: `**${proof.amount.toLocaleString('th-TH')}**`, inline: true },
      { name: 'ค่าปรับ', value: fine.reason },
      { name: 'ส่งเมื่อ', value: discordTimestamp(proof.submittedAt, 'F') },
    )
    .setTimestamp(proof.updatedAt);
  if (proof.rejectionReason !== null) embed.addFields({ name: 'เหตุผลที่ปฏิเสธ', value: proof.rejectionReason });
  return { embeds: [embed], components: proofActionRows(proof.id, proof.status !== 'PENDING') };
}

export function buildFineRejectionModal(proofId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`fine:reject_modal:${proofId}`)
    .setTitle('ปฏิเสธหลักฐาน')
    .addComponents(inputRow(fineComponentIds.rejectionReason, 'เหตุผลที่ปฏิเสธ', 2, 500, TextInputStyle.Paragraph));
}

export function buildFineCancellationModal(fineId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`fine:cancel_modal:${fineId}`)
    .setTitle('ยกเลิกค่าปรับ')
    .addComponents(inputRow(fineComponentIds.cancellationReason, 'เหตุผลที่ยกเลิก', 2, 500, TextInputStyle.Paragraph));
}

function proofActionRows(proofId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`fine:approve:${proofId}`).setLabel('อนุมัติ').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`fine:reject:${proofId}`).setLabel('ปฏิเสธ').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
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
  value?: string,
): TextInputBuilder {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setStyle(style)
    .setPlaceholder(placeholder)
    .setMinLength(minimum)
    .setMaxLength(maximum)
    .setRequired(true);
  if (value !== undefined) input.setValue(value);
  return input;
}

function totalDue(fine: Fine): number {
  return fine.principalAmount + fine.accruedSurchargeAmount;
}

function thaiFineStatus(status: Fine['status']): string {
  const labels = {
    UNPAID: 'ยังไม่ชำระ',
    PENDING_VERIFICATION: 'รอตรวจหลักฐาน',
    PAID: 'ชำระแล้ว',
    CANCELLED: 'ยกเลิก',
  } as const;
  return labels[status];
}

function fineColor(status: Fine['status']): number {
  if (status === 'PAID') return 0x57f287;
  if (status === 'CANCELLED') return 0x747f8d;
  if (status === 'PENDING_VERIFICATION') return 0xfee75c;
  return 0xed4245;
}

function paymentButtonLabel(status: Fine['status']): string {
  if (status === 'PAID') return 'ชำระแล้ว';
  if (status === 'CANCELLED') return 'ยกเลิกแล้ว';
  if (status === 'PENDING_VERIFICATION') return 'รอตรวจหลักฐาน';
  return 'ส่งหลักฐานชำระ';
}

function proofStatusTitle(status: FinePaymentProofView['proof']['status']): string {
  if (status === 'APPROVED') return '✅ อนุมัติการชำระค่าปรับ';
  if (status === 'REJECTED') return '❌ ปฏิเสธหลักฐานชำระค่าปรับ';
  return '⏳ หลักฐานชำระค่าปรับรอตรวจ';
}

function discordTimestamp(value: Date, style: 'F'): string {
  return `<t:${String(Math.floor(value.getTime() / 1_000))}:${style}>`;
}

function memberOptions(members: readonly MemberSelectionOption[]) {
  return members.slice(0, 25).map((member) => ({
    label: member.inGameName.slice(0, 100),
    description: `@${member.discordUserId}`,
    value: member.discordUserId,
  }));
}
