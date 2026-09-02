import { and, eq } from 'drizzle-orm';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { guildSettings, members, scheduledJobs } from '../../src/infrastructure/db/schema.js';
import { ActivityService, type ActivityWithScores, type SubmissionView } from '../../src/modules/activities/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('ActivityService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: ActivityService;
  let created: ActivityWithScores;
  let submission: SubmissionView;
  const guildId = 'activity-integration-guild';
  const now = new Date();
  const startsAt = new Date(now.getTime() - 60 * 60 * 1_000);
  const endsAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required');
    }
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new ActivityService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId }).onConflictDoNothing();
    await db.insert(members).values([
      { guildId, discordUserId: '100000000000000001', inGameName: 'Alpha', status: 'ACTIVE' },
      { guildId, discordUserId: '100000000000000002', inGameName: 'Beta', status: 'ACTIVE' },
      { guildId, discordUserId: '100000000000000003', inGameName: 'Charlie', status: 'ACTIVE' },
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates an idempotent activity with durable lifecycle jobs', async () => {
    const input = {
      guildId,
      requestId: 'discord-interaction-create-1',
      title: 'King of Loop',
      details: 'Integration test activity',
      startsAt,
      endsAt,
      mode: 'SCORE',
      scoreItems: [{ name: 'Loop A', points: 50 }, { name: 'Loop B', points: 100 }],
      actorDiscordUserId: '100000000000000001',
      now,
    } as const;
    created = await service.create(input);
    const duplicate = await service.create(input);
    expect(duplicate.activity.id).toBe(created.activity.id);
    expect(created.activity.status).toBe('OPEN');
    expect(created.scoreItems).toHaveLength(2);

    const jobs = await db
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.guildId, guildId), eq(scheduledJobs.payload, { activityId: created.activity.id })));
    expect(jobs.map((job) => job.jobType).sort()).toEqual([
      'ACTIVITY_CLOSE',
      'ACTIVITY_OPEN',
      'ACTIVITY_PUBLISH',
      'ACTIVITY_REMINDER',
    ]);
  });

  it('persists evidence and awards full score to every participant', async () => {
    const prepared = await service.prepareSubmission({
      guildId,
      activityId: created.activity.id,
      scoreItemId: created.scoreItems[0]!.id,
      submitterDiscordUserId: '100000000000000001',
      participantDiscordUserIds: ['100000000000000002'],
      note: 'first loop',
      now,
    });
    submission = await service.persistSubmission({
      prepared,
      requestId: 'discord-interaction-submit-1',
      attachmentIds: ['attachment-1'],
      logChannelId: 'log-channel',
      logMessageId: 'log-message',
      now,
    });
    expect(submission.participants.map((participant) => participant.inGameName).sort()).toEqual(['Alpha', 'Beta']);
    const leaderboard = await service.buildLeaderboard(guildId, created.activity.id);
    expect(leaderboard.map(({ rank, displayName, points }) => ({ rank, displayName, points }))).toEqual([
      { rank: 1, displayName: 'Alpha', points: 50 },
      { rank: 1, displayName: 'Beta', points: 50 },
    ]);
    expect(leaderboard.every((row) => row.memberId.length > 0)).toBe(true);
  });

  it('adds and removes participants without removing the submitter', async () => {
    submission = await service.editParticipants(
      guildId,
      submission.submission.id,
      '100000000000000001',
      false,
      'ADD',
      ['100000000000000003'],
      now,
    );
    expect(submission.participants).toHaveLength(3);

    submission = await service.editParticipants(
      guildId,
      submission.submission.id,
      '100000000000000001',
      false,
      'REMOVE',
      ['100000000000000001', '100000000000000002'],
      now,
    );
    expect(submission.participants.map((participant) => participant.inGameName).sort()).toEqual(['Alpha', 'Charlie']);
  });

  it('recalculates existing submissions when Admin changes score points', async () => {
    submission = await service.changeSubmissionScore(
      guildId,
      submission.submission.id,
      created.scoreItems[1]!.id,
      '100000000000000001',
      true,
      now,
    );
    await service.updateScoreItem(
      guildId,
      created.activity.id,
      created.scoreItems[1]!.id,
      'Loop B+',
      125,
      true,
      '100000000000000001',
    );
    const leaderboard = await service.buildLeaderboard(guildId, created.activity.id);
    expect(leaderboard.map((row) => ({ name: row.displayName, points: row.points }))).toEqual([
      { name: 'Alpha', points: 125 },
      { name: 'Charlie', points: 125 },
    ]);
  });

  it('blocks other members, closes automatically, and lets Admin audit-cancel after close', async () => {
    await expect(service.cancelSubmission(
      guildId,
      submission.submission.id,
      '100000000000000002',
      false,
      now,
    )).rejects.toBeInstanceOf(ConflictError);

    const closed = await service.close(guildId, created.activity.id, new Date(endsAt.getTime() + 1));
    expect(closed.status).toBe('CLOSED');
    await expect(service.editParticipants(
      guildId,
      submission.submission.id,
      '100000000000000001',
      false,
      'ADD',
      ['100000000000000002'],
      new Date(endsAt.getTime() + 1),
    )).rejects.toBeInstanceOf(ConflictError);

    const cancelled = await service.cancelSubmission(
      guildId,
      submission.submission.id,
      '100000000000000001',
      true,
      new Date(endsAt.getTime() + 1),
    );
    expect(cancelled.submission.isCancelled).toBe(true);
    expect(await service.buildLeaderboard(guildId, created.activity.id)).toEqual([]);
  });

  it('supports evidence activities without fake zero-point score items', async () => {
    const evidence = await service.create({
      guildId,
      requestId: 'discord-interaction-evidence-create-1',
      title: 'ส่งรูป Training',
      details: 'ส่งหลักฐานการฝึก',
      startsAt,
      endsAt,
      mode: 'EVIDENCE',
      scoreItems: [],
      actorDiscordUserId: '100000000000000001',
      now,
    });
    expect(evidence.scoreItems).toEqual([]);

    const prepared = await service.prepareSubmission({
      guildId,
      activityId: evidence.activity.id,
      scoreItemId: null,
      submitterDiscordUserId: '100000000000000001',
      participantDiscordUserIds: ['100000000000000002'],
      note: 'training evidence',
      now,
    });
    expect(prepared.scoreItem).toBeNull();
    const persisted = await service.persistSubmission({
      prepared,
      requestId: 'discord-interaction-evidence-submit-1',
      attachmentIds: ['attachment-evidence-1'],
      logChannelId: 'log-channel',
      logMessageId: 'log-message-evidence',
      now,
    });
    expect(persisted.scoreItem).toBeNull();
    expect(await service.buildParticipationSummary(guildId, evidence.activity.id)).toEqual({
      totalSubmissions: 1,
      rows: [
        expect.objectContaining({ displayName: 'Alpha', submissions: 1 }),
        expect.objectContaining({ displayName: 'Beta', submissions: 1 }),
      ],
    });
  });

  it('creates announcement activities without scores and rejects submissions', async () => {
    const announcement = await service.create({
      guildId,
      requestId: 'discord-interaction-announcement-create-1',
      title: 'ประชุมแก๊ง',
      details: 'ประกาศประชุม',
      startsAt,
      endsAt,
      mode: 'ANNOUNCEMENT',
      scoreItems: [],
      actorDiscordUserId: '100000000000000001',
      now,
    });
    await expect(service.prepareSubmission({
      guildId,
      activityId: announcement.activity.id,
      scoreItemId: null,
      submitterDiscordUserId: '100000000000000001',
      participantDiscordUserIds: [],
      note: '',
      now,
    })).rejects.toBeInstanceOf(ValidationError);
  });
});
