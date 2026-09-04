import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

export const memberStatusEnum = pgEnum('member_status', ['PENDING', 'ACTIVE', 'REJECTED', 'FORMER']);
export const memberRosterTitleEnum = pgEnum('member_roster_title', ['HEAD', 'DEPUTY', 'ACCOUNTANT', 'RESERVE']);
export const requestStatusEnum = pgEnum('request_status', ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
export const scheduledJobStatusEnum = pgEnum('scheduled_job_status', ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);
export const activityStatusEnum = pgEnum('activity_status', ['DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED', 'CANCELLED']);
export const activityModeEnum = pgEnum('activity_mode', ['SCORE', 'EVIDENCE', 'ANNOUNCEMENT']);
export const attendanceModeEnum = pgEnum('attendance_mode', ['AIRDROP', 'GENERAL']);
export const attendanceRoundStatusEnum = pgEnum('attendance_round_status', ['SCHEDULED', 'OPEN', 'CLOSED', 'CANCELLED']);
export const attendanceResultEnum = pgEnum('attendance_result', ['PENDING', 'PRESENT', 'LEAVE', 'EMERGENCY_LEAVE', 'ABSENT']);
export const attendanceProofStatusEnum = pgEnum('attendance_proof_status', ['PENDING', 'REJECTED']);
export const leaveStatusEnum = pgEnum('leave_status', ['ACTIVE', 'CANCELLED']);
export const fineStatusEnum = pgEnum('fine_status', ['UNPAID', 'PENDING_VERIFICATION', 'PAID', 'CANCELLED']);
export const treasuryEntryTypeEnum = pgEnum('treasury_entry_type', ['OPENING_BALANCE', 'INCOME', 'EXPENSE', 'REVERSAL']);
export const weeklyObligationStatusEnum = pgEnum('weekly_obligation_status', ['UNPAID', 'EXEMPT', 'PENDING_VERIFICATION', 'PAID', 'CONVERTED_TO_FINE']);
export const inventoryActionEnum = pgEnum('inventory_action', ['OPENING', 'ADD', 'REMOVE', 'WITHDRAWAL', 'DEPOSIT', 'REVERSAL']);
export const withdrawalStatusEnum = pgEnum('withdrawal_status', ['PENDING', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED']);

export const guildSettings = pgTable('guild_settings', {
  guildId: text('guild_id').primaryKey(),
  timezone: text('timezone').notNull().default('Asia/Bangkok'),
  devRoleId: text('dev_role_id'),
  headRoleId: text('head_role_id'),
  deputyRoleId: text('deputy_role_id'),
  activeMemberRoleId: text('active_member_role_id'),
  formerMemberRoleId: text('former_member_role_id'),
  controlChannelId: text('control_channel_id'),
  memberChannelId: text('member_channel_id'),
  registrationRequestChannelId: text('registration_request_channel_id'),
  memberRosterChannelId: text('member_roster_channel_id'),
  memberRosterMessageId: text('member_roster_message_id'),
  activityChannelId: text('activity_channel_id'),
  activityLogChannelId: text('activity_log_channel_id'),
  attendanceChannelId: text('attendance_channel_id'),
  attendanceLogChannelId: text('attendance_log_channel_id'),
  leaveChannelId: text('leave_channel_id'),
  leaveLogChannelId: text('leave_log_channel_id'),
  leavePanelMessageId: text('leave_panel_message_id'),
  fineChannelId: text('fine_channel_id'),
  fineLogChannelId: text('fine_log_channel_id'),
  treasuryChannelId: text('treasury_channel_id'),
  treasuryPanelMessageId: text('treasury_panel_message_id'),
  treasuryWithdrawalChannelId: text('treasury_withdrawal_channel_id'),
  treasuryWithdrawalLogChannelId: text('treasury_withdrawal_log_channel_id'),
  treasuryWithdrawalPanelMessageId: text('treasury_withdrawal_panel_message_id'),
  weeklyDuesChannelId: text('weekly_dues_channel_id'),
  weeklyDuesLogChannelId: text('weekly_dues_log_channel_id'),
  stockChannelId: text('stock_channel_id'),
  stockPanelMessageId: text('stock_panel_message_id'),
  stockLogChannelId: text('stock_log_channel_id'),
  stockLogDashboardMessageId: text('stock_log_dashboard_message_id'),
  withdrawalLogChannelId: text('withdrawal_log_channel_id'),
  depositLogChannelId: text('deposit_log_channel_id'),
  fightPositionChannelId: text('fight_position_channel_id'),
  fightPositionSummaryMessageId: text('fight_position_summary_message_id'),
  auditChannelId: text('audit_channel_id'),
  controlPanelMessageId: text('control_panel_message_id'),
  ...auditColumns,
});

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    discordUserId: text('discord_user_id').notNull(),
    inGameName: text('in_game_name').notNull(),
    status: memberStatusEnum('status').notNull().default('PENDING'),
    rosterTitle: memberRosterTitleEnum('roster_title'),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByDiscordUserId: text('decided_by_discord_user_id'),
    departureReason: text('departure_reason'),
    registrationRequestChannelId: text('registration_request_channel_id'),
    registrationRequestMessageId: text('registration_request_message_id'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('members_guild_discord_user_uq').on(table.guildId, table.discordUserId),
    uniqueIndex('members_guild_singleton_roster_title_uq')
      .on(table.guildId, table.rosterTitle)
      .where(sql`${table.rosterTitle} in ('HEAD', 'ACCOUNTANT')`),
    index('members_guild_status_idx').on(table.guildId, table.status),
    check('members_in_game_name_not_blank', sql`length(trim(${table.inGameName})) > 0`),
  ],
);

export const fightPositions = pgTable(
  'fight_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    emoji: text('emoji').notNull().default('⚔️'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('fight_positions_guild_name_uq').on(table.guildId, table.name),
    check('fight_positions_name_not_blank', sql`length(trim(${table.name})) > 0`),
    check('fight_positions_emoji_not_blank', sql`length(trim(${table.emoji})) > 0`),
  ],
);

export const fightPositionSets = pgTable(
  'fight_position_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('fight_position_sets_guild_name_uq').on(table.guildId, table.name),
    uniqueIndex('fight_position_sets_guild_id_uq').on(table.guildId, table.id),
    uniqueIndex('fight_position_sets_guild_active_uq')
      .on(table.guildId)
      .where(sql`${table.isActive} = true`),
    index('fight_position_sets_guild_sort_idx').on(table.guildId, table.sortOrder),
    check('fight_position_sets_name_not_blank', sql`length(trim(${table.name})) > 0`),
  ],
);

export const memberFightPositions = pgTable(
  'member_fight_positions',
  {
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    setId: uuid('set_id').notNull(),
    memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
    positionId: uuid('position_id').notNull().references(() => fightPositions.id, { onDelete: 'restrict' }),
    assignedByDiscordUserId: text('assigned_by_discord_user_id').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.setId, table.memberId] }),
    foreignKey({
      columns: [table.guildId, table.setId],
      foreignColumns: [fightPositionSets.guildId, fightPositionSets.id],
      name: 'member_fight_positions_set_fk',
    }).onDelete('cascade'),
    index('member_fight_positions_position_idx').on(table.guildId, table.positionId),
    index('member_fight_positions_set_idx').on(table.guildId, table.setId),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    actorDiscordUserId: text('actor_discord_user_id').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    reason: text('reason'),
    before: jsonb('before'),
    after: jsonb('after'),
    publicChannelId: text('public_channel_id'),
    publicMessageId: text('public_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('audit_logs_entity_idx').on(table.guildId, table.entityType, table.entityId), index('audit_logs_created_idx').on(table.guildId, table.createdAt)],
);

export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    jobType: text('job_type').notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    runAt: timestamp('run_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: scheduledJobStatusEnum('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    lockedBy: text('locked_by'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('scheduled_jobs_deduplication_uq').on(table.guildId, table.deduplicationKey),
    index('scheduled_jobs_due_idx').on(table.status, table.runAt),
    check('scheduled_jobs_attempts_non_negative', sql`${table.attempts} >= 0`),
    check('scheduled_jobs_max_attempts_positive', sql`${table.maxAttempts} > 0`),
  ],
);

export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    title: text('title').notNull(),
    details: text('details').notNull(),
    mode: activityModeEnum('mode').notNull().default('SCORE'),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: activityStatusEnum('status').notNull().default('DRAFT'),
    createdByDiscordUserId: text('created_by_discord_user_id').notNull(),
    announcementChannelId: text('announcement_channel_id'),
    announcementMessageId: text('announcement_message_id'),
    leaderboardChannelId: text('leaderboard_channel_id'),
    leaderboardMessageId: text('leaderboard_message_id'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('activities_guild_request_uq').on(table.guildId, table.requestId),
    index('activities_guild_status_idx').on(table.guildId, table.status),
    check('activities_valid_window', sql`${table.endsAt} > ${table.startsAt}`),
    check('activities_title_not_blank', sql`length(trim(${table.title})) > 0`),
  ],
);

export const activityScoreItems = pgTable(
  'activity_score_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    points: integer('points').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('activity_score_items_activity_name_uq').on(table.activityId, table.name),
    check('activity_score_items_points_non_negative', sql`${table.points} >= 0`),
  ],
);

export const activitySubmissions = pgTable(
  'activity_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
    scoreItemId: uuid('score_item_id').references(() => activityScoreItems.id, { onDelete: 'restrict' }),
    submitterMemberId: uuid('submitter_member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
    note: text('note'),
    imageAttachmentIds: jsonb('image_attachment_ids').$type<string[]>().notNull(),
    logChannelId: text('log_channel_id').notNull(),
    logMessageId: text('log_message_id'),
    isCancelled: boolean('is_cancelled').notNull().default(false),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    cancelledByDiscordUserId: text('cancelled_by_discord_user_id'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('activity_submissions_guild_request_uq').on(table.guildId, table.requestId),
    index('activity_submissions_activity_idx').on(table.guildId, table.activityId),
    check('activity_submissions_images_count', sql`jsonb_array_length(${table.imageAttachmentIds}) between 1 and 5`),
  ],
);

export const activitySubmissionParticipants = pgTable(
  'activity_submission_participants',
  {
    submissionId: uuid('submission_id').notNull().references(() => activitySubmissions.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
  },
  (table) => [primaryKey({ columns: [table.submissionId, table.memberId] })],
);

export const attendanceRounds = pgTable(
  'attendance_rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    title: text('title').notNull(),
    mode: attendanceModeEnum('mode').notNull().default('GENERAL'),
    attendanceDate: text('attendance_date').notNull(),
    eventAt: timestamp('event_at', { withTimezone: true, mode: 'date' }),
    opensAt: timestamp('opens_at', { withTimezone: true, mode: 'date' }).notNull(),
    closesAt: timestamp('closes_at', { withTimezone: true, mode: 'date' }).notNull(),
    emergencyLeaveCutoff: timestamp('emergency_leave_cutoff', { withTimezone: true, mode: 'date' }).notNull(),
    status: attendanceRoundStatusEnum('status').notNull().default('SCHEDULED'),
    sourceScheduleId: uuid('source_schedule_id'),
    announcementChannelId: text('announcement_channel_id'),
    announcementMessageId: text('announcement_message_id'),
    createdByDiscordUserId: text('created_by_discord_user_id').notNull(),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('attendance_rounds_guild_request_uq').on(table.guildId, table.requestId),
    index('attendance_rounds_guild_date_idx').on(table.guildId, table.attendanceDate),
    check('attendance_rounds_airdrop_event', sql`${table.mode} <> 'AIRDROP' OR ${table.eventAt} IS NOT NULL`),
    check('attendance_rounds_event_in_window', sql`${table.eventAt} IS NULL OR (${table.eventAt} >= ${table.opensAt} AND ${table.eventAt} <= ${table.closesAt})`),
    check('attendance_rounds_valid_window', sql`${table.closesAt} > ${table.opensAt}`),
    check('attendance_rounds_date_format', sql`${table.attendanceDate} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
  ],
);

export const attendanceSchedules = pgTable(
  'attendance_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    name: text('name').notNull(),
    mode: attendanceModeEnum('mode').notNull().default('GENERAL'),
    weekdays: jsonb('weekdays').$type<number[]>().notNull(),
    opensAtLocalTime: text('opens_at_local_time'),
    closesAtLocalTime: text('closes_at_local_time'),
    eventAtLocalTime: text('event_at_local_time'),
    opensBeforeMinutes: integer('opens_before_minutes'),
    closesAfterMinutes: integer('closes_after_minutes'),
    isActive: boolean('is_active').notNull().default(true),
    createdByDiscordUserId: text('created_by_discord_user_id').notNull(),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('attendance_schedules_guild_request_uq').on(table.guildId, table.requestId),
    check('attendance_schedules_weekdays_not_empty', sql`jsonb_array_length(${table.weekdays}) > 0`),
    check('attendance_schedules_mode_fields', sql`(
      ${table.mode} = 'GENERAL'
      AND ${table.opensAtLocalTime} IS NOT NULL
      AND ${table.closesAtLocalTime} IS NOT NULL
      AND ${table.eventAtLocalTime} IS NULL
      AND ${table.opensBeforeMinutes} IS NULL
      AND ${table.closesAfterMinutes} IS NULL
    ) OR (
      ${table.mode} = 'AIRDROP'
      AND ${table.opensAtLocalTime} IS NULL
      AND ${table.closesAtLocalTime} IS NULL
      AND ${table.eventAtLocalTime} IS NOT NULL
      AND ${table.opensBeforeMinutes} BETWEEN 0 AND 1440
      AND ${table.closesAfterMinutes} BETWEEN 0 AND 1440
      AND (${table.opensBeforeMinutes} + ${table.closesAfterMinutes}) > 0
    )`),
  ],
);

export const leaves = pgTable(
  'leaves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
    startsOn: text('starts_on').notNull(),
    endsOn: text('ends_on').notNull(),
    reason: text('reason').notNull(),
    status: leaveStatusEnum('status').notNull().default('ACTIVE'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    publicChannelId: text('public_channel_id'),
    publicMessageId: text('public_message_id'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('leaves_guild_request_uq').on(table.guildId, table.requestId),
    index('leaves_member_dates_idx').on(table.guildId, table.memberId, table.startsOn, table.endsOn),
    check('leaves_valid_dates', sql`${table.endsOn} >= ${table.startsOn}`),
    check('leaves_reason_not_blank', sql`length(trim(${table.reason})) > 0`),
  ],
);

export const attendanceRecords = pgTable(
  'attendance_records',
  {
    roundId: uuid('round_id').notNull().references(() => attendanceRounds.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
    result: attendanceResultEnum('result').notNull(),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true, mode: 'date' }),
    leaveId: uuid('leave_id').references(() => leaves.id, { onDelete: 'set null' }),
    proofAttachmentId: text('proof_attachment_id'),
    proofChannelId: text('proof_channel_id'),
    proofMessageId: text('proof_message_id'),
    proofSha256: text('proof_sha256'),
    correctedByDiscordUserId: text('corrected_by_discord_user_id'),
    correctionReason: text('correction_reason'),
    ...auditColumns,
  },
  (table) => [
    primaryKey({ columns: [table.roundId, table.memberId] }),
    uniqueIndex('attendance_records_proof_sha256_uq').on(table.proofSha256).where(sql`${table.proofSha256} IS NOT NULL`),
    check('attendance_records_proof_sha256_format', sql`${table.proofSha256} IS NULL OR length(${table.proofSha256}) = 64`),
    check('attendance_records_proof_fields_complete', sql`(
      ${table.proofAttachmentId} IS NULL
      AND ${table.proofChannelId} IS NULL
      AND ${table.proofMessageId} IS NULL
      AND ${table.proofSha256} IS NULL
    ) OR (
      ${table.proofAttachmentId} IS NOT NULL
      AND ${table.proofChannelId} IS NOT NULL
      AND ${table.proofMessageId} IS NOT NULL
      AND ${table.proofSha256} IS NOT NULL
    )`),
  ],
);

export const attendanceProofs = pgTable(
  'attendance_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    roundId: uuid('round_id').notNull().references(() => attendanceRounds.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
    attachmentId: text('attachment_id').notNull(),
    logChannelId: text('log_channel_id').notNull(),
    logMessageId: text('log_message_id').notNull(),
    sha256: text('sha256').notNull(),
    status: attendanceProofStatusEnum('status').notNull().default('PENDING'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByDiscordUserId: text('decided_by_discord_user_id'),
    rejectionReason: text('rejection_reason'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('attendance_proofs_log_message_uq').on(table.logMessageId),
    uniqueIndex('attendance_proofs_sha256_uq').on(table.sha256),
    uniqueIndex('attendance_proofs_one_pending_uq')
      .on(table.roundId, table.memberId)
      .where(sql`${table.status} = 'PENDING'`),
    check('attendance_proofs_sha256_format', sql`length(${table.sha256}) = 64`),
    check('attendance_proofs_status_fields', sql`(
      ${table.status} = 'PENDING'
      AND ${table.decidedAt} IS NULL
      AND ${table.decidedByDiscordUserId} IS NULL
      AND ${table.rejectionReason} IS NULL
    ) OR (
      ${table.status} = 'REJECTED'
      AND ${table.decidedAt} IS NOT NULL
      AND ${table.decidedByDiscordUserId} IS NOT NULL
      AND length(trim(${table.rejectionReason})) BETWEEN 2 AND 500
    )`),
  ],
);

export const fines = pgTable(
  'fines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    principalAmount: bigint('principal_amount', { mode: 'number' }).notNull(),
    surchargeAmount: bigint('surcharge_amount', { mode: 'number' }).notNull().default(0),
    accruedSurchargeAmount: bigint('accrued_surcharge_amount', { mode: 'number' }).notNull().default(0),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
    nextSurchargeAt: timestamp('next_surcharge_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: fineStatusEnum('status').notNull().default('UNPAID'),
    sourceType: text('source_type').notNull().default('MANUAL'),
    sourceId: text('source_id'),
    createdByDiscordUserId: text('created_by_discord_user_id').notNull(),
    publicChannelId: text('public_channel_id'),
    publicMessageId: text('public_message_id'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('fines_guild_request_uq').on(table.guildId, table.requestId),
    index('fines_due_idx').on(table.guildId, table.status, table.nextSurchargeAt),
    check('fines_principal_positive', sql`${table.principalAmount} > 0`),
    check('fines_surcharge_non_negative', sql`${table.surchargeAmount} >= 0`),
    check('fines_accrued_non_negative', sql`${table.accruedSurchargeAmount} >= 0`),
  ],
);

export const finePaymentProofs = pgTable(
  'fine_payment_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    fineId: uuid('fine_id').notNull().references(() => fines.id, { onDelete: 'cascade' }),
    submittedByDiscordUserId: text('submitted_by_discord_user_id').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    attachmentId: text('attachment_id').notNull(),
    logChannelId: text('log_channel_id').notNull(),
    logMessageId: text('log_message_id').notNull(),
    status: requestStatusEnum('status').notNull().default('PENDING'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByDiscordUserId: text('decided_by_discord_user_id'),
    rejectionReason: text('rejection_reason'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('fine_payment_proofs_guild_request_uq').on(table.guildId, table.requestId),
    uniqueIndex('fine_payment_proofs_one_pending_uq').on(table.fineId).where(sql`${table.status} = 'PENDING'`),
    check('fine_payment_proofs_amount_positive', sql`${table.amount} > 0`),
  ],
);

export const treasuryEntries = pgTable(
  'treasury_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    entryType: treasuryEntryTypeEnum('entry_type').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    description: text('description').notNull(),
    attachmentId: text('attachment_id'),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    reversalOfEntryId: uuid('reversal_of_entry_id'),
    createdByDiscordUserId: text('created_by_discord_user_id').notNull(),
    publicChannelId: text('public_channel_id'),
    publicMessageId: text('public_message_id'),
    ...auditColumns,
  },
  (table) => [
    index('treasury_entries_guild_created_idx').on(table.guildId, table.createdAt),
    uniqueIndex('treasury_entries_one_opening_uq').on(table.guildId).where(sql`${table.entryType} = 'OPENING_BALANCE'`),
    uniqueIndex('treasury_entries_source_uq').on(table.guildId, table.sourceType, table.sourceId).where(sql`${table.sourceId} is not null`),
    uniqueIndex('treasury_entries_reversal_uq').on(table.reversalOfEntryId).where(sql`${table.reversalOfEntryId} is not null`),
    check('treasury_entries_amount_non_zero', sql`${table.amount} <> 0`),
    check('treasury_entries_balance_non_negative', sql`${table.balanceAfter} >= 0`),
  ],
);

export const treasuryWithdrawalRequests = pgTable(
  'treasury_withdrawal_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    clientRequestId: text('client_request_id').notNull(),
    requesterMemberId: uuid('requester_member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    status: requestStatusEnum('status').notNull().default('PENDING'),
    treasuryEntryId: uuid('treasury_entry_id').references(() => treasuryEntries.id, { onDelete: 'restrict' }),
    publicChannelId: text('public_channel_id'),
    publicMessageId: text('public_message_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByDiscordUserId: text('decided_by_discord_user_id'),
    rejectionReason: text('rejection_reason'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('treasury_withdrawal_requests_guild_client_request_uq').on(table.guildId, table.clientRequestId),
    uniqueIndex('treasury_withdrawal_requests_entry_uq').on(table.treasuryEntryId).where(sql`${table.treasuryEntryId} is not null`),
    index('treasury_withdrawal_requests_status_idx').on(table.guildId, table.status, table.createdAt),
    check('treasury_withdrawal_requests_amount_positive', sql`${table.amount} > 0`),
    check('treasury_withdrawal_requests_reason_not_blank', sql`length(trim(${table.reason})) > 0`),
  ],
);

export const weeklyCollections = pgTable(
  'weekly_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    title: text('title').notNull(),
    startsOn: text('starts_on').notNull(),
    endsOn: text('ends_on').notNull(),
    conversionAt: timestamp('conversion_at', { withTimezone: true, mode: 'date' }).notNull(),
    standardAmount: bigint('standard_amount', { mode: 'number' }).notNull(),
    overdueFineAmount: bigint('overdue_fine_amount', { mode: 'number' }).notNull().default(0),
    recurringFineAmount: bigint('recurring_fine_amount', { mode: 'number' }).notNull().default(0),
    isClosed: boolean('is_closed').notNull().default(false),
    createdByDiscordUserId: text('created_by_discord_user_id').notNull(),
    publicChannelId: text('public_channel_id'),
    publicMessageId: text('public_message_id'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('weekly_collections_guild_request_uq').on(table.guildId, table.requestId),
    index('weekly_collections_conversion_idx').on(table.guildId, table.isClosed, table.conversionAt),
    check('weekly_collections_valid_dates', sql`${table.endsOn} >= ${table.startsOn}`),
    check('weekly_collections_amount_non_negative', sql`${table.standardAmount} >= 0 and ${table.overdueFineAmount} >= 0 and ${table.recurringFineAmount} >= 0`),
    check('weekly_collections_title_not_blank', sql`length(trim(${table.title})) > 0`),
  ],
);

export const weeklyObligations = pgTable(
  'weekly_obligations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    collectionId: uuid('collection_id').notNull().references(() => weeklyCollections.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    status: weeklyObligationStatusEnum('status').notNull().default('UNPAID'),
    attachmentId: text('attachment_id'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByDiscordUserId: text('decided_by_discord_user_id'),
    rejectionReason: text('rejection_reason'),
    convertedFineId: uuid('converted_fine_id').references(() => fines.id, { onDelete: 'set null' }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('weekly_obligations_collection_member_uq').on(table.collectionId, table.memberId),
    check('weekly_obligations_amount_non_negative', sql`${table.amount} >= 0`),
  ],
);

export const weeklyPaymentProofs = pgTable(
  'weekly_payment_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    obligationId: uuid('obligation_id').notNull().references(() => weeklyObligations.id, { onDelete: 'cascade' }),
    submittedByDiscordUserId: text('submitted_by_discord_user_id').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    attachmentId: text('attachment_id').notNull(),
    logChannelId: text('log_channel_id').notNull(),
    logMessageId: text('log_message_id').notNull(),
    status: requestStatusEnum('status').notNull().default('PENDING'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByDiscordUserId: text('decided_by_discord_user_id'),
    rejectionReason: text('rejection_reason'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('weekly_payment_proofs_guild_request_uq').on(table.guildId, table.requestId),
    uniqueIndex('weekly_payment_proofs_one_pending_uq').on(table.obligationId).where(sql`${table.status} = 'PENDING'`),
    check('weekly_payment_proofs_amount_positive', sql`${table.amount} > 0`),
  ],
);

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    itemCode: text('item_code').notNull(),
    itemName: text('item_name').notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('inventory_items_guild_code_uq').on(table.guildId, table.itemCode),
    uniqueIndex('inventory_items_guild_name_uq').on(table.guildId, table.itemName),
    check('inventory_items_quantity_non_negative', sql`${table.quantity} >= 0`),
    check('inventory_items_name_not_blank', sql`length(trim(${table.itemName})) > 0`),
  ],
);

export const inventoryBatches = pgTable(
  'inventory_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    batchRef: text('batch_ref').notNull(),
    fileHash: text('file_hash'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    originalAttachmentId: text('original_attachment_id'),
    publicChannelId: text('public_channel_id'),
    publicMessageId: text('public_message_id'),
    reason: text('reason').notNull(),
    reversedAt: timestamp('reversed_at', { withTimezone: true, mode: 'date' }),
    reversedByDiscordUserId: text('reversed_by_discord_user_id'),
    createdByDiscordUserId: text('created_by_discord_user_id').notNull(),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('inventory_batches_guild_ref_uq').on(table.guildId, table.batchRef),
    uniqueIndex('inventory_batches_guild_hash_uq').on(table.guildId, table.fileHash).where(sql`${table.fileHash} is not null`),
  ],
);

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').notNull().references(() => inventoryBatches.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id').notNull().references(() => inventoryItems.id, { onDelete: 'restrict' }),
    action: inventoryActionEnum('action').notNull(),
    quantityChange: bigint('quantity_change', { mode: 'number' }).notNull(),
    quantityBefore: bigint('quantity_before', { mode: 'number' }).notNull(),
    quantityAfter: bigint('quantity_after', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('inventory_movements_item_idx').on(table.guildId, table.itemId, table.createdAt),
    check('inventory_movements_change_non_zero', sql`${table.quantityChange} <> 0`),
    check('inventory_movements_quantities_non_negative', sql`${table.quantityBefore} >= 0 and ${table.quantityAfter} >= 0`),
    check('inventory_movements_math', sql`${table.quantityAfter} = ${table.quantityBefore} + ${table.quantityChange}`),
  ],
);

export const withdrawalRequests = pgTable(
  'withdrawal_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    clientRequestId: text('client_request_id').notNull(),
    requesterMemberId: uuid('requester_member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    status: withdrawalStatusEnum('status').notNull().default('PENDING'),
    publicChannelId: text('public_channel_id'),
    publicMessageId: text('public_message_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByDiscordUserId: text('decided_by_discord_user_id'),
    rejectionReason: text('rejection_reason'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('withdrawal_requests_guild_client_request_uq').on(table.guildId, table.clientRequestId),
    index('withdrawal_requests_status_idx').on(table.guildId, table.status),
  ],
);

export const withdrawalRequestItems = pgTable(
  'withdrawal_request_items',
  {
    requestId: uuid('request_id').notNull().references(() => withdrawalRequests.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id').notNull().references(() => inventoryItems.id, { onDelete: 'restrict' }),
    requestedQuantity: bigint('requested_quantity', { mode: 'number' }).notNull(),
    fulfilledQuantity: bigint('fulfilled_quantity', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.requestId, table.itemId] }),
    check('withdrawal_request_items_requested_positive', sql`${table.requestedQuantity} > 0`),
    check('withdrawal_request_items_fulfilled_valid', sql`${table.fulfilledQuantity} >= 0 and ${table.fulfilledQuantity} <= ${table.requestedQuantity}`),
  ],
);

export const withdrawalFulfillments = pgTable(
  'withdrawal_fulfillments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    clientRequestId: text('client_request_id').notNull(),
    requestId: uuid('request_id').notNull().references(() => withdrawalRequests.id, { onDelete: 'restrict' }),
    inventoryBatchId: uuid('inventory_batch_id').notNull().references(() => inventoryBatches.id, { onDelete: 'restrict' }),
    partialReason: text('partial_reason'),
    fulfilledByDiscordUserId: text('fulfilled_by_discord_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('withdrawal_fulfillments_guild_client_request_uq').on(table.guildId, table.clientRequestId),
    index('withdrawal_fulfillments_request_idx').on(table.guildId, table.requestId),
  ],
);

export const depositRequests = pgTable(
  'deposit_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' }),
    clientRequestId: text('client_request_id').notNull(),
    senderMemberId: uuid('sender_member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
    source: text('source').notNull(),
    attachmentId: text('attachment_id').notNull(),
    status: requestStatusEnum('status').notNull().default('PENDING'),
    inventoryBatchId: uuid('inventory_batch_id').references(() => inventoryBatches.id, { onDelete: 'restrict' }),
    publicChannelId: text('public_channel_id'),
    publicMessageId: text('public_message_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByDiscordUserId: text('decided_by_discord_user_id'),
    rejectionReason: text('rejection_reason'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('deposit_requests_guild_client_request_uq').on(table.guildId, table.clientRequestId),
    index('deposit_requests_status_idx').on(table.guildId, table.status),
  ],
);

export const depositRequestItems = pgTable(
  'deposit_request_items',
  {
    requestId: uuid('request_id').notNull().references(() => depositRequests.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id').notNull().references(() => inventoryItems.id, { onDelete: 'restrict' }),
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.requestId, table.itemId] }), check('deposit_request_items_quantity_positive', sql`${table.quantity} > 0`)],
);

export type GuildSettings = typeof guildSettings.$inferSelect;
export type Member = typeof members.$inferSelect;
export type FightPosition = typeof fightPositions.$inferSelect;
export type FightPositionSet = typeof fightPositionSets.$inferSelect;
export type MemberFightPosition = typeof memberFightPositions.$inferSelect;
