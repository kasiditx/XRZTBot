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
import type { LeaderboardRow } from '../../modules/activities/leaderboard.js';
import type {
  Activity,
  ActivityMode,
  ActivityParticipationSummary,
  ActivityScoreItem,
  ActivityWithScores,
  PreparedSubmission,
  SubmissionView,
} from '../../modules/activities/service.js';

export const activityComponentIds = {
  adminCreate: 'activity:admin_create',
  createMode: 'activity:create_mode',
  adminSelect: 'activity:admin_select',
  createTitle: 'activity:create_title',
  createDetails: 'activity:create_details',
  createStartsAt: 'activity:create_starts_at',
  createEndsAt: 'activity:create_ends_at',
  createScores: 'activity:create_scores',
  submitScore: 'activity:submit_score',
  submitParticipants: 'activity:submit_participants',
  submitFiles: 'activity:submit_files',
  submitMediaLinks: 'activity:submit_media_links',
  submitNote: 'activity:submit_note',
  participantOperation: 'activity:participant_operation',
  participantUsers: 'activity:participant_users',
  changeScore: 'activity:change_score',
  scoreName: 'activity:score_name',
  scorePoints: 'activity:score_points',
  scoreActive: 'activity:score_active',
} as const;

export const activityCreateModalPrefix = 'activity:create_modal:';

const DISCORD_SELECT_OPTION_LIMIT = 25;
const MAX_SCORE_SUBMISSION_PARTICIPANT_SELECTORS = 2;
const MAX_EVIDENCE_SUBMISSION_PARTICIPANT_SELECTORS = 3;
const MAX_PARTICIPANT_EDIT_SELECTORS = 4;

export interface ActivityParticipantOption {
  readonly discordUserId: string;
  readonly inGameName: string;
}

export function buildActivityAdminPanel(currentActivities: readonly Activity[]) {
  const createRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(activityComponentIds.adminCreate)
      .setLabel('สร้างกิจกรรม')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Success),
  );
  if (currentActivities.length === 0) {
    return {
      content: formatPanelText('🏆', 'ระบบกิจกรรม', 'ยังไม่มีกิจกรรมที่กำลังจัดการ', 'กดสร้างกิจกรรมเพื่อเริ่มต้น'),
      components: [createRow],
    };
  }

  const selector = new StringSelectMenuBuilder()
    .setCustomId(activityComponentIds.adminSelect)
    .setPlaceholder('เลือกกิจกรรมที่ต้องการจัดการ')
    .addOptions(currentActivities.map((activity) => ({
      label: activity.title.slice(0, 100),
      description: `${thaiStatus(activity.status)} · ปิด ${formatDiscordTimestamp(activity.endsAt, 'f')}`.slice(0, 100),
      value: activity.id,
    })));
  return {
    content: formatPanelText('🏆', 'ระบบกิจกรรม', 'สร้างกิจกรรมใหม่ หรือเลือกกิจกรรมเดิมเพื่อจัดการ', 'รองรับคะแนน ผลงาน และประกาศ'),
    components: [createRow, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)],
  };
}

export function buildActivityTypeSelector() {
  const mode = new StringSelectMenuBuilder()
    .setCustomId(activityComponentIds.createMode)
    .setPlaceholder('เลือกรูปแบบกิจกรรม')
    .addOptions(
      { label: 'กิจกรรมสะสมคะแนน', value: 'SCORE', emoji: '🏆', description: 'ส่งหลักฐาน เลือกรายการคะแนน และมี Leaderboard' },
      { label: 'กิจกรรมส่งผลงาน', value: 'EVIDENCE', emoji: '📸', description: 'ส่งหลักฐานและผู้ร่วม โดยไม่มีคะแนน' },
      { label: 'กิจกรรมประกาศ', value: 'ANNOUNCEMENT', emoji: '📢', description: 'ประกาศรายละเอียดอย่างเดียว ไม่รับ Submission' },
    );
  return {
    content: formatPanelText('🧩', 'เลือกรูปแบบกิจกรรม', 'เลือกรูปแบบให้ตรงกับกิจกรรมที่ต้องการสร้าง', 'รูปแบบกำหนดวิธีส่งผลงานและการสรุปผล'),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(mode)],
  };
}

export function buildCreateActivityModal(mode: ActivityMode, startsAt: string, endsAt: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${activityCreateModalPrefix}${mode}`)
    .setTitle('สร้างกิจกรรม')
    .addComponents(
      inputRow(activityComponentIds.createTitle, 'ชื่อกิจกรรม', TextInputStyle.Short, 'King of Loop', 2, 100),
      inputRow(activityComponentIds.createDetails, 'รายละเอียด', TextInputStyle.Paragraph, 'รายละเอียดและกติกากิจกรรม', 2, 2_000),
      inputRow(activityComponentIds.createStartsAt, 'เริ่ม (DD/MM/YYYY HH:mm)', TextInputStyle.Short, undefined, 12, 16, startsAt),
      inputRow(activityComponentIds.createEndsAt, 'ปิด (DD/MM/YYYY HH:mm)', TextInputStyle.Short, undefined, 12, 16, endsAt),
    );
  if (mode === 'SCORE') {
    modal.addComponents(inputRow(
      activityComponentIds.createScores,
      'รายการคะแนน: ชื่อ=คะแนน (บรรทัดละรายการ)',
      TextInputStyle.Paragraph,
      'Loop A=50\nLoop B=100',
      3,
      2_000,
    ));
  }
  return modal;
}

export function buildActivityManagement(activity: ActivityWithScores) {
  const embed = buildActivityEmbed(activity);
  if (activity.activity.mode === 'ANNOUNCEMENT') {
    return { embeds: [embed], components: [] };
  }
  if (activity.activity.mode === 'EVIDENCE') {
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`activity:summary:${activity.activity.id}`).setLabel('สรุปผลงาน').setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [actionRow] };
  }
  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`activity:score_add:${activity.activity.id}`).setLabel('เพิ่มรายการคะแนน').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`activity:score_manage:${activity.activity.id}`).setLabel('แก้ไขคะแนน').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`activity:leaderboard:${activity.activity.id}`).setLabel('Leaderboard').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [actionRow] };
}

export function buildActivityAnnouncement(activity: ActivityWithScores, closed = false) {
  const acceptsSubmissions = activity.activity.mode !== 'ANNOUNCEMENT';
  const acceptingSubmissions = acceptsSubmissions && !closed && activity.activity.status === 'OPEN';
  const embed = buildActivityEmbed(activity)
    .setColor(closed ? 0x747f8d : 0x57f287)
    .setFooter({
      text: closed
        ? activity.activity.mode === 'ANNOUNCEMENT' ? 'กิจกรรมสิ้นสุดแล้ว' : 'กิจกรรมปิดรับผลงานแล้ว'
        : acceptingSubmissions
          ? 'กดส่งกิจกรรมเพื่อแนบรูปและเลือกผู้ร่วม'
          : activity.activity.mode === 'ANNOUNCEMENT' ? 'กิจกรรมประกาศ' : 'กิจกรรมยังไม่เปิดรับผลงาน',
    });
  if (!acceptsSubmissions) {
    return { embeds: [embed], components: [] };
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`activity:submit:${activity.activity.id}`)
      .setLabel('ส่งกิจกรรม')
      .setEmoji('📸')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!acceptingSubmissions),
  );
  if (activity.activity.mode === 'SCORE') {
    row.addComponents(new ButtonBuilder()
      .setCustomId(`activity:leaderboard:${activity.activity.id}`)
      .setLabel('Leaderboard')
      .setEmoji('🏆')
      .setStyle(ButtonStyle.Primary));
  } else {
    row.addComponents(new ButtonBuilder()
      .setCustomId(`activity:summary:${activity.activity.id}`)
      .setLabel('สรุปผลงาน')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Primary));
  }
  return { embeds: [embed], components: [row] };
}

export function buildActivitySubmissionModal(
  activity: ActivityWithScores,
  activeMembers: readonly ActivityParticipantOption[],
  evidenceMode: EvidenceInputMode,
): ModalBuilder {
  const note = new TextInputBuilder()
    .setCustomId(activityComponentIds.submitNote)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(false)
    .setPlaceholder('หมายเหตุเพิ่มเติม (ถ้ามี)');

  const labels: LabelBuilder[] = [];
  if (activity.activity.mode === 'SCORE') {
    const scoreSelector = new StringSelectMenuBuilder()
      .setCustomId(activityComponentIds.submitScore)
      .setPlaceholder('เลือก Loop/รายการคะแนน')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(activity.scoreItems.map(scoreOption));
    labels.push(new LabelBuilder().setLabel('Loop/รายการคะแนน').setStringSelectMenuComponent(scoreSelector));
  }
  labels.push(...buildParticipantSelectorLabels(
    activityComponentIds.submitParticipants,
    activeMembers,
    activity.activity.mode === 'SCORE'
      ? MAX_SCORE_SUBMISSION_PARTICIPANT_SELECTORS
      : MAX_EVIDENCE_SUBMISSION_PARTICIPANT_SELECTORS,
    false,
  ));
  labels.push(
    buildEvidenceInputLabel({
      mode: evidenceMode,
      fileCustomId: activityComponentIds.submitFiles,
      linkCustomId: activityComponentIds.submitMediaLinks,
      maximumImages: 5,
      label: 'รูปหลักฐาน',
    }),
    new LabelBuilder().setLabel('หมายเหตุ').setTextInputComponent(note),
  );
  return new ModalBuilder()
    .setCustomId(`activity:submit_modal:${evidenceMode}:${activity.activity.id}`)
    .setTitle(activity.activity.title.slice(0, 45))
    .addLabelComponents(...labels);
}

export function buildPreparedSubmissionLog(prepared: PreparedSubmission, cancelled = false) {
  const embed = new EmbedBuilder()
    .setColor(cancelled ? 0xed4245 : 0x5865f2)
    .setTitle(`${cancelled ? '❌ ' : ''}${prepared.activity.title}`)
    .addFields(
      ...(prepared.scoreItem === null ? [] : [{ name: 'รายการ', value: `${prepared.scoreItem.name} — ${prepared.scoreItem.points.toLocaleString('th-TH')} คะแนน`, inline: true }]),
      { name: 'ผู้ส่ง', value: `<@${prepared.submitter.discordUserId}> (${prepared.submitter.inGameName})`, inline: true },
      { name: `ผู้ร่วม ${String(prepared.participants.length)} คน`, value: formatParticipants(prepared.participants) },
    )
    .setTimestamp();
  if (prepared.note !== null) {
    embed.addFields({ name: 'หมายเหตุ', value: prepared.note });
  }
  if (cancelled) {
    embed.setFooter({ text: prepared.scoreItem === null ? 'รายการนี้ถูกยกเลิก' : 'รายการนี้ถูกยกเลิกและไม่นับคะแนน' });
  }
  return {
    embeds: [embed],
    components: buildSubmissionActionRows(prepared.submissionId, cancelled, prepared.activity.mode),
  };
}

export function buildSubmissionLog(view: SubmissionView) {
  return buildPreparedSubmissionLog({
    submissionId: view.submission.id,
    activity: view.activity,
    scoreItem: view.scoreItem,
    submitter: view.submitter,
    participants: view.participants,
    note: view.submission.note,
  }, view.submission.isCancelled);
}

export function buildParticipantEditModal(
  submissionId: string,
  activeMembers: readonly ActivityParticipantOption[],
): ModalBuilder {
  const operation = new StringSelectMenuBuilder()
    .setCustomId(activityComponentIds.participantOperation)
    .setPlaceholder('เลือกว่าจะเพิ่มหรือลบ')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      { label: 'เพิ่มผู้ร่วม', value: 'ADD' },
      { label: 'ลบผู้ร่วม', value: 'REMOVE', description: 'ไม่สามารถลบผู้ส่งออกจากรายการได้' },
    );
  return new ModalBuilder()
    .setCustomId(`activity:participants_modal:${submissionId}`)
    .setTitle('แก้ไขผู้ร่วมกิจกรรม')
    .addLabelComponents(
      new LabelBuilder().setLabel('การทำรายการ').setStringSelectMenuComponent(operation),
      ...buildParticipantSelectorLabels(
        activityComponentIds.participantUsers,
        activeMembers,
        MAX_PARTICIPANT_EDIT_SELECTORS,
        true,
      ),
    );
}

function buildParticipantSelectorLabels(
  customIdPrefix: string,
  activeMembers: readonly ActivityParticipantOption[],
  maxSelectors: number,
  selectionRequired: boolean,
): LabelBuilder[] {
  const uniqueMembers = [...new Map(
    activeMembers.map((member) => [member.discordUserId, member] as const),
  ).values()];
  const visibleMembers = uniqueMembers.slice(0, maxSelectors * DISCORD_SELECT_OPTION_LIMIT);
  const chunks: ActivityParticipantOption[][] = [];

  for (let offset = 0; offset < visibleMembers.length; offset += DISCORD_SELECT_OPTION_LIMIT) {
    chunks.push(visibleMembers.slice(offset, offset + DISCORD_SELECT_OPTION_LIMIT));
  }

  return chunks.map((members, index) => {
    const selector = new StringSelectMenuBuilder()
      .setCustomId(participantSelectorCustomId(customIdPrefix, index))
      .setPlaceholder('เลือกจากสมาชิกที่อนุมัติแล้ว')
      .setMinValues(selectionRequired && chunks.length === 1 ? 1 : 0)
      .setMaxValues(members.length)
      .setRequired(selectionRequired && chunks.length === 1)
      .addOptions(members.map((member) => ({
        label: member.inGameName.slice(0, 100),
        description: `Discord ID: ${member.discordUserId}`.slice(0, 100),
        value: member.discordUserId,
      })));
    const pageSuffix = chunks.length > 1 ? ` · ชุด ${String(index + 1)}/${String(chunks.length)}` : '';
    return new LabelBuilder()
      .setLabel(`ผู้ร่วมกิจกรรม${pageSuffix}`)
      .setDescription('แสดงเฉพาะสมาชิกที่อนุมัติและมีสถานะใช้งาน')
      .setStringSelectMenuComponent(selector);
  });
}

function participantSelectorCustomId(prefix: string, index: number): string {
  return index === 0 ? prefix : `${prefix}:${String(index + 1)}`;
}

export function buildChangeSubmissionScoreModal(submissionId: string, scoreItems: readonly ActivityScoreItem[]): ModalBuilder {
  const selector = new StringSelectMenuBuilder()
    .setCustomId(activityComponentIds.changeScore)
    .setPlaceholder('เลือกรายการคะแนนใหม่')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(scoreItems.map(scoreOption));
  return new ModalBuilder()
    .setCustomId(`activity:change_score_modal:${submissionId}`)
    .setTitle('เปลี่ยน Loop/รายการคะแนน')
    .addLabelComponents(new LabelBuilder().setLabel('รายการคะแนนใหม่').setStringSelectMenuComponent(selector));
}

export function buildCancelConfirmation(submissionId: string) {
  return {
    content: formatPanelText('⚠️', 'ยืนยันยกเลิกรายการ', 'รายการที่ยกเลิกจะไม่ถูกนำไปคำนวณในผลสรุป', 'การทำรายการนี้ต้องกดยืนยันอีกครั้ง'),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`activity:cancel_confirm:${submissionId}`).setLabel('ยืนยันยกเลิก').setStyle(ButtonStyle.Danger),
    )],
  };
}

export function buildScoreAddModal(activityId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`activity:score_add_modal:${activityId}`)
    .setTitle('เพิ่มรายการคะแนน')
    .addComponents(
      inputRow(activityComponentIds.scoreName, 'ชื่อรายการ', TextInputStyle.Short, 'Loop C', 1, 80),
      inputRow(activityComponentIds.scorePoints, 'คะแนน', TextInputStyle.Short, '150', 1, 10),
    );
}

export function buildScoreSelector(activityId: string, scoreItems: readonly ActivityScoreItem[]) {
  const selector = new StringSelectMenuBuilder()
    .setCustomId(`activity:score_select:${activityId}`)
    .setPlaceholder('เลือกรายการคะแนนที่ต้องการแก้')
    .addOptions(scoreItems.map(scoreOption));
  return {
    content: formatPanelText('🏆', 'แก้ไขรายการคะแนน', 'เลือกรายการคะแนนที่ต้องการแก้ไข', 'คะแนนใหม่จะคำนวณกับ Submission เดิมอัตโนมัติ'),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)],
  };
}

export function buildScoreEditModal(activityId: string, score: ActivityScoreItem): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`activity:score_edit_modal:${activityId}:${score.id}`)
    .setTitle('แก้ไขรายการคะแนน')
    .addComponents(
      inputRow(activityComponentIds.scoreName, 'ชื่อรายการ', TextInputStyle.Short, undefined, 1, 80, score.name),
      inputRow(activityComponentIds.scorePoints, 'คะแนน', TextInputStyle.Short, undefined, 1, 10, String(score.points)),
      inputRow(activityComponentIds.scoreActive, 'สถานะ: ON หรือ OFF', TextInputStyle.Short, 'ON', 2, 3, score.isActive ? 'ON' : 'OFF'),
    );
}

export function buildLeaderboardEmbed(activity: Activity, rows: readonly LeaderboardRow[], final = false): EmbedBuilder {
  return buildLeaderboardEmbeds(activity, rows, final)[0]!;
}

export function buildLeaderboardEmbeds(activity: Activity, rows: readonly LeaderboardRow[], final = false): EmbedBuilder[] {
  const rowPages = splitLeaderboardRows(rows);
  return rowPages.map((pageRows, index) => {
    const totalPages = rowPages.length;
    const description = pageRows.length === 0
      ? 'ยังไม่มีคะแนนในกิจกรรมนี้'
      : pageRows.map(leaderboardLine).join('\n');
    return new EmbedBuilder()
      .setColor(final ? 0xfee75c : 0x5865f2)
      .setTitle(`${final ? 'สรุปคะแนน' : 'Leaderboard ชั่วคราว'} — ${activity.title}${index === 0 ? '' : ' (ต่อ)'}`)
      .setDescription(description)
      .setFooter({ text: totalPages === 1 ? 'อันดับเท่ากันเมื่อคะแนนเท่ากัน' : `อันดับเท่ากันเมื่อคะแนนเท่ากัน • รายการ ${index + 1}/${totalPages}` })
      .setTimestamp();
  });
}

function splitLeaderboardRows(rows: readonly LeaderboardRow[]): LeaderboardRow[][] {
  if (rows.length === 0) return [[]];
  // MiruEmbedBuilder decorates each line before Discord receives it.
  const maximumLength = 3_200;
  const pages: LeaderboardRow[][] = [];
  let currentRows: LeaderboardRow[] = [];
  let currentLength = 0;
  for (const row of rows) {
    const line = leaderboardLine(row);
    const nextLength = currentLength === 0 ? line.length : currentLength + line.length + 1;
    if (currentRows.length > 0 && nextLength > maximumLength) {
      pages.push(currentRows);
      currentRows = [];
      currentLength = 0;
    }
    currentRows.push(row);
    currentLength = currentLength === 0 ? line.length : currentLength + line.length + 1;
  }
  pages.push(currentRows);
  return pages;
}

function leaderboardLine(row: LeaderboardRow): string {
  return `${leaderboardRankLabel(row.rank)} ${row.displayName} — **${row.points.toLocaleString('th-TH')} คะแนน**`;
}

function leaderboardRankLabel(rank: number): string {
  return rank <= 3 ? `👑 ${String(rank)}.` : `${String(rank)}.`;
}

export function buildParticipationSummaryEmbed(
  activity: Activity,
  summary: ActivityParticipationSummary,
  final = false,
): EmbedBuilder {
  return buildParticipationSummaryEmbeds(activity, summary, final)[0]!;
}

export function buildParticipationSummaryEmbeds(
  activity: Activity,
  summary: ActivityParticipationSummary,
  final = false,
): EmbedBuilder[] {
  const rowPages = splitParticipationRows(summary.rows);
  return rowPages.map((pageRows, index) => {
    const description = pageRows.length === 0
      ? 'ยังไม่มีผู้ส่งผลงานในกิจกรรมนี้'
      : pageRows.map((row) => `${String(row.index)}. ${row.displayName} — **${row.submissions.toLocaleString('th-TH')} รายการ**`).join('\n');
    return new EmbedBuilder()
      .setColor(final ? 0x57f287 : 0x5865f2)
      .setTitle(`${final ? 'สรุปกิจกรรม' : 'สรุปผลงานชั่วคราว'} — ${activity.title}${index === 0 ? '' : ' (ต่อ)'}`)
      .setDescription(description)
      .addFields({ name: 'Submission ทั้งหมด', value: summary.totalSubmissions.toLocaleString('th-TH'), inline: true })
      .setFooter({ text: rowPages.length === 1 ? 'นับรายการที่ยังไม่ถูกยกเลิก' : `นับรายการที่ยังไม่ถูกยกเลิก • รายการ ${index + 1}/${rowPages.length}` })
      .setTimestamp();
  });
}

function splitParticipationRows(rows: readonly ActivityParticipationSummary['rows'][number][]): Array<Array<ActivityParticipationSummary['rows'][number] & { readonly index: number }>> {
  if (rows.length === 0) return [[]];
  // MiruEmbedBuilder decorates each line before Discord receives it.
  const maximumLength = 3_200;
  const pages: Array<Array<ActivityParticipationSummary['rows'][number] & { readonly index: number }>> = [];
  let currentRows: Array<ActivityParticipationSummary['rows'][number] & { readonly index: number }> = [];
  let currentLength = 0;
  for (const [index, row] of rows.entries()) {
    const indexedRow = { ...row, index: index + 1 };
    const line = `${String(indexedRow.index)}. ${indexedRow.displayName} — **${indexedRow.submissions.toLocaleString('th-TH')} รายการ**`;
    const nextLength = currentLength === 0 ? line.length : currentLength + line.length + 1;
    if (currentRows.length > 0 && nextLength > maximumLength) {
      pages.push(currentRows);
      currentRows = [];
      currentLength = 0;
    }
    currentRows.push(indexedRow);
    currentLength = currentLength === 0 ? line.length : currentLength + line.length + 1;
  }
  pages.push(currentRows);
  return pages;
}

export function buildAnnouncementSummaryEmbed(activity: Activity): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x747f8d)
    .setTitle(`📢 สิ้นสุดกิจกรรม — ${activity.title}`)
    .setDescription(activity.details)
    .setTimestamp(activity.endsAt);
}

function buildActivityEmbed({ activity, scoreItems }: ActivityWithScores): EmbedBuilder {
  const scores = scoreItems.length === 0
    ? 'ไม่มีรายการคะแนนที่เปิดใช้งาน'
    : scoreItems.map((score) => `• ${score.name}: **${score.points.toLocaleString('th-TH')} คะแนน**${score.isActive ? '' : ' (ปิด)'}`).join('\n');
  const embed = new EmbedBuilder()
    .setTitle(activity.title)
    .setDescription(activity.details)
    .addFields(
      { name: 'เริ่ม', value: formatDiscordTimestamp(activity.startsAt, 'F'), inline: true },
      { name: 'ปิด', value: formatDiscordTimestamp(activity.endsAt, 'F'), inline: true },
      { name: 'สถานะ', value: thaiStatus(activity.status), inline: true },
    );
  embed.addFields({ name: 'รูปแบบ', value: activityModeLabel(activity.mode), inline: true });
  if (activity.mode === 'SCORE') {
    embed.addFields({ name: 'รายการคะแนน', value: scores.slice(0, 1_024) });
  }
  return embed;
}

function buildSubmissionActionRows(submissionId: string, disabled: boolean, mode: ActivityMode): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`activity:cancel:${submissionId}`).setLabel('ยกเลิกรายการ').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`activity:participants:${submissionId}`).setLabel('แก้ไขผู้ร่วม').setStyle(ButtonStyle.Primary).setDisabled(disabled),
  );
  if (mode === 'SCORE') {
    row.addComponents(new ButtonBuilder().setCustomId(`activity:submission_score:${submissionId}`).setLabel('เปลี่ยน Loop').setStyle(ButtonStyle.Secondary).setDisabled(disabled));
  }
  return [row];
}

function scoreOption(score: ActivityScoreItem) {
  return {
    label: score.name.slice(0, 100),
    description: `${score.points.toLocaleString('th-TH')} คะแนน${score.isActive ? '' : ' · ปิดใช้งาน'}`.slice(0, 100),
    value: score.id,
  };
}

function formatParticipants(participants: readonly ActiveIdentity[]): string {
  const value = participants.map((participant) => `<@${participant.discordUserId}>`).join(', ');
  return value.length <= 1_024 ? value : `${value.slice(0, 1_000)}…`;
}

interface ActiveIdentity {
  readonly discordUserId: string;
}

function inputRow(
  customId: string,
  label: string,
  style: TextInputStyle,
  placeholder: string | undefined,
  minimum: number,
  maximum: number,
  value?: string,
): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style)
    .setMinLength(minimum)
    .setMaxLength(maximum)
    .setRequired(true);
  if (placeholder !== undefined) {
    input.setPlaceholder(placeholder);
  }
  if (value !== undefined) {
    input.setValue(value);
  }
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function formatDiscordTimestamp(value: Date, style: 'f' | 'F'): string {
  return `<t:${String(Math.floor(value.getTime() / 1_000))}:${style}>`;
}

function thaiStatus(status: Activity['status']): string {
  const labels: Record<Activity['status'], string> = {
    DRAFT: 'ร่าง',
    SCHEDULED: 'รอเปิด',
    OPEN: 'เปิดรับผลงาน',
    CLOSED: 'ปิดแล้ว',
    CANCELLED: 'ยกเลิก',
  };
  return labels[status];
}

export function activityModeLabel(mode: ActivityMode): string {
  const labels: Record<ActivityMode, string> = {
    SCORE: '🏆 สะสมคะแนน',
    EVIDENCE: '📸 ส่งผลงาน',
    ANNOUNCEMENT: '📢 ประกาศ',
  };
  return labels[mode];
}
