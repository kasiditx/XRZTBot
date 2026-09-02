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
import type { FightPosition, FightPositionSet, Member } from '../db/schema.js';
import type { FightPositionRosterEntry, FightPositionSetRoster } from '../../modules/fight-positions/service.js';
import { buildMiruEmbed, formatOverview, formatPanelText } from './theme.js';

export const fightPositionComponentIds = {
  addSet: 'fight:set_add',
  addSetModal: 'fight:set_add_modal',
  setNameInput: 'fight:set_name',
  setSelect: 'fight:set_select',
  activateSetPrefix: 'fight:set_activate:',
  add: 'fight:add',
  addModal: 'fight:add_modal',
  nameInput: 'fight:name',
  assignSetPrefix: 'fight:assign_set:',
  editAssignmentSetPrefix: 'fight:edit_assignment_set:',
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
  // Keep this short: Discord custom IDs are limited to 100 characters and
  // this context carries both a Set UUID and a member UUID.
  assignPositionPagePrefix: 'fight:position_page:',
  clearPrefix: 'fight:clear:',
  summaryPagePrefix: 'fight:summary_page:',
} as const;

const selectPageSize = 25;
// MiruEmbedBuilder decorates each line before Discord receives it.
const summaryDescriptionLimit = 3_500;

export function buildFightPositionAdminPanel(
  sets: readonly FightPositionSet[],
  selectedSet: FightPositionSet,
  positions: readonly FightPosition[],
  requestedPage = 1,
) {
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
      `กำลังจัดแผน **${escapeMarkdown(selectedSet.name)}**${selectedSet.isActive ? ' • 🟢 ใช้งานอยู่' : ''}`,
      `Fight Set ทั้งหมด **${sets.length.toString()} Set**`,
      `ตำแหน่งกลาง **${positions.length.toString()} รายการ**`,
      positions.length === 0 ? 'เริ่มต้นด้วยปุ่ม **เพิ่มตำแหน่ง**' : 'เลือกตำแหน่งจากรายการด้านล่างเพื่อแก้ไข',
    ]),
  })
    .addFields(positions.length === 0 ? [] : [{ name: 'รายการตำแหน่ง', value: description }])
    .setFooter({ text: `ตำแหน่งที่ใช้งาน ${positions.length.toString()} รายการ` });
  const components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [];
  if (sets.length > 0) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(fightPositionComponentIds.setSelect)
        .setPlaceholder(`เลือก Fight Set • ปัจจุบัน ${selectedSet.name}`.slice(0, 150))
        .addOptions(sets.slice(0, 25).map((set) => ({
          label: set.name.slice(0, 100),
          description: set.isActive ? 'กำลังใช้งานอยู่' : 'แผนสำรอง',
          value: set.id,
          emoji: set.isActive ? '🟢' : '📋',
          default: set.id === selectedSet.id,
        }))),
    ));
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(fightPositionComponentIds.addSet).setLabel('เพิ่ม Set').setEmoji('🗂️').setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${fightPositionComponentIds.activateSetPrefix}${selectedSet.id}`)
        .setLabel(selectedSet.isActive ? 'กำลังใช้งาน' : 'ใช้ Set นี้')
        .setEmoji('🟢')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(selectedSet.isActive),
      new ButtonBuilder().setCustomId(fightPositionComponentIds.add).setLabel('เพิ่มตำแหน่ง').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${fightPositionComponentIds.assignSetPrefix}${selectedSet.id}`).setLabel('มอบตำแหน่ง').setEmoji('👥').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${fightPositionComponentIds.editAssignmentSetPrefix}${selectedSet.id}`).setLabel('เปลี่ยน/ถอด').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(fightPositionComponentIds.publish).setLabel('อัปเดตสรุปทุก Set').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    ),
  );

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
      `${fightPositionComponentIds.managePagePrefix}${selectedSet.id}:`,
      pageState.page,
      pageState.totalPages,
    );
  }
  return { embeds: [embed], components };
}

export function buildFightPositionSetNameModal(): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(fightPositionComponentIds.setNameInput)
    .setLabel('ชื่อ Fight Set')
    .setPlaceholder('เช่น Set 2, แผนบุก, แผนตั้งรับ')
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(80)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(fightPositionComponentIds.addSetModal)
    .setTitle('เพิ่ม Fight Set')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
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

export function buildFightPositionMemberSelector(
  set: FightPositionSet,
  activeMembers: readonly Member[],
  requestedPage = 1,
) {
  return buildMemberSelector(set, activeMembers, requestedPage, 'ASSIGN');
}

export function buildFightPositionAssignedMemberSelector(
  set: FightPositionSet,
  assignedMembers: readonly Member[],
  requestedPage = 1,
) {
  return buildMemberSelector(set, assignedMembers, requestedPage, 'EDIT');
}

function buildMemberSelector(
  set: FightPositionSet,
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
    .setCustomId(`${selectPrefix}${set.id}:${pageState.page.toString()}`)
    .setPlaceholder(`เลือกสมาชิกใน ${set.name} • หน้า ${pageState.page.toString()}/${pageState.totalPages.toString()}`.slice(0, 150))
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
    `${pagePrefix}${set.id}:`,
    pageState.page,
    pageState.totalPages,
  );
  return {
    content: mode === 'ASSIGN'
      ? formatPanelText('👥', 'เลือกสมาชิก', `Fight Set: **${escapeMarkdown(set.name)}**\nเลือกสมาชิกที่ยังไม่มีตำแหน่ง Fight`, 'แสดงเฉพาะสมาชิกที่ลงทะเบียน อนุมัติ และยังไม่ได้รับตำแหน่ง')
      : formatPanelText('🔄', 'เปลี่ยนหรือถอดตำแหน่ง', `Fight Set: **${escapeMarkdown(set.name)}**\nเลือกสมาชิกที่ต้องการแก้ไข`, 'แสดงเฉพาะสมาชิกที่มีตำแหน่งอยู่แล้ว'),
    components,
  };
}

export function buildFightPositionAssignmentSelector(
  set: FightPositionSet,
  member: Member,
  positions: readonly FightPosition[],
  requestedPage = 1,
) {
  const pageState = paginate(positions, requestedPage, selectPageSize);
  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [];
  if (pageState.items.length > 0) {
    const selector = new StringSelectMenuBuilder()
      .setCustomId(`${fightPositionComponentIds.assignPositionPrefix}${set.id}:${member.id}:${pageState.page.toString()}`)
      .setPlaceholder(`เลือกตำแหน่ง • หน้า ${pageState.page.toString()}/${pageState.totalPages.toString()}`)
      .addOptions(pageState.items.map((position) => ({
        label: position.name.slice(0, 100),
        value: position.id,
        emoji: '⚔️',
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector));
    appendPageNavigation(
      components,
      `${fightPositionComponentIds.assignPositionPagePrefix}${set.id}:${member.id}:`,
      pageState.page,
      pageState.totalPages,
    );
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${fightPositionComponentIds.clearPrefix}${set.id}:${member.id}`)
      .setLabel('ยังไม่กำหนดตำแหน่ง')
      .setEmoji('➖')
      .setStyle(ButtonStyle.Secondary),
  ));
  return {
    content: formatPanelText(
      '⚔️',
      'เลือกตำแหน่ง Fight',
      `Fight Set: **${escapeMarkdown(set.name)}**\nสมาชิก: **${escapeMarkdown(member.inGameName)}**${positions.length === 0 ? '\nยังไม่มีตำแหน่ง Fight กรุณาเพิ่มตำแหน่งก่อน' : ''}`,
      'หนึ่งสมาชิกมีได้หนึ่งตำแหน่ง',
    ),
    components,
  };
}

export function buildFightPositionSummary(setRosters: readonly FightPositionSetRoster[], requestedPage = 1) {
  const pages = paginateFightPositionSummary(setRosters);
  // Preserve compatibility with old navigation buttons. New displays contain
  // all sections in one Discord message instead of making members click pages.
  void requestedPage;
  const activeSetRoster = setRosters.find(({ set }) => set.isActive) ?? setRosters[0];
  const activeRoster = activeSetRoster?.roster ?? [];
  const assignedCount = activeRoster.filter((entry) => entry.positionId !== null).length;
  const positionCount = new Set(
    setRosters.flatMap(({ roster }) => roster.flatMap((entry) => entry.positionId === null ? [] : [entry.positionId])),
  ).size;
  const overview = formatOverview([
    `Fight Set ทั้งหมด **${setRosters.length.toString()} Set**`,
    `Set ที่ใช้งาน **${escapeMarkdown(activeSetRoster?.set.name ?? 'ยังไม่มี')}**`,
    `Set ปัจจุบันกำหนดแล้ว **${assignedCount.toString()}/${activeRoster.length.toString()} คน**`,
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

function paginateFightPositionSummary(setRosters: readonly FightPositionSetRoster[]): string[] {
  if (setRosters.length === 0) return ['ยังไม่มี Fight Set'];
  const sections = setRosters.flatMap(({ set, roster }) => {
    const assignedCount = roster.filter((entry) => entry.positionId !== null).length;
    const setHeader = [
      `# ${set.isActive ? '🟢' : '📋'} ${escapeMarkdown(set.name)}${set.isActive ? ' • ใช้งานอยู่' : ''}`,
      `> กำหนดแล้ว **${assignedCount.toString()} คน** • ยังไม่กำหนด **${(roster.length - assignedCount).toString()} คน**`,
    ].join('\n');
    const groups = buildFightPositionGroupSections(roster);
    return [setHeader, ...(groups.length === 0 ? ['ยังไม่มีสมาชิกที่มีสถานะใช้งาน'] : groups)];
  });
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
