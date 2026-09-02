import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} from 'discord.js';
import type { Member } from '../db/schema.js';
import { MiruEmbedBuilder as EmbedBuilder, formatOverview, formatPanelText } from './theme.js';

export const componentIds = {
  registerButton: 'member:register',
  registerModal: 'member:register_modal',
  registerNameInput: 'member:in_game_name',
  controlMembers: 'control:members',
  controlActivities: 'control:activities',
  controlAttendance: 'control:attendance',
  controlFinance: 'control:finance',
  controlTreasury: 'control:treasury',
  controlWeekly: 'control:weekly',
  controlStock: 'control:stock',
  controlFightPositions: 'control:fight_positions',
  pendingMemberSelect: 'member:pending_select',
  rejectReasonInput: 'member:reject_reason',
} as const;

export const memberRosterPagePrefix = 'member:roster_page:';
export const memberRosterTitleSelectId = 'member:roster_title';
export const memberRosterMemberSelectPrefix = 'member:roster_member:';
export const memberRosterMemberPagePrefix = 'member:roster_member_page:';

export type RosterTitleSelection = NonNullable<Member['rosterTitle']> | 'NONE';

const memberRosterSelectionPageSize = 25;
// MiruEmbedBuilder prefixes every rendered line with a quote marker, so reserve
// room below Discord's 4,096-character description ceiling.
const memberRosterDescriptionLimit = 3_500;

export function buildRegistrationPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('ลงทะเบียนสมาชิกแก๊ง')
    .setDescription('กดปุ่มด้านล่าง กรอกชื่อในเมือง แล้วรอหัวแก๊ง/รองแก๊งอนุมัติ');
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(componentIds.registerButton).setLabel('ลงทะเบียน').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

export function buildMemberRegistrationRequest(member: Member) {
  const status = registrationStatus(member.status);
  const embed = new EmbedBuilder()
    .setColor(status.color)
    .setTitle('🆕 คำขอลงทะเบียนสมาชิก')
    .addFields(
      { name: 'ชื่อในเมือง', value: escapeMarkdown(member.inGameName), inline: true },
      { name: 'Discord', value: `<@${member.discordUserId}>`, inline: true },
      { name: 'สถานะ', value: status.label, inline: true },
      { name: 'ส่งคำขอเมื่อ', value: `<t:${Math.floor(member.requestedAt.getTime() / 1_000).toString()}:F>` },
    )
    .setTimestamp(member.updatedAt);

  if (member.decidedByDiscordUserId !== null && member.status !== 'PENDING') {
    embed.addFields({ name: 'ดำเนินการโดย', value: `<@${member.decidedByDiscordUserId}>`, inline: true });
  }
  if (member.departureReason !== null && (member.status === 'REJECTED' || member.status === 'FORMER')) {
    embed.addFields({ name: 'เหตุผล', value: escapeMarkdown(member.departureReason) });
  }
  if (member.status !== 'PENDING') {
    return { embeds: [embed], components: [] };
  }

  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`member:approve:${member.id}`)
      .setLabel('อนุมัติ')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`member:reject:${member.id}`)
      .setLabel('ปฏิเสธ')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [actions] };
}

function registrationStatus(status: Member['status']): { readonly label: string; readonly color: number } {
  switch (status) {
    case 'PENDING':
      return { label: '⏳ รอตรวจสอบ', color: 0xfee75c };
    case 'ACTIVE':
      return { label: '✅ อนุมัติแล้ว', color: 0x57f287 };
    case 'REJECTED':
      return { label: '❌ ปฏิเสธแล้ว', color: 0xed4245 };
    case 'FORMER':
      return { label: '🚪 ออกจากแก๊งแล้ว', color: 0x747f8d };
  }
}

export function buildMemberRoster(activeMembers: readonly Member[], requestedPage = 1) {
  const pages = paginateMemberRoster(activeMembers);
  // Preserve compatibility with old navigation buttons. New displays contain
  // all sections in one Discord message instead of making members click pages.
  void requestedPage;
  const embeds = pages.map((visiblePage, index) => {
    const description = visiblePage.members.length === 0
      ? 'ยังไม่มีสมาชิกที่มีสถานะใช้งาน'
      : visiblePage.members
          .map((member, memberIndex) => rosterMemberLine(member, visiblePage.startIndex + memberIndex + 1))
          .join('\n');
    return new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`👥 รายชื่อสมาชิกปัจจุบัน${index === 0 ? '' : ' (ต่อ)'}`)
      .setDescription(description)
      .setFooter({ text: `สมาชิกทั้งหมด ${activeMembers.length.toString()} คน • รายการ ${index + 1}/${pages.length}` })
      .setTimestamp();
  });
  return { embeds, components: [] };
}

function paginateMemberRoster(activeMembers: readonly Member[]): Array<{ readonly members: readonly Member[]; readonly startIndex: number }> {
  if (activeMembers.length === 0) return [{ members: [], startIndex: 0 }];
  const pages: Array<{ members: Member[]; startIndex: number }> = [];
  let currentMembers: Member[] = [];
  let currentLength = 0;
  let startIndex = 0;
  for (const [index, member] of activeMembers.entries()) {
    const line = rosterMemberLine(member, index + 1);
    const nextLength = currentLength === 0 ? line.length : currentLength + line.length + 1;
    if (currentMembers.length > 0 && nextLength > memberRosterDescriptionLimit) {
      pages.push({ members: currentMembers, startIndex });
      currentMembers = [];
      currentLength = 0;
      startIndex = index;
    }
    currentMembers.push(member);
    currentLength = currentLength === 0 ? line.length : currentLength + line.length + 1;
  }
  pages.push({ members: currentMembers, startIndex });
  return pages;
}

function rosterMemberLine(member: Member, index: number): string {
  const title = rosterTitleDisplay(member.rosterTitle);
  return `${index.toString()}. ${title.emoji} **${title.label}** — **${escapeMarkdown(member.inGameName)}** — <@${member.discordUserId}>`;
}

export function buildRosterTitleSelector() {
  const selector = new StringSelectMenuBuilder()
    .setCustomId(memberRosterTitleSelectId)
    .setPlaceholder('เลือกตำแหน่งกำกับในรายชื่อ')
    .addOptions(
      { label: 'หัวแก๊ง', value: 'HEAD', emoji: '👑', description: 'มี 1 คน และได้รับ Role หัวแก๊ง' },
      { label: 'รองแก๊ง', value: 'DEPUTY', emoji: '⭐', description: 'มีหลายคนได้ และได้รับ Role รองแก๊ง' },
      { label: 'บัญชีแก๊ง', value: 'ACCOUNTANT', emoji: '💰', description: 'มี 1 คน ไม่มี Role หรือสิทธิ์พิเศษ' },
      { label: 'สำรอง', value: 'RESERVE', emoji: '🛡️', description: 'มีหลายคนได้ ไม่มี Role หรือสิทธิ์พิเศษ' },
      { label: 'สมาชิกทั่วไป', value: 'NONE', emoji: '👤', description: 'ถอดตำแหน่งและ Role หัว/รอง' },
    );
  return {
    content: formatPanelText('👥', 'จัดตำแหน่งสมาชิก', 'เลือกตำแหน่งกำกับ แล้วเลือกสมาชิกในขั้นตอนถัดไป', 'เฉพาะหัวแก๊งและรองแก๊งที่ซิงก์ Role อัตโนมัติ'),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)],
  };
}

export function buildRosterMemberSelector(
  title: RosterTitleSelection,
  activeMembers: readonly Member[],
  requestedPage = 1,
) {
  const display = title === 'NONE' ? rosterTitleDisplay(null) : rosterTitleDisplay(title);
  const totalPages = Math.max(1, Math.ceil(activeMembers.length / memberRosterSelectionPageSize));
  const page = Math.min(Math.max(requestedPage, 1), totalPages);
  const startIndex = (page - 1) * memberRosterSelectionPageSize;
  const visibleMembers = activeMembers.slice(startIndex, startIndex + memberRosterSelectionPageSize);
  if (visibleMembers.length === 0) {
    return { content: formatPanelText('📭', 'รายชื่อสมาชิก', 'ไม่มีสมาชิกสถานะใช้งานให้เลือก', 'อนุมัติสมาชิกก่อนกำหนดตำแหน่ง'), components: [] };
  }

  const selector = new StringSelectMenuBuilder()
    .setCustomId(`${memberRosterMemberSelectPrefix}${title}:${page.toString()}`)
    .setPlaceholder(`เลือกสมาชิกในแก๊ง • หน้า ${page.toString()}/${totalPages.toString()}`)
    .addOptions(visibleMembers.map((member) => ({
      label: member.inGameName.slice(0, 100),
      description: `Discord ID: ${member.discordUserId}`.slice(0, 100),
      value: member.id,
    })));
  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector),
  ];
  if (totalPages > 1) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${memberRosterMemberPagePrefix}${title}:${(page - 1).toString()}`)
        .setLabel('ก่อนหน้า')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 1),
      new ButtonBuilder()
        .setCustomId(`${memberRosterMemberPagePrefix}${title}:${(page + 1).toString()}`)
        .setLabel('ถัดไป')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === totalPages),
    ));
  }
  return {
    content: formatPanelText(display.emoji, `กำหนดเป็น${display.label}`, 'เลือกสมาชิกที่ต้องการจากรายการด้านล่าง', 'แสดงเฉพาะสมาชิกที่ลงทะเบียนและได้รับอนุมัติแล้ว'),
    components,
  };
}

export function rosterTitleDisplay(title: Member['rosterTitle']): { readonly emoji: string; readonly label: string } {
  switch (title) {
    case 'HEAD':
      return { emoji: '👑', label: 'หัวแก๊ง' };
    case 'DEPUTY':
      return { emoji: '⭐', label: 'รองแก๊ง' };
    case 'ACCOUNTANT':
      return { emoji: '💰', label: 'บัญชีแก๊ง' };
    case 'RESERVE':
      return { emoji: '🛡️', label: 'สำรอง' };
    case null:
      return { emoji: '👤', label: 'สมาชิก' };
  }
}

export function buildRegistrationModal(): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(componentIds.registerNameInput)
    .setLabel('ชื่อในเมือง')
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(80)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(componentIds.registerModal)
    .setTitle('ลงทะเบียนสมาชิก')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export function buildControlPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x00a884)
    .setTitle('MiruBot Control Panel')
    .setDescription(formatOverview([
      'ศูนย์จัดการระบบแก๊งผ่าน Discord',
      'เลือกหมวดงานจากปุ่มด้านล่าง',
      'สิทธิ์ใช้งาน: **Dev • หัวแก๊ง • รองแก๊ง**',
    ]))
    .addFields(
      {
        name: 'ระบบสมาชิกและกิจกรรม',
        value: [
          '👥 **จัดตำแหน่งสมาชิก** — กำหนดหัวแก๊ง รองแก๊ง บัญชี สำรอง หรือสมาชิกทั่วไป',
          '🏆 **กิจกรรม** — สร้างและจัดการกิจกรรม คะแนน ผลงาน และประกาศ',
          '✅ **เช็กชื่อ/ลา** — สร้างรอบ ตั้งเวลาประจำ แก้ผลย้อนหลัง และส่ง Panel แจ้งลา',
          '⚔️ **ตำแหน่ง Fight** — เพิ่ม มอบ เปลี่ยน/ถอด และเผยแพร่สรุปตำแหน่ง',
        ].join('\n'),
      },
      {
        name: 'การเงินและตู้แก๊ง',
        value: [
          '💰 **ค่าปรับ** — สร้างและติดตามค่าปรับ รวมถึงตรวจหลักฐานการชำระ',
          '📦 **Stock/เบิกของ** — จัดการ Stock, CSV, คำขอเบิก และส่งของเข้าแก๊ง',
          '🏦 **เงินกองกลาง** — บันทึกรายรับ–รายจ่าย ยอดตั้งต้น ย้อนรายการ และคำขอเบิกเงิน',
          '🗓️ **เงินรายสัปดาห์** — สร้างรอบเรียกเก็บ กำหนดยอดรายคน และตรวจหลักฐาน',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'ᴍɪʀᴜ sʏsᴛᴇᴍ • Management Control' });

  const firstRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(componentIds.controlMembers).setLabel('จัดตำแหน่งสมาชิก').setEmoji('👥').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(componentIds.controlActivities).setLabel('กิจกรรม').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(componentIds.controlAttendance).setLabel('เช็กชื่อ/ลา').setEmoji('✅').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(componentIds.controlFinance).setLabel('ค่าปรับ').setEmoji('💰').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(componentIds.controlStock).setLabel('Stock/เบิกของ').setEmoji('📦').setStyle(ButtonStyle.Secondary),
  );

  const secondRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(componentIds.controlTreasury).setLabel('เงินกองกลาง').setEmoji('🏦').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(componentIds.controlWeekly).setLabel('เงินรายสัปดาห์').setEmoji('🗓️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(componentIds.controlFightPositions).setLabel('ตำแหน่ง Fight').setEmoji('⚔️').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [firstRow, secondRow] };
}

export function buildPendingMemberSelector(pendingMembers: readonly Member[]) {
  if (pendingMembers.length === 0) {
    return { content: formatPanelText('✅', 'คำขอลงทะเบียน', 'ไม่มีคำขอที่รออนุมัติ', 'รายการทั้งหมดได้รับการตรวจสอบแล้ว'), components: [] };
  }

  const selector = new StringSelectMenuBuilder()
    .setCustomId(componentIds.pendingMemberSelect)
    .setPlaceholder('เลือกสมาชิกที่ต้องการตรวจสอบ')
    .addOptions(
      pendingMembers.map((member) => ({
        label: member.inGameName.slice(0, 100),
        description: `Discord ID: ${member.discordUserId}`.slice(0, 100),
        value: member.id,
      })),
    );

  return {
    content: formatPanelText('🆕', 'คำขอลงทะเบียน', `รออนุมัติ **${pendingMembers.length.toString()} รายการ**`, 'แสดงสูงสุด 25 รายการต่อครั้ง'),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)],
  };
}

export function buildMemberDecision(member: Member) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('ตรวจสอบคำขอสมาชิก')
    .addFields(
      { name: 'ชื่อในเมือง', value: member.inGameName },
      { name: 'Discord', value: `<@${member.discordUserId}>` },
      { name: 'ส่งเมื่อ', value: `<t:${Math.floor(member.requestedAt.getTime() / 1_000).toString()}:F>` },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`member:approve:${member.id}`).setLabel('อนุมัติ').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`member:reject:${member.id}`).setLabel('ปฏิเสธ').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

export function buildRejectModal(memberId: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(componentIds.rejectReasonInput)
    .setLabel('เหตุผลที่ปฏิเสธ')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(2)
    .setMaxLength(500)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`member:reject_modal:${memberId}`)
    .setTitle('ปฏิเสธคำขอสมาชิก')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}
