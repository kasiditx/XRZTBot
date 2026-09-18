import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} from 'discord.js';
import type { InventoryItem } from '../../modules/inventory/service.js';
import { buildWeeklyItemRequirementTemplate } from '../../modules/weekly-items/rules.js';
import type {
  WeeklyItemCollectionView,
  WeeklyItemObligationView,
  WeeklyItemProofView,
} from '../../modules/weekly-items/service.js';
import type { EvidenceInputMode } from './evidence-images.js';
import { buildEvidenceInputLabel } from './evidence-images.js';
import type { MemberSelectionOption } from './role-verified-members.js';
import { MiruEmbedBuilder as EmbedBuilder, formatPanelText } from './theme.js';

export const weeklyItemsComponentIds = {
  adminCreate: 'weekly-items:admin_create',
  adminSelect: 'weekly-items:admin_select',
  createTitle: 'weekly-items:create_title',
  createStartsOn: 'weekly-items:create_starts_on',
  createEndsOn: 'weekly-items:create_ends_on',
  createRequirements: 'weekly-items:create_requirements',
  evidenceMethod: 'weekly-items:evidence_method',
  proofFile: 'weekly-items:proof_file',
  proofMediaLink: 'weekly-items:proof_media_link',
  rejectionReason: 'weekly-items:rejection_reason',
  memberRuleMember: 'weekly-items:member_rule_member',
  memberRuleAction: 'weekly-items:member_rule_action',
  memberRuleReason: 'weekly-items:member_rule_reason',
  cancellationReason: 'weekly-items:cancellation_reason',
} as const;

export function buildWeeklyItemsAdminPanel(values: readonly WeeklyItemCollectionView[]) {
  const create = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(weeklyItemsComponentIds.adminCreate).setLabel('สร้างรอบส่งของ').setEmoji('📦').setStyle(ButtonStyle.Primary),
  );
  if (values.length === 0) {
    return {
      content: formatPanelText('📦', 'ส่งของประจำสัปดาห์', 'ยังไม่มีรอบส่งของ', 'กดปุ่มเพื่อสร้างรอบแรก'),
      components: [create],
    };
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(weeklyItemsComponentIds.adminSelect)
    .setPlaceholder('เลือกรอบเพื่อจัดการผู้ส่งหรือยกเว้น')
    .addOptions(values.slice(0, 25).map(({ collection }) => ({
      label: collection.title.slice(0, 100),
      description: `${collection.startsOn}–${collection.endsOn} · ${collection.isClosed ? 'ปิดแล้ว' : 'เปิดอยู่'}`.slice(0, 100),
      value: collection.id,
    })));
  return {
    content: formatPanelText('📦', 'ส่งของประจำสัปดาห์', 'สร้างรอบและจัดการผู้ที่ต้องส่งหรือได้รับยกเว้น', 'เลือกรอบด้านล่างเพื่อดูรายละเอียด'),
    components: [create, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  };
}

export function buildCreateWeeklyItemsModal(items: readonly InventoryItem[], startsOn: string, endsOn: string): ModalBuilder {
  if (items.length === 0) throw new Error('Cannot build weekly items modal without stock items');
  const template = buildWeeklyItemRequirementTemplate(items.slice(0, 10));
  return new ModalBuilder()
    .setCustomId('weekly-items:create_modal')
    .setTitle('สร้างรอบส่งของประจำสัปดาห์')
    .addLabelComponents(
      textLabel('ชื่อรอบ', weeklyItemsComponentIds.createTitle, 'เช่น ส่งของประจำสัปดาห์ 18/09–24/09', 2, 100),
      textLabel('วันที่เริ่ม (DD/MM/YYYY)', weeklyItemsComponentIds.createStartsOn, '18/09/2569', 8, 10, startsOn),
      textLabel('วันที่สิ้นสุด (DD/MM/YYYY)', weeklyItemsComponentIds.createEndsOn, '24/09/2569', 8, 10, endsOn),
      new LabelBuilder()
        .setLabel('รายการ = ส่ง | ปรับครั้งแรก | เพิ่มทุก 24 ชม.')
        .setDescription('ลบบรรทัดที่ไม่ใช้ และแก้เฉพาะตัวเลขหลังเครื่องหมาย =')
        .setTextInputComponent(new TextInputBuilder()
          .setCustomId(weeklyItemsComponentIds.createRequirements)
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(5)
          .setMaxLength(4_000)
          .setValue(template)
          .setRequired(true)),
    );
}

export function buildWeeklyItemsAnnouncement(view: WeeklyItemCollectionView) {
  const requirementLines = view.requirements.map(({ requirement, item }) =>
    `**${escapeMarkdown(item.itemName)}** — ส่ง **${formatQuantity(requirement.requiredQuantity)} ชิ้น** · ปรับครั้งแรก +${formatQuantity(requirement.initialPenaltyQuantity)} · ทุก 24 ชม. +${formatQuantity(requirement.recurringPenaltyQuantity)}`);
  const currentItems = (
    view.obligations.find(({ obligation }) => obligation.status === 'UNPAID')
      ?? view.obligations.find(({ obligation }) => obligation.status === 'PENDING_VERIFICATION')
  )?.items ?? [];
  const statusLines = view.obligations.map((obligation) => obligationStatusLine(obligation));
  const chunks = chunkLines(statusLines, 12);
  const embeds = [new EmbedBuilder()
    .setColor(view.collection.cancelledAt !== null ? 0xed4245 : view.collection.isClosed ? 0x57f287 : 0x5865f2)
    .setTitle(`📦 ${view.collection.title}`)
    .setDescription([
      `ช่วงวันที่ **${view.collection.startsOn} – ${view.collection.endsOn}**`,
      'สมาชิกต้องส่งของครบตามยอดทั้งหมดในครั้งเดียว',
      '',
      '**รายการที่ต้องส่งต่อสมาชิก**',
      ...requirementLines,
      ...(currentItems.length === 0 ? [] : [
        '',
        `**ยอดปัจจุบันที่ต้องส่งครบในครั้งเดียว**${view.collection.penaltyRunCount > 0 ? ` · ค่าปรับแล้ว ${view.collection.penaltyRunCount.toString()} รอบ` : ''}`,
        ...currentItems.map(({ item, quantity }) => `**${escapeMarkdown(item.itemName)}** — **${formatQuantity(quantity)} ชิ้น**`),
      ]),
      '',
      `**สถานะสมาชิก (${view.obligations.length.toString()} คน)**`,
      ...(chunks[0] ?? []),
      ...(view.collection.cancelledAt === null ? [] : ['', `🚫 ยกเลิกรอบ: ${escapeMarkdown(view.collection.cancellationReason ?? '-')}`]),
    ].join('\n'))
    .setTimestamp(view.collection.updatedAt)];
  for (const [index, chunk] of chunks.slice(1).entries()) {
    embeds.push(new EmbedBuilder().setColor(0x5865f2).setTitle(`สถานะสมาชิก • ต่อ ${(index + 2).toString()}`).setDescription(chunk.join('\n')));
  }
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`weekly-items:submit:${view.collection.id}`)
      .setLabel(view.collection.isClosed ? 'ปิดรอบแล้ว' : 'ส่งหลักฐาน')
      .setEmoji('📸')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(view.collection.isClosed),
  );
  return { embeds, components: [actions] };
}

export function buildWeeklyItemsManagement(view: WeeklyItemCollectionView) {
  return {
    embeds: buildWeeklyItemsAnnouncement(view).embeds,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`weekly-items:member_rule:${view.collection.id}`).setLabel('จัดการผู้ส่ง/ยกเว้น').setStyle(ButtonStyle.Primary).setDisabled(view.collection.isClosed),
      new ButtonBuilder().setCustomId(`weekly-items:cancel:${view.collection.id}`).setLabel('ยกเลิกรอบ').setStyle(ButtonStyle.Danger).setDisabled(view.collection.isClosed),
    )],
  };
}

export function buildWeeklyItemsMemberRuleModal(collectionId: string, members: readonly MemberSelectionOption[]): ModalBuilder {
  const member = new StringSelectMenuBuilder().setCustomId(weeklyItemsComponentIds.memberRuleMember)
    .setPlaceholder('เลือกสมาชิกในรอบ').setMinValues(1).setMaxValues(1)
    .addOptions(members.slice(0, 25).map((candidate) => ({
      label: candidate.inGameName.slice(0, 100), value: candidate.discordUserId,
      description: `Discord ID: ${candidate.discordUserId}`.slice(0, 100),
    })));
  const action = new StringSelectMenuBuilder().setCustomId(weeklyItemsComponentIds.memberRuleAction)
    .setPlaceholder('เลือกสถานะ').setMinValues(1).setMaxValues(1)
    .addOptions(
      { label: 'ต้องส่งของ', value: 'REQUIRED', emoji: '📦' },
      { label: 'ยกเว้นส่งของ', value: 'EXEMPT', emoji: '🛡️' },
    );
  const reason = new TextInputBuilder().setCustomId(weeklyItemsComponentIds.memberRuleReason)
    .setStyle(TextInputStyle.Short).setPlaceholder('เว้นว่างเพื่อใช้ “ยกเว้นโดย Admin”').setMaxLength(200).setRequired(false);
  return new ModalBuilder().setCustomId(`weekly-items:member_rule_modal:${collectionId}`).setTitle('จัดการผู้ส่งของประจำสัปดาห์')
    .addLabelComponents(
      new LabelBuilder().setLabel('สมาชิก').setStringSelectMenuComponent(member),
      new LabelBuilder().setLabel('สถานะ').setStringSelectMenuComponent(action),
      new LabelBuilder().setLabel('เหตุผลยกเว้น').setTextInputComponent(reason),
    );
}

export function buildWeeklyItemsProofModal(collectionId: string, evidenceMode: EvidenceInputMode): ModalBuilder {
  return new ModalBuilder().setCustomId(`weekly-items:submit_modal:${evidenceMode}:${collectionId}`)
    .setTitle('ส่งของประจำสัปดาห์')
    .addLabelComponents(buildEvidenceInputLabel({
      mode: evidenceMode,
      fileCustomId: weeklyItemsComponentIds.proofFile,
      linkCustomId: weeklyItemsComponentIds.proofMediaLink,
      maximumImages: 1,
      label: 'รูปหลักฐานส่งของครบตามยอด',
    }));
}

export function buildPreparedWeeklyItemsProofLog(
  proofId: string,
  collection: WeeklyItemCollectionView['collection'],
  obligation: WeeklyItemObligationView,
) {
  return proofLogContent(proofId, collection.title, obligation.member, obligation.items, 'PENDING', null, new Date());
}

export function buildWeeklyItemsProofLog(view: WeeklyItemProofView) {
  return proofLogContent(
    view.proof.id,
    view.collection.title,
    view.member,
    view.items,
    view.proof.status,
    view.proof.rejectionReason,
    view.proof.updatedAt,
  );
}

export function buildWeeklyItemsRejectionModal(proofId: string): ModalBuilder {
  return new ModalBuilder().setCustomId(`weekly-items:reject_modal:${proofId}`).setTitle('ปฏิเสธหลักฐานส่งของ')
    .addLabelComponents(new LabelBuilder().setLabel('เหตุผลที่ปฏิเสธ').setTextInputComponent(
      new TextInputBuilder().setCustomId(weeklyItemsComponentIds.rejectionReason).setStyle(TextInputStyle.Paragraph)
        .setMinLength(2).setMaxLength(500).setRequired(true),
    ));
}

export function buildWeeklyItemsCancellationModal(collectionId: string): ModalBuilder {
  return new ModalBuilder().setCustomId(`weekly-items:cancel_modal:${collectionId}`).setTitle('ยกเลิกรอบส่งของ')
    .addLabelComponents(new LabelBuilder().setLabel('เหตุผลที่ยกเลิก').setTextInputComponent(
      new TextInputBuilder().setCustomId(weeklyItemsComponentIds.cancellationReason).setStyle(TextInputStyle.Paragraph)
        .setMinLength(2).setMaxLength(500).setRequired(true),
    ));
}

function proofLogContent(
  proofId: string,
  title: string,
  member: WeeklyItemObligationView['member'],
  items: WeeklyItemObligationView['items'],
  status: WeeklyItemProofView['proof']['status'],
  rejectionReason: string | null,
  timestamp: Date,
) {
  const display = status === 'APPROVED'
    ? { color: 0x57f287, title: '✅ อนุมัติส่งของประจำสัปดาห์แล้ว' }
    : status === 'REJECTED'
      ? { color: 0xed4245, title: '❌ ปฏิเสธหลักฐานส่งของ' }
      : { color: 0xfee75c, title: '⏳ หลักฐานส่งของประจำสัปดาห์รอตรวจ' };
  const embed = new EmbedBuilder().setColor(display.color).setTitle(display.title).addFields(
    { name: 'สมาชิก', value: `<@${member.discordUserId}> (${escapeMarkdown(member.inGameName)})` },
    { name: 'รอบ', value: escapeMarkdown(title) },
    { name: 'รายการที่ส่งครบ', value: items.map(({ item, quantity }) => `**${escapeMarkdown(item.itemName)}** — ${formatQuantity(quantity)} ชิ้น`).join('\n') },
  ).setTimestamp(timestamp);
  if (rejectionReason !== null) embed.addFields({ name: 'เหตุผลที่ปฏิเสธ', value: escapeMarkdown(rejectionReason) });
  const disabled = status !== 'PENDING';
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`weekly-items:approve:${proofId}`).setLabel('อนุมัติรับเข้า Stock').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`weekly-items:reject:${proofId}`).setLabel('ปฏิเสธ').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )] };
}

function obligationStatusLine(view: WeeklyItemObligationView): string {
  if (view.obligation.status === 'EXEMPT') return `🛡️ <@${view.member.discordUserId}> — ${escapeMarkdown(view.obligation.exemptionReason ?? 'ยกเว้น')}`;
  if (view.obligation.status === 'FULFILLED') return `✅ <@${view.member.discordUserId}> — ส่งครบแล้ว`;
  if (view.obligation.status === 'PENDING_VERIFICATION') return `⏳ <@${view.member.discordUserId}> — รอตรวจ`;
  return `❌ <@${view.member.discordUserId}> — ยังไม่ส่ง`;
}

function chunkLines(lines: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < lines.length; index += size) chunks.push(lines.slice(index, index + size));
  return chunks.length === 0 ? [[]] : chunks;
}

function formatQuantity(quantity: number): string {
  return quantity.toLocaleString('th-TH');
}

function textLabel(
  label: string,
  customId: string,
  placeholder: string,
  minimum: number,
  maximum: number,
  value?: string,
): LabelBuilder {
  const input = new TextInputBuilder().setCustomId(customId).setStyle(TextInputStyle.Short)
    .setPlaceholder(placeholder).setMinLength(minimum).setMaxLength(maximum).setRequired(true);
  if (value !== undefined) input.setValue(value);
  return new LabelBuilder().setLabel(label).setTextInputComponent(input);
}
