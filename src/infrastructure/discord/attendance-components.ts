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
  AttendanceRound,
  AttendanceRoundView,
  AttendanceMode,
  LeaveView,
} from '../../modules/attendance/service.js';
import type { MemberSelectionOption } from './role-verified-members.js';

export const attendanceComponentIds = {
  adminCreate: 'attendance:admin_create',
  adminRecurring: 'attendance:admin_recurring',
  adminPublishLeave: 'attendance:admin_publish_leave',
  adminRoundSelect: 'attendance:admin_round_select',
  createType: 'attendance:create_type',
  createTitle: 'attendance:create_title',
  createEventAt: 'attendance:create_event_at',
  createOpensAt: 'attendance:create_opens_at',
  createClosesAt: 'attendance:create_closes_at',
  createBeforeMinutes: 'attendance:create_before_minutes',
  createAfterMinutes: 'attendance:create_after_minutes',
  recurringType: 'attendance:recurring_type',
  recurringName: 'attendance:recurring_name',
  recurringWeekdays: 'attendance:recurring_weekdays',
  recurringEventAt: 'attendance:recurring_event_at',
  recurringOpensAt: 'attendance:recurring_opens_at',
  recurringClosesAt: 'attendance:recurring_closes_at',
  recurringBeforeMinutes: 'attendance:recurring_before_minutes',
  recurringAfterMinutes: 'attendance:recurring_after_minutes',
  proofFile: 'attendance:proof_file',
  leaveSubmit: 'leave:submit',
  leaveStartsOn: 'leave:starts_on',
  leaveEndsOn: 'leave:ends_on',
  leaveReason: 'leave:reason',
  correctionMember: 'attendance:correction_member',
  correctionResult: 'attendance:correction_result',
  correctionReason: 'attendance:correction_reason',
} as const;

export const attendanceCreateModalPrefix = 'attendance:create_modal:';
export const attendanceRecurringModalPrefix = 'attendance:recurring_modal:';
export const attendanceProofModalPrefix = 'attendance:proof_modal:';
export const leaveSubmitModalId = 'leave:submit_modal';
export const leaveEditModalPrefix = 'leave:edit_modal:';

export function buildAttendanceAdminPanel(rounds: readonly AttendanceRound[]) {
  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(attendanceComponentIds.adminCreate).setLabel('เปิดเช็กชื่อเอง').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(attendanceComponentIds.adminRecurring).setLabel('ตั้ง Auto').setStyle(ButtonStyle.Primary),
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

export function buildAttendanceModeSelector(purpose: 'MANUAL' | 'AUTO') {
  const isManual = purpose === 'MANUAL';
  const selector = new StringSelectMenuBuilder()
    .setCustomId(isManual ? attendanceComponentIds.createType : attendanceComponentIds.recurringType)
    .setPlaceholder('เลือกรูปแบบเช็กชื่อ')
    .addOptions(
      { label: 'รอบ Airdrop', value: 'AIRDROP', emoji: '🪂', description: 'สมาชิกต้องแนบรูปตัวละครและรายชื่อในวอ' },
      { label: 'เช็กชื่อทั่วไป', value: 'GENERAL', emoji: '✅', description: 'ใช้กับซ้อม ประชุม หรือกิจกรรมทั่วไป' },
    );
  return {
    content: formatPanelText(
      '✅',
      isManual ? 'เปิดเช็กชื่อเอง' : 'ตั้ง Auto เช็กชื่อ',
      'เลือกแบบรอบ Airdrop หรือแบบทั่วไป',
      isManual ? 'รายการ Manual จะแยกจาก Auto' : 'สร้างได้หลายรายการในวันเดียวกัน',
    ),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)],
  };
}

export interface CreateRoundModalDefaults {
  readonly title: string;
  readonly eventAt: string;
  readonly opensAt: string;
  readonly closesAt: string;
}

export function buildCreateRoundModal(mode: AttendanceMode, defaults: CreateRoundModalDefaults): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${attendanceCreateModalPrefix}${mode}`)
    .setTitle(mode === 'AIRDROP' ? 'เปิดรอบ Airdrop' : 'เปิดเช็กชื่อทั่วไป')
    .addComponents(inputRow(attendanceComponentIds.createTitle, 'ชื่อรายการ', 'Airdrop 21:00', 2, 100, defaults.title));
  if (mode === 'AIRDROP') {
    return modal.addComponents(
      inputRow(attendanceComponentIds.createEventAt, 'เวลา Airdrop (DD/MM/YYYY HH:mm)', undefined, 12, 16, defaults.eventAt),
      inputRow(attendanceComponentIds.createBeforeMinutes, 'เปิดก่อน Airdrop กี่นาที', '10', 1, 4, '10'),
      inputRow(attendanceComponentIds.createAfterMinutes, 'ปิดหลัง Airdrop กี่นาที', '10', 1, 4, '10'),
    );
  }
  return modal.addComponents(
    inputRow(attendanceComponentIds.createOpensAt, 'เปิด (DD/MM/YYYY HH:mm)', undefined, 12, 16, defaults.opensAt),
    inputRow(attendanceComponentIds.createClosesAt, 'ปิด (DD/MM/YYYY HH:mm)', undefined, 12, 16, defaults.closesAt),
  );
}

export function buildRecurringScheduleModal(mode: AttendanceMode): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${attendanceRecurringModalPrefix}${mode}`)
    .setTitle(mode === 'AIRDROP' ? 'ตั้ง Auto รอบ Airdrop' : 'ตั้ง Auto เช็กชื่อทั่วไป')
    .addComponents(
      inputRow(attendanceComponentIds.recurringName, 'ชื่อ Auto', mode === 'AIRDROP' ? 'Airdrop 21:00' : 'ซ้อมไฟต์', 2, 100),
      inputRow(attendanceComponentIds.recurringWeekdays, 'วัน: 1=จันทร์ ... 7=อาทิตย์', '1,2,3,4,5,6,7', 1, 13),
    );
  if (mode === 'AIRDROP') {
    return modal.addComponents(
      inputRow(attendanceComponentIds.recurringEventAt, 'เวลา Airdrop (HH:mm)', '21:00', 4, 5, '21:00'),
      inputRow(attendanceComponentIds.recurringBeforeMinutes, 'เปิดก่อน Airdrop กี่นาที', '10', 1, 4, '10'),
      inputRow(attendanceComponentIds.recurringAfterMinutes, 'ปิดหลัง Airdrop กี่นาที', '10', 1, 4, '10'),
    );
  }
  return modal.addComponents(
    inputRow(attendanceComponentIds.recurringOpensAt, 'เวลาเปิด (HH:mm)', '19:00', 4, 5, '19:00'),
    inputRow(attendanceComponentIds.recurringClosesAt, 'เวลาปิด (HH:mm)', '21:30', 4, 5, '21:30'),
  );
}

export function buildAttendanceProofModal(roundId: string): ModalBuilder {
  const file = new FileUploadBuilder()
    .setCustomId(attendanceComponentIds.proofFile)
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`${attendanceProofModalPrefix}${roundId}`)
    .setTitle('แนบรูปเช็กชื่อ Airdrop')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('รูปตัวละครของตัวเองและรายชื่อในวอ')
        .setFileUploadComponent(file),
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
      .setLabel(attendanceButtonLabel(round))
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

export function buildAttendanceProofLog(
  round: AttendanceRound,
  member: { readonly discordUserId: string; readonly inGameName: string },
) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('📸 หลักฐานเช็กชื่อ Airdrop')
      .addFields(
        { name: 'รายการ', value: round.title },
        { name: 'สมาชิก', value: `<@${member.discordUserId}> (${member.inGameName})` },
        { name: 'ข้อกำหนด', value: 'รูปต้องเห็นตัวละครของตัวเองและรายชื่อในวอ' },
      )
      .setTimestamp()],
  };
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
  guildId: string,
): string {
  if (values.length === 0) return '—';
  return values.map((member) => {
    const timestamp = includeTime && member.checkedInAt !== null ? ` · ${discordTimestamp(member.checkedInAt, 't')}` : '';
    const proof = member.proofChannelId === null || member.proofMessageId === null
      ? ''
      : ` · [ดูรูป](https://discord.com/channels/${guildId}/${member.proofChannelId}/${member.proofMessageId})`;
    return `• ${member.inGameName} (<@${member.discordUserId}>)${timestamp}${proof}`;
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
    `**รูปแบบ:** ${round.mode === 'AIRDROP' ? 'รอบ Airdrop' : 'เช็กชื่อทั่วไป'}`,
    `**วันที่:** ${round.attendanceDate}`,
    ...(round.eventAt === null ? [] : [`**เวลา Airdrop:** ${discordTimestamp(round.eventAt, 'F')}`]),
    `**เปิด:** ${discordTimestamp(round.opensAt, 'F')}`,
    `**ปิด:** ${discordTimestamp(round.closesAt, 'F')}`,
    ...(round.mode === 'AIRDROP' ? ['', '📸 แนบรูปที่เห็นตัวละครของตัวเองและรายชื่อในวอ รูปที่ใช้ในรอบอื่นแล้วจะส่งซ้ำไม่ได้'] : []),
    '',
    `**มา ${String(view.present.length)} คน**`,
    formatAttendanceMembers(view.present, true, round.guildId),
    '',
    `**ลา ${String(view.leave.length + view.activeLeaves.length)} คน**`,
    formatLeaveMembers(view),
    '',
    isClosed ? `**ลาเหตุฉุกเฉิน ${String(view.emergencyLeave.length)} คน**` : `**ยังไม่เช็กชื่อ ${String(view.pending.length)} คน**`,
    isClosed
      ? formatAttendanceMembers(view.emergencyLeave, false, round.guildId)
      : formatAttendanceMembers(view.pending, false, round.guildId),
  ];
  if (isClosed) {
    lines.push('', `**ขาด ${String(view.absent.length)} คน**`, formatAttendanceMembers(view.absent, false, round.guildId));
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

function attendanceButtonLabel(round: AttendanceRound): string {
  if (round.status === 'CLOSED') return 'ปิดแล้ว';
  if (round.status !== 'OPEN') return 'ยังไม่เปิด';
  return round.mode === 'AIRDROP' ? 'แนบรูปเช็กชื่อ' : 'เช็กชื่อ';
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
