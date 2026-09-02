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
import type { FightPosition, Member } from '../db/schema.js';
import type { FightPositionRosterEntry } from '../../modules/fight-positions/service.js';
import { buildMiruEmbed, formatOverview, formatPanelText } from './theme.js';

export const fightPositionComponentIds = {
  add: 'fight:add',
  addModal: 'fight:add_modal',
  nameInput: 'fight:name',
  assign: 'fight:assign',
  editAssignment: 'fight:edit_assignment',
  publish: 'fight:publish',
  manageSelectPrefix: 'fight:manage_select:',
  managePagePrefix: 'fight:manage_page:',
  renamePrefix: 'fight:rename:',
  renameModalPrefix: 'fight:rename_modal:',
  deletePrefix: 'fight:delete:',
  deleteConfirmPrefix: 'fight:delete_confirm:',
  assignMemberPrefix: 'fight:assign_member:',
  assignMemberPagePrefix: 'fight:assign_member_page:',
  editMemberPrefix: 'fight:edit_member:',
  editMemberPagePrefix: 'fight:edit_member_page:',
  assignPositionPrefix: 'fight:assign_position:',
  assignPositionPagePrefix: 'fight:assign_position_page:',
  clearPrefix: 'fight:clear:',
  summaryPagePrefix: 'fight:summary_page:',
} as const;

const selectPageSize = 25;
// MiruEmbedBuilder decorates each line before Discord receives it.
const summaryDescriptionLimit = 3_500;

export function buildFightPositionAdminPanel(positions: readonly FightPosition[], requestedPage = 1) {
  const pageState = paginate(positions, requestedPage, selectPageSize);
  const description = positions.length === 0
    ? 'ยังไม่มีตำแหน่ง Fight กด **เพิ่มตำแหน่ง** เพื่อเริ่มใช้งาน'
    : positions
        .slice(0, 20)
        .map((position, index) => `${(index + 1).toString()}. ⚔️ ${escapeMarkdown(position.name)}`)
        .join('\n');
  const embed = buildMiruEmbed({
    title: 'จัดการตำแหน่ง Fight',
    icon: '⚔️',
    tone: 'primary',
    module: 'Fight Positions',
    description: formatOverview([
      `ตำแหน่งที่ใช้งาน **${positions.length.toString()} รายการ**`,
      positions.length === 0 ? 'เริ่มต้นด้วยปุ่ม **เพิ่มตำแหน่ง**' : 'เลือกตำแหน่งจากรายการด้านล่างเพื่อแก้ไข',
    ]),
  })
    .addFields(positions.length === 0 ? [] : [{ name: 'รายการตำแหน่ง', value: description }])
    .setFooter({ text: `ตำแหน่งที่ใช้งาน ${positions.length.toString()} รายการ` });
  const components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(fightPositionComponentIds.add).setLabel('เพิ่มตำแหน่ง').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(fightPositionComponentIds.assign).setLabel('มอบตำแหน่ง').setEmoji('👥').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(fightPositionComponentIds.editAssignment).setLabel('เปลี่ยน/ถอด').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(fightPositionComponentIds.publish).setLabel('อัปเดตสรุป').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    ),
  ];

  if (pageState.items.length > 0) {
    const selector = new StringSelectMenuBuilder()
      .setCustomId(`${fightPositionComponentIds.manageSelectPrefix}${pageState.page.toString()}`)
      .setPlaceholder(`เลือกตำแหน่งเพื่อแก้ไขหรือลบ • หน้า ${pageState.page.toString()}/${pageState.totalPages.toString()}`)
      .addOptions(pageState.items.map((position) => ({
        label: position.name.slice(0, 100),
        value: position.id,
        emoji: '⚔️',
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector));
    appendPageNavigation(
      components,
      fightPositionComponentIds.managePagePrefix,
      pageState.page,
      pageState.totalPages,
    );
  }
  return { embeds: [embed], components };
}

export function buildFightPositionNameModal(position?: FightPosition): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(fightPositionComponentIds.nameInput)
    .setLabel('ชื่อตำแหน่ง Fight')
    .setPlaceholder('เช่น Main Fight, Support, Driver')
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(80)
    .setRequired(true);
  if (position !== undefined) input.setValue(position.name);

  return new ModalBuilder()
    .setCustomId(position === undefined
      ? fightPositionComponentIds.addModal
      : `${fightPositionComponentIds.renameModalPrefix}${position.id}`)
    .setTitle(position === undefined ? 'เพิ่มตำแหน่ง Fight' : 'เปลี่ยนชื่อตำแหน่ง Fight')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export function buildFightPositionManagement(position: FightPosition) {
  const embed = buildMiruEmbed({
    title: 'รายละเอียดตำแหน่ง Fight',
    icon: '⚔️',
    tone: 'warning',
    module: 'Fight Positions',
    description: `> **${escapeMarkdown(position.name)}**\n\nเลือกการทำงานที่ต้องการจากปุ่มด้านล่าง`,
  })
    .setFooter({ text: `Position ID: ${position.id}` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${fightPositionComponentIds.renamePrefix}${position.id}`)
      .setLabel('เปลี่ยนชื่อ')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${fightPositionComponentIds.deletePrefix}${position.id}`)
      .setLabel('ลบตำแหน่ง')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

export function buildFightPositionDeleteConfirmation(position: FightPosition) {
  const embed = buildMiruEmbed({
    title: 'ยืนยันลบตำแหน่ง Fight',
    icon: '🗑️',
    tone: 'danger',
    module: 'Fight Positions',
    description: `> ตำแหน่ง: **${escapeMarkdown(position.name)}**\n\n⚠️ สมาชิกที่ใช้ตำแหน่งนี้จะถูกเปลี่ยนเป็น **ยังไม่กำหนดตำแหน่ง**`,
  });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${fightPositionComponentIds.deleteConfirmPrefix}${position.id}`)
      .setLabel('ยืนยันลบ')
      .setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

export function buildFightPositionMemberSelector(activeMembers: readonly Member[], requestedPage = 1) {
  return buildMemberSelector(activeMembers, requestedPage, 'ASSIGN');
}

export function buildFightPositionAssignedMemberSelector(assignedMembers: readonly Member[], requestedPage = 1) {
  return buildMemberSelector(assignedMembers, requestedPage, 'EDIT');
}

function buildMemberSelector(
  availableMembers: readonly Member[],
  requestedPage: number,
  mode: 'ASSIGN' | 'EDIT',
) {
  const pageState = paginate(availableMembers, requestedPage, selectPageSize);
  if (pageState.items.length === 0) {
    return {
      content: mode === 'ASSIGN'
        ? formatPanelText('✅', 'มอบตำแหน่ง Fight', 'สมาชิกที่ใช้งานอยู่ทุกคนมีตำแหน่งแล้ว', 'ไม่มีรายการที่ต้องดำเนินการ')
        : formatPanelText('ℹ️', 'เปลี่ยนหรือถอดตำแหน่ง', 'ยังไม่มีสมาชิกที่ได้รับตำแหน่ง Fight', 'มอบตำแหน่งก่อนจึงจะแก้ไขได้'),
      components: [],
    };
  }
  const selectPrefix = mode === 'ASSIGN'
    ? fightPositionComponentIds.assignMemberPrefix
    : fightPositionComponentIds.editMemberPrefix;
  const pagePrefix = mode === 'ASSIGN'
    ? fightPositionComponentIds.assignMemberPagePrefix
    : fightPositionComponentIds.editMemberPagePrefix;
  const selector = new StringSelectMenuBuilder()
    .setCustomId(`${selectPrefix}${pageState.page.toString()}`)
    .setPlaceholder(`เลือกสมาชิกในแก๊ง • หน้า ${pageState.page.toString()}/${pageState.totalPages.toString()}`)
    .addOptions(pageState.items.map((member) => ({
      label: member.inGameName.slice(0, 100),
      description: `Discord ID: ${member.discordUserId}`.slice(0, 100),
      value: member.id,
    })));
  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector),
  ];
  appendPageNavigation(
    components,
    pagePrefix,
    pageState.page,
    pageState.totalPages,
  );
  return {
    content: mode === 'ASSIGN'
      ? formatPanelText('👥', 'เลือกสมาชิก', 'เลือกสมาชิกที่ยังไม่มีตำแหน่ง Fight', 'แสดงเฉพาะสมาชิกที่ลงทะเบียน อนุมัติ และยังไม่ได้รับตำแหน่ง')
      : formatPanelText('🔄', 'เปลี่ยนหรือถอดตำแหน่ง', 'เลือกสมาชิกที่ต้องการแก้ไข', 'แสดงเฉพาะสมาชิกที่มีตำแหน่งอยู่แล้ว'),
    components,
  };
}

export function buildFightPositionAssignmentSelector(
  member: Member,
  positions: readonly FightPosition[],
  requestedPage = 1,
) {
  const pageState = paginate(positions, requestedPage, selectPageSize);
  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [];
  if (pageState.items.length > 0) {
    const selector = new StringSelectMenuBuilder()
      .setCustomId(`${fightPositionComponentIds.assignPositionPrefix}${member.id}:${pageState.page.toString()}`)
      .setPlaceholder(`เลือกตำแหน่ง • หน้า ${pageState.page.toString()}/${pageState.totalPages.toString()}`)
      .addOptions(pageState.items.map((position) => ({
        label: position.name.slice(0, 100),
        value: position.id,
        emoji: '⚔️',
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector));
    appendPageNavigation(
      components,
      `${fightPositionComponentIds.assignPositionPagePrefix}${member.id}:`,
      pageState.page,
      pageState.totalPages,
    );
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${fightPositionComponentIds.clearPrefix}${member.id}`)
      .setLabel('ยังไม่กำหนดตำแหน่ง')
      .setEmoji('➖')
      .setStyle(ButtonStyle.Secondary),
  ));
  return {
    content: formatPanelText(
      '⚔️',
      'เลือกตำแหน่ง Fight',
      `สมาชิก: **${escapeMarkdown(member.inGameName)}**${positions.length === 0 ? '\nยังไม่มีตำแหน่ง Fight กรุณาเพิ่มตำแหน่งก่อน' : ''}`,
      'หนึ่งสมาชิกมีได้หนึ่งตำแหน่ง',
    ),
    components,
  };
}

export function buildFightPositionSummary(roster: readonly FightPositionRosterEntry[], requestedPage = 1) {
  const pages = paginateFightPositionSummary(roster);
  // Preserve compatibility with old navigation buttons. New displays contain
  // all sections in one Discord message instead of making members click pages.
  void requestedPage;
  const assignedCount = roster.filter((entry) => entry.positionId !== null).length;
  const positionCount = new Set(
    roster.flatMap((entry) => entry.positionId === null ? [] : [entry.positionId]),
  ).size;
  const overview = formatOverview([
    `สมาชิกทั้งหมด **${roster.length.toString()} คน**`,
    `กำหนดตำแหน่งแล้ว **${assignedCount.toString()} คน**`,
    `ยังไม่กำหนด **${(roster.length - assignedCount).toString()} คน**`,
    `ตำแหน่งที่ใช้งาน **${positionCount.toString()} ตำแหน่ง**`,
  ]);
  const embeds = pages.map((description, index) => buildMiruEmbed({
    title: `สรุปตำแหน่ง Fight${index === 0 ? '' : ' (ต่อ)'}`,
    icon: '⚔️',
    tone: 'primary',
    module: 'Fight Positions',
    description: `${index === 0 ? `${overview}\n\n` : ''}${description}`,
  }).setFooter({ text: `MIRU SYSTEM • Fight Positions • รายการ ${index + 1}/${pages.length}` }));
  return { embeds, components: [], allowedMentions: { parse: [] as const } };
}

function buildFightPositionGroupSections(entries: readonly FightPositionRosterEntry[]): string[] {
  const groups = new Map<string, { readonly label: string; readonly entries: FightPositionRosterEntry[] }>();
  for (const entry of entries) {
    const key = entry.positionId ?? 'UNASSIGNED';
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.entries.push(entry);
      continue;
    }
    groups.set(key, {
      label: entry.positionName ?? 'ยังไม่กำหนดตำแหน่ง',
      entries: [entry],
    });
  }

  return [...groups.entries()].map(([key, group]) => {
    const lines = group.entries.map((entry, index) => (
      `> **${(index + 1).toString().padStart(2, '0')}・${escapeMarkdown(entry.inGameName)}**  •  <@${entry.discordUserId}>`
    ));
    return `**${key === 'UNASSIGNED' ? '➖' : '⚔️'}・${escapeMarkdown(group.label)} 〔${group.entries.length.toString()} คน〕**\n${lines.join('\n')}`;
  });
}

function paginateFightPositionSummary(roster: readonly FightPositionRosterEntry[]): string[] {
  const sections = buildFightPositionGroupSections(roster);
  if (sections.length === 0) return ['ยังไม่มีสมาชิกที่มีสถานะใช้งาน'];
  const pages: string[] = [];
  let current = '';
  for (const section of sections) {
    const candidate = current.length === 0 ? section : `${current}\n\n${section}`;
    if (current.length > 0 && candidate.length > summaryDescriptionLimit) {
      pages.push(current);
      current = section;
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

function paginate<T>(items: readonly T[], requestedPage: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(requestedPage, 1), totalPages);
  const start = (page - 1) * pageSize;
  return { page, totalPages, items: items.slice(start, start + pageSize) };
}

function appendPageNavigation(
  components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>,
  prefix: string,
  page: number,
  totalPages: number,
): void {
  if (totalPages <= 1) return;
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}${(page - 1).toString()}`)
      .setLabel('ก่อนหน้า')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId(`${prefix}${(page + 1).toString()}`)
      .setLabel('ถัดไป')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === totalPages),
  ));
}
