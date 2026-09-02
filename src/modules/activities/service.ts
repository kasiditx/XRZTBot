import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  activities,
  activityScoreItems,
  activitySubmissionParticipants,
  activitySubmissions,
  members,
  scheduledJobs,
} from '../../infrastructure/db/schema.js';
import { writeAudit } from '../audit/service.js';
import { buildLeaderboard, type LeaderboardRow } from './leaderboard.js';
import {
  requireShortText,
  validateActivityWindow,
  type ActivityScoreDefinition,
} from './rules.js';

export type Activity = typeof activities.$inferSelect;
export type ActivityScoreItem = typeof activityScoreItems.$inferSelect;
export type ActivitySubmission = typeof activitySubmissions.$inferSelect;
export type ActivityMode = Activity['mode'];

export interface ActivityWithScores {
  readonly activity: Activity;
  readonly scoreItems: readonly ActivityScoreItem[];
}

export interface CreateActivityInput {
  readonly guildId: string;
  readonly requestId: string;
  readonly title: string;
  readonly details: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly mode: ActivityMode;
  readonly scoreItems: readonly ActivityScoreDefinition[];
  readonly actorDiscordUserId: string;
  readonly now: Date;
}

export interface PreparedSubmission {
  readonly submissionId: string;
  readonly activity: Activity;
  readonly scoreItem: ActivityScoreItem | null;
  readonly submitter: ActiveMemberIdentity;
  readonly participants: readonly ActiveMemberIdentity[];
  readonly note: string | null;
}

export interface ActiveMemberIdentity {
  readonly id: string;
  readonly discordUserId: string;
  readonly inGameName: string;
}

export interface PrepareSubmissionInput {
  readonly guildId: string;
  readonly activityId: string;
  readonly scoreItemId: string | null;
  readonly submitterDiscordUserId: string;
  readonly participantDiscordUserIds: readonly string[];
  readonly note: string;
  readonly now: Date;
}

export interface PersistSubmissionInput {
  readonly prepared: PreparedSubmission;
  readonly requestId: string;
  readonly attachmentIds: readonly string[];
  readonly logChannelId: string;
  readonly logMessageId: string;
  readonly now: Date;
}

export interface SubmissionView {
  readonly submission: ActivitySubmission;
  readonly activity: Activity;
  readonly scoreItem: ActivityScoreItem | null;
  readonly submitter: ActiveMemberIdentity;
  readonly participants: readonly ActiveMemberIdentity[];
}

export type ParticipantEditOperation = 'ADD' | 'REMOVE';

export interface ActivityParticipationSummary {
  readonly totalSubmissions: number;
  readonly rows: readonly ActivityParticipationSummaryRow[];
}

export interface ActivityParticipationSummaryRow {
  readonly memberId: string;
  readonly displayName: string;
  readonly submissions: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

export class ActivityService {
  public constructor(private readonly db: Database) {}

  /** Creates an activity and all durable lifecycle jobs in one transaction. */
  public async create(input: CreateActivityInput): Promise<ActivityWithScores> {
    const title = requireShortText(input.title, 'ชื่อกิจกรรม', 2, 100);
    const details = requireShortText(input.details, 'รายละเอียดกิจกรรม', 2, 2_000);
    const status = validateActivityWindow(input.startsAt, input.endsAt, input.now);
    validateActivityMode(input.mode);
    if (input.mode === 'SCORE' && (input.scoreItems.length < 1 || input.scoreItems.length > 25)) {
      throw new ValidationError('กิจกรรมสะสมคะแนนต้องกำหนดรายการคะแนน 1–25 รายการ');
    }
    if (input.mode !== 'SCORE' && input.scoreItems.length !== 0) {
      throw new ValidationError('กิจกรรมรูปแบบนี้ต้องไม่มีรายการคะแนน');
    }
    const scoreNames = new Set<string>();
    const normalizedScores = input.scoreItems.map((score) => {
      const name = requireShortText(score.name, 'ชื่อรายการคะแนน', 1, 80);
      validatePoints(score.points);
      const normalizedName = name.toLocaleLowerCase('th');
      if (scoreNames.has(normalizedName)) {
        throw new ValidationError(`รายการคะแนนชื่อ ${name} ซ้ำกัน`);
      }
      scoreNames.add(normalizedName);
      return { name, points: score.points };
    });

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(activities)
        .where(and(eq(activities.guildId, input.guildId), eq(activities.requestId, input.requestId)))
        .limit(1);
      if (existing !== undefined) {
        const existingScores = await tx
          .select()
          .from(activityScoreItems)
          .where(eq(activityScoreItems.activityId, existing.id))
          .orderBy(asc(activityScoreItems.sortOrder));
        return { activity: existing, scoreItems: existingScores };
      }

      const [activity] = await tx
        .insert(activities)
        .values({
          guildId: input.guildId,
          requestId: input.requestId,
          title,
          details,
          mode: input.mode,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          status,
          createdByDiscordUserId: input.actorDiscordUserId,
        })
        .returning();
      if (activity === undefined) {
        throw new Error('Activity creation did not return a row');
      }

      const scoreItems = normalizedScores.length === 0
        ? []
        : await tx
          .insert(activityScoreItems)
          .values(normalizedScores.map((score, index) => ({
            activityId: activity.id,
            name: score.name,
            points: score.points,
            sortOrder: index,
          })))
          .returning();

      await writeAudit(tx, {
        guildId: input.guildId,
        actorDiscordUserId: input.actorDiscordUserId,
        action: 'ACTIVITY_CREATED',
        entityType: 'ACTIVITY',
        entityId: activity.id,
        after: { activity, scoreItems },
      });

      await queueActivityLifecycleJobs(tx, activity, input.now);
      return { activity, scoreItems };
    });
  }

  public async listForAdministration(guildId: string): Promise<Activity[]> {
    return this.db
      .select()
      .from(activities)
      .where(and(eq(activities.guildId, guildId), ne(activities.status, 'CANCELLED')))
      .orderBy(asc(activities.endsAt))
      .limit(25);
  }

  public async getWithScores(guildId: string, activityId: string, includeInactive = false): Promise<ActivityWithScores> {
    const [activity] = await this.db
      .select()
      .from(activities)
      .where(and(eq(activities.guildId, guildId), eq(activities.id, activityId)))
      .limit(1);
    if (activity === undefined) {
      throw new NotFoundError('ไม่พบกิจกรรม');
    }

    const scoreItems = await this.db
      .select()
      .from(activityScoreItems)
      .where(and(
        eq(activityScoreItems.activityId, activityId),
        ...(includeInactive ? [] : [eq(activityScoreItems.isActive, true)]),
      ))
      .orderBy(asc(activityScoreItems.sortOrder));
    return { activity, scoreItems };
  }

  public async addScoreItem(
    guildId: string,
    activityId: string,
    name: string,
    points: number,
    actorDiscordUserId: string,
  ): Promise<ActivityScoreItem> {
    const normalizedName = requireShortText(name, 'ชื่อรายการคะแนน', 1, 80);
    validatePoints(points);

    return this.db.transaction(async (tx) => {
      const activity = await lockActivity(tx, guildId, activityId);
      requireActivityNotFinished(activity);
      requireScoreActivity(activity);
      const existingScores = await tx.select().from(activityScoreItems).where(eq(activityScoreItems.activityId, activityId));
      if (existingScores.length >= 25) {
        throw new ConflictError('กิจกรรมหนึ่งมีรายการคะแนนได้สูงสุด 25 รายการ');
      }
      if (existingScores.some((score) => score.name.toLocaleLowerCase('th') === normalizedName.toLocaleLowerCase('th'))) {
        throw new ConflictError('ชื่อรายการคะแนนซ้ำกับรายการเดิม');
      }

      const [created] = await tx
        .insert(activityScoreItems)
        .values({ activityId, name: normalizedName, points, sortOrder: existingScores.length })
        .returning();
      if (created === undefined) {
        throw new Error('Score item creation did not return a row');
      }
      await writeActivityAudit(tx, guildId, actorDiscordUserId, 'ACTIVITY_SCORE_ADDED', 'ACTIVITY_SCORE_ITEM', created.id, null, created);
      return created;
    });
  }

  public async updateScoreItem(
    guildId: string,
    activityId: string,
    scoreItemId: string,
    name: string,
    points: number,
    isActive: boolean,
    actorDiscordUserId: string,
  ): Promise<ActivityScoreItem> {
    const normalizedName = requireShortText(name, 'ชื่อรายการคะแนน', 1, 80);
    validatePoints(points);

    return this.db.transaction(async (tx) => {
      const activity = await lockActivity(tx, guildId, activityId);
      requireActivityNotFinished(activity);
      requireScoreActivity(activity);
      const [score] = await tx
        .select()
        .from(activityScoreItems)
        .where(and(eq(activityScoreItems.id, scoreItemId), eq(activityScoreItems.activityId, activityId)))
        .limit(1)
        .for('update');
      if (score === undefined) {
        throw new NotFoundError('ไม่พบรายการคะแนน');
      }
      const duplicate = await tx
        .select({ id: activityScoreItems.id, name: activityScoreItems.name })
        .from(activityScoreItems)
        .where(and(eq(activityScoreItems.activityId, activityId), ne(activityScoreItems.id, scoreItemId)));
      if (duplicate.some((item) => item.name.toLocaleLowerCase('th') === normalizedName.toLocaleLowerCase('th'))) {
        throw new ConflictError('ชื่อรายการคะแนนซ้ำกับรายการเดิม');
      }

      const [updated] = await tx
        .update(activityScoreItems)
        .set({ name: normalizedName, points, isActive, updatedAt: new Date() })
        .where(eq(activityScoreItems.id, scoreItemId))
        .returning();
      if (updated === undefined) {
        throw new Error('Score item update did not return a row');
      }
      await writeActivityAudit(tx, guildId, actorDiscordUserId, 'ACTIVITY_SCORE_UPDATED', 'ACTIVITY_SCORE_ITEM', updated.id, score, updated);
      return updated;
    });
  }

  /** Resolves active member identities before uploading evidence to the public log. */
  public async prepareSubmission(input: PrepareSubmissionInput): Promise<PreparedSubmission> {
    const activityWithScores = await this.getWithScores(input.guildId, input.activityId);
    requireActivityOpen(activityWithScores.activity, input.now);
    if (activityWithScores.activity.mode === 'ANNOUNCEMENT') {
      throw new ValidationError('กิจกรรมประกาศไม่เปิดรับการส่งผลงาน');
    }
    const scoreItem = activityWithScores.activity.mode === 'SCORE'
      ? activityWithScores.scoreItems.find((score) => score.id === input.scoreItemId) ?? null
      : null;
    if (activityWithScores.activity.mode === 'SCORE' && scoreItem === null) {
      throw new ValidationError('รายการคะแนนนี้ไม่มีอยู่หรือถูกปิดใช้งาน');
    }
    if (activityWithScores.activity.mode === 'EVIDENCE' && input.scoreItemId !== null) {
      throw new ValidationError('กิจกรรมส่งผลงานไม่ใช้รายการคะแนน');
    }

    const requestedDiscordIds = [...new Set([input.submitterDiscordUserId, ...input.participantDiscordUserIds])];
    const activeMembers = await this.findActiveMembers(input.guildId, requestedDiscordIds);
    if (activeMembers.length !== requestedDiscordIds.length) {
      throw new ValidationError('ผู้ร่วมกิจกรรมทุกคนต้องเป็นสมาชิกที่มีสถานะใช้งาน');
    }
    const submitter = activeMembers.find((member) => member.discordUserId === input.submitterDiscordUserId);
    if (submitter === undefined) {
      throw new ValidationError('ผู้ส่งต้องเป็นสมาชิกที่มีสถานะใช้งาน');
    }
    const note = input.note.trim().length === 0 ? null : requireShortText(input.note, 'หมายเหตุ', 1, 500);
    return {
      submissionId: randomUUID(),
      activity: activityWithScores.activity,
      scoreItem,
      submitter,
      participants: activeMembers,
      note,
    };
  }

  /** Persists a submission after Discord has durably re-uploaded all evidence images. */
  public async persistSubmission(input: PersistSubmissionInput): Promise<SubmissionView> {
    if (input.attachmentIds.length < 1 || input.attachmentIds.length > 5) {
      throw new ValidationError('ต้องมี Discord attachment 1–5 รูป');
    }

    await this.db.transaction(async (tx) => {
      const activity = await lockActivity(tx, input.prepared.activity.guildId, input.prepared.activity.id);
      requireActivityOpen(activity, input.now);

      const currentIdentities = await findActiveMembersWithTransaction(
        tx,
        activity.guildId,
        input.prepared.participants.map((participant) => participant.discordUserId),
      );
      if (currentIdentities.length !== input.prepared.participants.length) {
        throw new ConflictError('สถานะของผู้ร่วมกิจกรรมเปลี่ยนไป กรุณาส่งรายการใหม่');
      }

      if (activity.mode === 'ANNOUNCEMENT') {
        throw new ConflictError('กิจกรรมประกาศไม่เปิดรับการส่งผลงาน');
      }
      let score: ActivityScoreItem | null = null;
      if (activity.mode === 'SCORE') {
        if (input.prepared.scoreItem === null) {
          throw new ConflictError('ข้อมูลรายการคะแนนไม่ครบ กรุณาส่งใหม่');
        }
        const [currentScore] = await tx
          .select()
          .from(activityScoreItems)
          .where(and(
            eq(activityScoreItems.id, input.prepared.scoreItem.id),
            eq(activityScoreItems.activityId, activity.id),
            eq(activityScoreItems.isActive, true),
          ))
          .limit(1);
        if (currentScore === undefined) {
          throw new ConflictError('รายการคะแนนถูกเปลี่ยนหรือปิดใช้งาน กรุณาส่งใหม่');
        }
        score = currentScore;
      }

      await tx.insert(activitySubmissions).values({
        id: input.prepared.submissionId,
        guildId: activity.guildId,
        requestId: input.requestId,
        activityId: activity.id,
        scoreItemId: score?.id ?? null,
        submitterMemberId: input.prepared.submitter.id,
        note: input.prepared.note,
        imageAttachmentIds: [...input.attachmentIds],
        logChannelId: input.logChannelId,
        logMessageId: input.logMessageId,
      });
      await tx.insert(activitySubmissionParticipants).values(
        currentIdentities.map((participant) => ({
          submissionId: input.prepared.submissionId,
          memberId: participant.id,
        })),
      );
      await writeActivityAudit(
        tx,
        activity.guildId,
        input.prepared.submitter.discordUserId,
        'ACTIVITY_SUBMISSION_CREATED',
        'ACTIVITY_SUBMISSION',
        input.prepared.submissionId,
        null,
        { scoreItemId: score?.id ?? null, participantIds: currentIdentities.map((member) => member.id) },
      );
    });

    return this.getSubmission(input.prepared.activity.guildId, input.prepared.submissionId);
  }

  public async getSubmission(guildId: string, submissionId: string): Promise<SubmissionView> {
    const [row] = await this.db
      .select({ submission: activitySubmissions, activity: activities, scoreItem: activityScoreItems, submitter: members })
      .from(activitySubmissions)
      .innerJoin(activities, eq(activitySubmissions.activityId, activities.id))
      .leftJoin(activityScoreItems, eq(activitySubmissions.scoreItemId, activityScoreItems.id))
      .innerJoin(members, eq(activitySubmissions.submitterMemberId, members.id))
      .where(and(eq(activitySubmissions.guildId, guildId), eq(activitySubmissions.id, submissionId)))
      .limit(1);
    if (row === undefined) {
      throw new NotFoundError('ไม่พบรายการส่งกิจกรรม');
    }
    const participants = await this.db
      .select({ id: members.id, discordUserId: members.discordUserId, inGameName: members.inGameName })
      .from(activitySubmissionParticipants)
      .innerJoin(members, eq(activitySubmissionParticipants.memberId, members.id))
      .where(eq(activitySubmissionParticipants.submissionId, submissionId))
      .orderBy(asc(members.inGameName));
    return {
      submission: row.submission,
      activity: row.activity,
      scoreItem: row.scoreItem,
      submitter: toIdentity(row.submitter),
      participants,
    };
  }

  public async cancelSubmission(
    guildId: string,
    submissionId: string,
    actorDiscordUserId: string,
    isAdmin: boolean,
    now: Date,
  ): Promise<SubmissionView> {
    await this.db.transaction(async (tx) => {
      const context = await lockSubmissionContext(tx, guildId, submissionId);
      requireSubmissionMutationAccess(context.activity, context.submitterDiscordUserId, actorDiscordUserId, isAdmin, now);
      if (context.submission.isCancelled) {
        return;
      }
      const [updated] = await tx
        .update(activitySubmissions)
        .set({
          isCancelled: true,
          cancelledAt: now,
          cancelledByDiscordUserId: actorDiscordUserId,
          updatedAt: now,
        })
        .where(eq(activitySubmissions.id, submissionId))
        .returning();
      await writeActivityAudit(tx, guildId, actorDiscordUserId, 'ACTIVITY_SUBMISSION_CANCELLED', 'ACTIVITY_SUBMISSION', submissionId, context.submission, updated ?? null);
    });
    return this.getSubmission(guildId, submissionId);
  }

  public async editParticipants(
    guildId: string,
    submissionId: string,
    actorDiscordUserId: string,
    isAdmin: boolean,
    operation: ParticipantEditOperation,
    participantDiscordUserIds: readonly string[],
    now: Date,
  ): Promise<SubmissionView> {
    const requestedIds = [...new Set(participantDiscordUserIds)];
    if (requestedIds.length === 0) {
      throw new ValidationError('กรุณาเลือกผู้ร่วมอย่างน้อย 1 คน');
    }

    await this.db.transaction(async (tx) => {
      const context = await lockSubmissionContext(tx, guildId, submissionId);
      requireSubmissionMutationAccess(context.activity, context.submitterDiscordUserId, actorDiscordUserId, isAdmin, now);
      requireNotCancelled(context.submission);
      requireScoreActivity(context.activity);
      const selectedMembers = await findActiveMembersWithTransaction(tx, guildId, requestedIds);
      if (selectedMembers.length !== requestedIds.length) {
        throw new ValidationError('ผู้ที่เลือกทุกคนต้องเป็นสมาชิกที่มีสถานะใช้งาน');
      }

      if (operation === 'ADD') {
        await tx
          .insert(activitySubmissionParticipants)
          .values(selectedMembers.map((member) => ({ submissionId, memberId: member.id })))
          .onConflictDoNothing();
      } else {
        const removableMemberIds = selectedMembers
          .filter((member) => member.id !== context.submission.submitterMemberId)
          .map((member) => member.id);
        if (removableMemberIds.length > 0) {
          await tx.delete(activitySubmissionParticipants).where(and(
            eq(activitySubmissionParticipants.submissionId, submissionId),
            inArray(activitySubmissionParticipants.memberId, removableMemberIds),
          ));
        }
      }

      await writeActivityAudit(
        tx,
        guildId,
        actorDiscordUserId,
        `ACTIVITY_PARTICIPANTS_${operation}`,
        'ACTIVITY_SUBMISSION',
        submissionId,
        null,
        { participantDiscordUserIds: requestedIds },
      );
    });
    return this.getSubmission(guildId, submissionId);
  }

  public async changeSubmissionScore(
    guildId: string,
    submissionId: string,
    scoreItemId: string,
    actorDiscordUserId: string,
    isAdmin: boolean,
    now: Date,
  ): Promise<SubmissionView> {
    await this.db.transaction(async (tx) => {
      const context = await lockSubmissionContext(tx, guildId, submissionId);
      requireSubmissionMutationAccess(context.activity, context.submitterDiscordUserId, actorDiscordUserId, isAdmin, now);
      requireNotCancelled(context.submission);
      const [score] = await tx.select().from(activityScoreItems).where(and(
        eq(activityScoreItems.id, scoreItemId),
        eq(activityScoreItems.activityId, context.activity.id),
        eq(activityScoreItems.isActive, true),
      )).limit(1);
      if (score === undefined) {
        throw new ValidationError('รายการคะแนนไม่มีอยู่หรือถูกปิดใช้งาน');
      }
      const [updated] = await tx
        .update(activitySubmissions)
        .set({ scoreItemId, updatedAt: now })
        .where(eq(activitySubmissions.id, submissionId))
        .returning();
      await writeActivityAudit(tx, guildId, actorDiscordUserId, 'ACTIVITY_SUBMISSION_SCORE_CHANGED', 'ACTIVITY_SUBMISSION', submissionId, context.submission, updated ?? null);
    });
    return this.getSubmission(guildId, submissionId);
  }

  public async buildLeaderboard(guildId: string, activityId: string): Promise<LeaderboardRow[]> {
    const { activity } = await this.getWithScores(guildId, activityId, true);
    requireScoreActivity(activity);
    const contributions = await this.db
      .select({ memberId: members.id, displayName: members.inGameName, points: activityScoreItems.points })
      .from(activitySubmissionParticipants)
      .innerJoin(activitySubmissions, eq(activitySubmissionParticipants.submissionId, activitySubmissions.id))
      .innerJoin(activityScoreItems, eq(activitySubmissions.scoreItemId, activityScoreItems.id))
      .innerJoin(members, eq(activitySubmissionParticipants.memberId, members.id))
      .where(and(
        eq(activitySubmissions.guildId, guildId),
        eq(activitySubmissions.activityId, activityId),
        eq(activitySubmissions.isCancelled, false),
      ));
    return buildLeaderboard(contributions);
  }

  public async buildParticipationSummary(guildId: string, activityId: string): Promise<ActivityParticipationSummary> {
    const { activity } = await this.getWithScores(guildId, activityId, true);
    if (activity.mode !== 'EVIDENCE') {
      throw new ValidationError('สรุปจำนวนผลงานใช้ได้เฉพาะกิจกรรมส่งผลงาน');
    }
    const submissions = await this.db
      .select({ submissionId: activitySubmissions.id, memberId: members.id, displayName: members.inGameName })
      .from(activitySubmissionParticipants)
      .innerJoin(activitySubmissions, eq(activitySubmissionParticipants.submissionId, activitySubmissions.id))
      .innerJoin(members, eq(activitySubmissionParticipants.memberId, members.id))
      .where(and(
        eq(activitySubmissions.guildId, guildId),
        eq(activitySubmissions.activityId, activityId),
        eq(activitySubmissions.isCancelled, false),
      ));
    const counts = new Map<string, ActivityParticipationSummaryRow>();
    for (const row of submissions) {
      const current = counts.get(row.memberId);
      counts.set(row.memberId, {
        memberId: row.memberId,
        displayName: row.displayName,
        submissions: (current?.submissions ?? 0) + 1,
      });
    }
    return {
      totalSubmissions: new Set(submissions.map((row) => row.submissionId)).size,
      rows: [...counts.values()].sort((left, right) =>
        right.submissions - left.submissions || left.displayName.localeCompare(right.displayName, 'th')),
    };
  }

  public async markPublished(guildId: string, activityId: string, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(activities)
      .set({ announcementChannelId: channelId, announcementMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(activities.guildId, guildId), eq(activities.id, activityId)));
  }

  public async markLeaderboardPublished(guildId: string, activityId: string, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(activities)
      .set({ leaderboardChannelId: channelId, leaderboardMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(activities.guildId, guildId), eq(activities.id, activityId)));
  }

  public async open(guildId: string, activityId: string, now: Date): Promise<Activity> {
    return this.db.transaction(async (tx) => {
      const activity = await lockActivity(tx, guildId, activityId);
      if (activity.status === 'CANCELLED' || activity.status === 'CLOSED') {
        return activity;
      }
      if (now < activity.startsAt) {
        throw new ConflictError('ยังไม่ถึงเวลาเปิดกิจกรรม');
      }
      const [updated] = await tx
        .update(activities)
        .set({ status: now >= activity.endsAt ? 'CLOSED' : 'OPEN', updatedAt: now })
        .where(eq(activities.id, activityId))
        .returning();
      return updated ?? activity;
    });
  }

  public async close(guildId: string, activityId: string, now: Date): Promise<Activity> {
    return this.db.transaction(async (tx) => {
      const activity = await lockActivity(tx, guildId, activityId);
      if (activity.status === 'CANCELLED' || activity.status === 'CLOSED') {
        return activity;
      }
      if (now < activity.endsAt) {
        throw new ConflictError('ยังไม่ถึงเวลาปิดกิจกรรม');
      }
      const [updated] = await tx
        .update(activities)
        .set({ status: 'CLOSED', updatedAt: now })
        .where(eq(activities.id, activityId))
        .returning();
      if (updated === undefined) {
        throw new Error('Activity close did not return a row');
      }
      await writeActivityAudit(tx, guildId, 'SYSTEM', 'ACTIVITY_CLOSED', 'ACTIVITY', activityId, activity, updated);
      return updated;
    });
  }

  private async findActiveMembers(guildId: string, discordUserIds: readonly string[]): Promise<ActiveMemberIdentity[]> {
    if (discordUserIds.length === 0) {
      return [];
    }
    return this.db
      .select({ id: members.id, discordUserId: members.discordUserId, inGameName: members.inGameName })
      .from(members)
      .where(and(eq(members.guildId, guildId), eq(members.status, 'ACTIVE'), inArray(members.discordUserId, [...discordUserIds])));
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function queueActivityLifecycleJobs(tx: Transaction, activity: Activity, now: Date): Promise<void> {
  const jobs: Array<{ jobType: string; key: string; runAt: Date }> = [
    { jobType: 'ACTIVITY_PUBLISH', key: 'publish', runAt: now },
    { jobType: 'ACTIVITY_OPEN', key: 'open', runAt: activity.startsAt },
    { jobType: 'ACTIVITY_CLOSE', key: 'close', runAt: activity.endsAt },
  ];
  const reminderAt = new Date(activity.endsAt.getTime() - ONE_DAY_MS);
  if (reminderAt >= now) {
    jobs.push({ jobType: 'ACTIVITY_REMINDER', key: 'reminder', runAt: reminderAt });
  }
  await tx.insert(scheduledJobs).values(jobs.map((job) => ({
    guildId: activity.guildId,
    jobType: job.jobType,
    deduplicationKey: `activity:${activity.id}:${job.key}`,
    payload: { activityId: activity.id },
    runAt: job.runAt,
  })));
}

async function lockActivity(tx: Transaction, guildId: string, activityId: string): Promise<Activity> {
  const [activity] = await tx
    .select()
    .from(activities)
    .where(and(eq(activities.guildId, guildId), eq(activities.id, activityId)))
    .limit(1)
    .for('update');
  if (activity === undefined) {
    throw new NotFoundError('ไม่พบกิจกรรม');
  }
  return activity;
}

async function findActiveMembersWithTransaction(
  tx: Transaction,
  guildId: string,
  discordUserIds: readonly string[],
): Promise<ActiveMemberIdentity[]> {
  if (discordUserIds.length === 0) {
    return [];
  }
  return tx
    .select({ id: members.id, discordUserId: members.discordUserId, inGameName: members.inGameName })
    .from(members)
    .where(and(eq(members.guildId, guildId), eq(members.status, 'ACTIVE'), inArray(members.discordUserId, [...discordUserIds])));
}

async function lockSubmissionContext(tx: Transaction, guildId: string, submissionId: string) {
  const [context] = await tx
    .select({ submission: activitySubmissions, activity: activities, submitterDiscordUserId: members.discordUserId })
    .from(activitySubmissions)
    .innerJoin(activities, eq(activitySubmissions.activityId, activities.id))
    .innerJoin(members, eq(activitySubmissions.submitterMemberId, members.id))
    .where(and(eq(activitySubmissions.guildId, guildId), eq(activitySubmissions.id, submissionId)))
    .limit(1)
    .for('update');
  if (context === undefined) {
    throw new NotFoundError('ไม่พบรายการส่งกิจกรรม');
  }
  return context;
}

function requireSubmissionMutationAccess(
  activity: Activity,
  submitterDiscordUserId: string,
  actorDiscordUserId: string,
  isAdmin: boolean,
  now: Date,
): void {
  if (!isAdmin && submitterDiscordUserId !== actorDiscordUserId) {
    throw new ConflictError('แก้ไขได้เฉพาะผู้ส่งรายการหรือหัวแก๊ง/รองแก๊ง');
  }
  if (!isAdmin) {
    requireActivityOpen(activity, now);
  }
}

function requireActivityOpen(activity: Activity, now: Date): void {
  if (activity.status === 'CANCELLED' || activity.status === 'CLOSED' || now < activity.startsAt || now >= activity.endsAt) {
    throw new ConflictError('กิจกรรมยังไม่เปิดหรือปิดรับผลงานแล้ว');
  }
}

function requireActivityNotFinished(activity: Activity): void {
  if (activity.status === 'CANCELLED' || activity.status === 'CLOSED' || activity.endsAt <= new Date()) {
    throw new ConflictError('กิจกรรมนี้ปิดแล้ว ไม่สามารถแก้รายการคะแนนได้');
  }
}

function requireScoreActivity(activity: Activity): void {
  if (activity.mode !== 'SCORE') {
    throw new ValidationError('รายการคะแนนและ Leaderboard ใช้ได้เฉพาะกิจกรรมสะสมคะแนน');
  }
}

function validateActivityMode(mode: ActivityMode): void {
  if (mode !== 'SCORE' && mode !== 'EVIDENCE' && mode !== 'ANNOUNCEMENT') {
    throw new ValidationError('รูปแบบกิจกรรมไม่ถูกต้อง');
  }
}

function requireNotCancelled(submission: ActivitySubmission): void {
  if (submission.isCancelled) {
    throw new ConflictError('รายการนี้ถูกยกเลิกแล้ว');
  }
}

function validatePoints(points: number): void {
  if (!Number.isSafeInteger(points) || points < 0 || points > 1_000_000_000) {
    throw new ValidationError('คะแนนต้องเป็นจำนวนเต็ม 0–1,000,000,000');
  }
}

function toIdentity(member: typeof members.$inferSelect): ActiveMemberIdentity {
  return { id: member.id, discordUserId: member.discordUserId, inGameName: member.inGameName };
}

async function writeActivityAudit(
  tx: Transaction,
  guildId: string,
  actorDiscordUserId: string,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await writeAudit(tx, {
    guildId,
    actorDiscordUserId,
    action,
    entityType,
    entityId,
    before,
    after,
  });
}
