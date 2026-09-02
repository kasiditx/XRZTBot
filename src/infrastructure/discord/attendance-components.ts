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
import { MiruEmbedBuilder as EmbedBuilder, formatPanelText } from './theme.js';
import type {
  AttendanceRound,
  AttendanceRoundView,
  LeaveView,
} from '../../modules/attendance/service.js';
import type { MemberSelectionOption } from './role-verified-members.js';

export const attendanceComponentIds = {
  adminCreate: 'attendance:admin_create',
  adminRecurring: 'attendance:admin_recurring',
  adminPublishLeave: 'attendance:admin_publish_leave',
  adminRoundSelect: 'attendance:admin_round_select',
  createOpensAt: 'attendance:create_opens_at',
  createClosesAt: 'attendance:create_closes_at',
  recurringName: 'attendance:recurring_name',
  recurringWeekdays: 'attendance:recurring_weekdays',
  recurringOpensAt: 'attendance:recurring_opens_at',
  recurringClosesAt: 'attendance:recurring_closes_at',
  leaveSubmit: 'leave:submit',
  leaveStartsOn: 'leave:starts_on',
  leaveEndsOn: 'leave:ends_on',
  leaveReason: 'leave:reason',
  correctionMember: 'attendance:correction_member',
  correctionResult: 'attendance:correction_result',
  correctionReason: 'attendance:correction_reason',
} as const;

export const attendanceCreateModalId = 'attendance:create_modal';
export const attendanceRecurringModalId = 'attendance:recurring_modal';
export const leaveSubmitModalId = 'leave:submit_modal';
export const leaveEditModalPrefix = 'leave:edit_modal:';

export function buildAttendanceAdminPanel(rounds: readonly AttendanceRound[]) {
  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(attendanceComponentIds.adminCreate).setLabel('สร้างรอบเช็กชื่อ').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(attendanceComponentIds.adminRecurring).setLabel('ตั้งเวลาประจำ').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(attendanceComponentIds.adminPublishLeave).setLabel('ส่ง Panel แจ้งลา').setStyle(ButtonStyle.Secondary),
  );
  if (rounds.length === 0) {
    return {
      content: formatPanelText('✅', 'ระบบเช็กชื่อและแจ้งลา', 'ยังไม่มีรอบเช็กชื่อ', 'สร้างรอบวันนี้หรือตั้งเวลาประจำได้ทันที'),
      components: [actionRow],
    };
  }
  const selector = new StringSelectMenuBuilder()
    .setCustomId(attendanceComponentIds.adminRoundSelect)
    .setPlaceholder('เลือกรอบเพื่อดูหรือแก้ผลย้อนหลัง')
    .addOptions(rounds.slice(0, 25).map((round) => ({
      label: round.title.slice(0, 100),
      description: `${round.attendanceDate} · ${thaiRoundStatus(round.status)}`.slice(0, 100),
      value: round.id,
    })));
  return {
    content: formatPanelText('✅', 'ระบบเช็กชื่อและแจ้งลา', 'จัดการรอบเช็กชื่อ ตารางเวลา และ Panel แจ้งลา', 'เลือกรอบด้านล่างเพื่อดูรายละเอียดหรือแก้ผลย้อนหลัง'),
    components: [actionRow, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)],
  };
}

export function buildCreateRoundModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(attendanceCreateModalId)
    .setTitle('สร้างรอบเช็กชื่อวันนี้')
    .addComponents(
      inputRow(attendanceComponentIds.createOpensAt, 'เวลาเปิด (HH:mm)', '19:00', 4, 5, '19:00'),
      inputRow(attendanceComponentIds.createClosesAt, 'เวลาปิด (HH:mm)', '21:30', 4, 5, '21:30'),
    );
}

export function buildRecurringScheduleModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(attendanceRecurringModalId)
    .setTitle('ตั้งเวลาเช็กชื่อประจำ')
    .addComponents(
      inputRow(attendanceComponentIds.recurringName, 'ชื่อตาราง', 'เช็กชื่อประจำวัน', 2, 100),
      inputRow(attendanceComponentIds.recurringWeekdays, 'วัน: 1=จันทร์ ... 7=อาทิตย์', '1,2,3,4,5,6,7', 1, 13),
      inputRow(attendanceComponentIds.recurringOpensAt, 'เวลาเปิด (HH:mm)', '19:00', 4, 5, '19:00'),
      inputRow(attendanceComponentIds.recurringClosesAt, 'เวลาปิด (HH:mm)', '21:30', 4, 5, '21:30'),
    );
}

export function buildAttendanceAnnouncement(view: AttendanceRoundView) {
  const { round } = view;
  const isOpen = round.status === 'OPEN';
  const embeds = buildAttendanceDescriptions(view).map((description, index) => new EmbedBuilder()
    .setColor(round.status === 'CLOSED' ? 0x747f8d : isOpen ? 0x57f287 : 0xfee75c)
    .setTitle(`✅ ${round.title}${index === 0 ? '' : ' (ต่อ)'}`)
    .setDescription(description)
    .setFooter({ text: round.status === 'CLOSED' ? 'สรุปผลรอบนี้แล้ว' : `สถานะ: ${thaiRoundStatus(round.status)} · รายชื่ออัปเดตอัตโนมัติ` })
    .setTimestamp());

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`attendance:check_in:${round.id}`)
      .setLabel(isOpen ? 'เช็กชื่อ' : round.status === 'CLOSED' ? 'ปิดแล้ว' : 'ยังไม่เปิด')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!isOpen),
  );
  return { embeds, components: [row] };
}

export function buildAttendanceManagement(view: AttendanceRoundView) {
  const message = buildAttendanceAnnouncement(view);
  const correction = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`attendance:correct:${view.round.id}`)
      .setLabel('แก้ผลย้อนหลัง')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(view.round.status !== 'CLOSED'),
  );
  return { embeds: message.embeds, components: [correction] };
}

export function buildCorrectionModal(roundId: string, members: readonly MemberSelectionOption[]): ModalBuilder {
  const member = new StringSelectMenuBuilder()
    .setCustomId(attendanceComponentIds.correctionMember)
    .setPlaceholder('เลือกสมาชิก 1 คน')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(memberOptions(members));
  const result = new StringSelectMenuBuilder()
    .setCustomId(attendanceComponentIds.correctionResult)
    .setPlaceholder('เลือกผลที่ถูกต้อง')
    .addOptions(
      { label: 'มา', value: 'PRESENT' },
      { label: 'ลา', value: 'LEAVE' },
      { label: 'ลาเหตุฉุกเฉิน', value: 'EMERGENCY_LEAVE' },
      { label: 'ขาด', value: 'ABSENT' },
    );
  const reason = new TextInputBuilder()
    .setCustomId(attendanceComponentIds.correctionReason)
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(2)
    .setMaxLength(500)
    .setRequired(true)
    .setPlaceholder('ระบุเหตุผลเพื่อเก็บ Audit log');
  return new ModalBuilder()
    .setCustomId(`attendance:correct_modal:${roundId}`)
    .setTitle('แก้ผลเช็กชื่อย้อนหลัง')
    .addLabelComponents(
      new LabelBuilder().setLabel('สมาชิก').setStringSelectMenuComponent(member),
      new LabelBuilder().setLabel('ผลที่ถูกต้อง').setStringSelectMenuComponent(result),
      new LabelBuilder().setLabel('เหตุผล').setTextInputComponent(reason),
    );
}

export function buildLeavePanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📝 แจ้งลา')
    .setDescription('สมาชิกสามารถแจ้งลาล่วงหน้าได้ทันทีโดยไม่ต้องรออนุมัติ\nถ้าเช็กชื่อแล้วและแจ้งลาภายใน 23:59 ของวันนั้น ระบบจะนับเป็น **ลาเหตุฉุกเฉิน**');
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(attendanceComponentIds.leaveSubmit).setLabel('แจ้งลา').setEmoji('📝').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

export function buildLeaveModal(startsOn: string, endsOn: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(leaveSubmitModalId)
    .setTitle('แจ้งลา')
    .addComponents(
      inputRow(attendanceComponentIds.leaveStartsOn, 'วันเริ่ม (DD/MM/YYYY)', undefined, 7, 10, startsOn),
      inputRow(attendanceComponentIds.leaveEndsOn, 'วันสิ้นสุด (DD/MM/YYYY)', undefined, 7, 10, endsOn),
      inputRow(attendanceComponentIds.leaveReason, 'เหตุผล', 'ระบุเหตุผลการลา', 2, 500, undefined, TextInputStyle.Paragraph),
    );
}

export function buildLeaveEditModal(view: LeaveView, startsOn: string, endsOn: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${leaveEditModalPrefix}${view.leave.id}`)
    .setTitle('แก้ไขใบลา')
    .addComponents(
      inputRow(attendanceComponentIds.leaveStartsOn, 'วันเริ่ม (DD/MM/YYYY)', undefined, 7, 10, startsOn),
      inputRow(attendanceComponentIds.leaveEndsOn, 'วันสิ้นสุด (DD/MM/YYYY)', undefined, 7, 10, endsOn),
      inputRow(attendanceComponentIds.leaveReason, 'เหตุผล', undefined, 2, 500, view.leave.reason, TextInputStyle.Paragraph),
    );
}

export function buildLeaveLog(view: LeaveView) {
  const cancelled = view.leave.status === 'CANCELLED';
  const embed = new EmbedBuilder()
    .setColor(cancelled ? 0xed4245 : 0x5865f2)
    .setTitle(cancelled ? '❌ ยกเลิกใบลา' : '📝 แจ้งลา')
    .addFields(
      { name: 'สมาชิก', value: `<@${view.discordUserId}> (${view.inGameName})`, inline: true },
      { name: 'ช่วงวันที่', value: `${view.leave.startsOn} ถึง ${view.leave.endsOn}`, inline: true },
      { name: 'เหตุผล', value: view.leave.reason },
      { name: 'แจ้งเมื่อ', value: discordTimestamp(view.leave.submittedAt, 'F') },
    )
    .setTimestamp(view.leave.updatedAt);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`leave:edit:${view.leave.id}`).setLabel('แก้ไข').setStyle(ButtonStyle.Primary).setDisabled(cancelled),
    new ButtonBuilder().setCustomId(`leave:cancel:${view.leave.id}`).setLabel('ยกเลิก').setStyle(ButtonStyle.Danger).setDisabled(cancelled),
  );
  return { embeds: [embed], components: [row] };
}

export function buildLeaveCancelConfirmation(leaveId: string) {
  return {
    content: formatPanelText('⚠️', 'ยืนยันยกเลิกใบลา', 'ผลรอบที่ปิดและสรุปไปแล้วจะไม่ถูกเปลี่ยนอัตโนมัติ', 'ตรวจสอบข้อมูลก่อนกดยืนยัน'),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`leave:cancel_confirm:${leaveId}`).setLabel('ยืนยันยกเลิก').setStyle(ButtonStyle.Danger),
    )],
  };
}

function inputRow(
  customId: string,
  label: string,
  placeholder: string | undefined,
  minimum: number,
  maximum: number,
  value?: string,
  style = TextInputStyle.Short,
): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style)
    .setMinLength(minimum)
    .setMaxLength(maximum)
    .setRequired(true);
  if (placeholder !== undefined) input.setPlaceholder(placeholder);
  if (value !== undefined) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function formatAttendanceMembers(
  values: readonly AttendanceRoundView['present'][number][],
  includeTime: boolean,
): string {
  if (values.length === 0) return '—';
  return values.map((member) => {
    const timestamp = includeTime && member.checkedInAt !== null ? ` · ${discordTimestamp(member.checkedInAt, 't')}` : '';
    return `• ${member.inGameName} (<@${member.discordUserId}>)${timestamp}`;
  }).join('\n');
}

function formatLeaveMembers(view: AttendanceRoundView): string {
  const finalized = view.leave.map((member) => `• ${member.inGameName} (<@${member.discordUserId}>)`);
  const active = view.activeLeaves.map((entry) => `• ${entry.inGameName} (<@${entry.discordUserId}>) — ${entry.leave.reason}`);
  return [...finalized, ...active].join('\n') || '—';
}

function buildAttendanceDescriptions(view: AttendanceRoundView): string[] {
  const { round } = view;
  const isClosed = round.status === 'CLOSED';
  const lines = [
    `**วันที่:** ${round.attendanceDate}`,
    `**เปิด:** ${discordTimestamp(round.opensAt, 'F')}`,
    `**ปิด:** ${discordTimestamp(round.closesAt, 'F')}`,
    '',
    `**มา ${String(view.present.length)} คน**`,
    formatAttendanceMembers(view.present, true),
    '',
    `**ลา ${String(view.leave.length + view.activeLeaves.length)} คน**`,
    formatLeaveMembers(view),
    '',
    isClosed ? `**ลาเหตุฉุกเฉิน ${String(view.emergencyLeave.length)} คน**` : `**ยังไม่เช็กชื่อ ${String(view.pending.length)} คน**`,
    isClosed ? formatAttendanceMembers(view.emergencyLeave, false) : formatAttendanceMembers(view.pending, false),
  ];
  if (isClosed) {
    lines.push('', `**ขาด ${String(view.absent.length)} คน**`, formatAttendanceMembers(view.absent, false));
  }
  return splitDiscordDescription(lines, '**รายชื่อ (ต่อ)**');
}

function splitDiscordDescription(lines: readonly string[], continuationHeading: string): string[] {
  // MiruEmbedBuilder decorates every line before sending it to Discord.
  const maximumLength = 3_200;
  const descriptions: string[] = [];
  let current = '';
  for (const line of lines) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (current.length > 0 && candidate.length > maximumLength) {
      descriptions.push(current);
      current = `${continuationHeading}\n${line}`;
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) descriptions.push(current);
  return descriptions.length === 0 ? ['—'] : descriptions;
}

function thaiRoundStatus(status: AttendanceRound['status']): string {
  const labels = { SCHEDULED: 'รอเปิด', OPEN: 'เปิดอยู่', CLOSED: 'ปิดแล้ว', CANCELLED: 'ยกเลิก' } as const;
  return labels[status];
}

function discordTimestamp(value: Date, style: 'F' | 't'): string {
  return `<t:${String(Math.floor(value.getTime() / 1_000))}:${style}>`;
}

function memberOptions(members: readonly MemberSelectionOption[]) {
  return members.slice(0, 25).map((member) => ({
    label: member.inGameName.slice(0, 100),
    description: `@${member.discordUserId}`,
    value: member.discordUserId,
  }));
}
