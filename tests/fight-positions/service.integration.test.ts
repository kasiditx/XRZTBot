import { and, eq } from 'drizzle-orm';
import { ConflictError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import {
  fightPositions,
  guildSettings,
  memberFightPositions,
  members,
  scheduledJobs,
} from '../../src/infrastructure/db/schema.js';
import { FightPositionService } from '../../src/modules/fight-positions/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('FightPositionService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: FightPositionService;
  const guildId = `fight-position-integration-${process.pid.toString()}`;
  const adminId = '700000000000000099';

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new FightPositionService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId });
  });

  afterAll(async () => {
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await pool.end();
  });

  it('creates positions and assigns one position to an active registered member', async () => {
    const [active, pending] = await db.insert(members).values([
      { guildId, discordUserId: '700000000000000001', inGameName: 'Zixx', status: 'ACTIVE' },
      { guildId, discordUserId: '700000000000000002', inGameName: 'Pending', status: 'PENDING' },
    ]).returning();
    expect(active).toBeDefined();
    expect(pending).toBeDefined();

    const main = await service.create(guildId, 'Main Fight', adminId);
    const support = await service.create(guildId, 'Support', adminId);
    await service.assign(guildId, active!.id, main.id, adminId);
    await service.assign(guildId, active!.id, support.id, adminId);

    const assignments = await db
      .select()
      .from(memberFightPositions)
      .where(and(eq(memberFightPositions.guildId, guildId), eq(memberFightPositions.memberId, active!.id)));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.positionId).toBe(support.id);
    expect((await service.listAssignedMembers(guildId)).map((member) => member.inGameName)).toEqual(['Zixx']);
    expect(await service.listUnassignedMembers(guildId)).toEqual([]);
    await expect(service.assign(guildId, pending!.id, main.id, adminId)).rejects.toBeInstanceOf(ConflictError);
  });

  it('lists every active member and marks members without a position as unassigned', async () => {
    await db.insert(members).values({
      guildId,
      discordUserId: '700000000000000003',
      inGameName: 'Lily',
      status: 'ACTIVE',
    });
    const roster = await service.listRoster(guildId);

    expect((await service.listUnassignedMembers(guildId)).map((member) => member.inGameName)).toEqual(['Lily']);
    expect(roster.map((entry) => [entry.inGameName, entry.positionName])).toEqual([
      ['Zixx', 'Support'],
      ['Lily', null],
    ]);
  });

  it('renames a position and soft-deletes it while clearing member assignments', async () => {
    const support = (await service.listActive(guildId)).find((position) => position.name === 'Support');
    expect(support).toBeDefined();
    const renamed = await service.rename(guildId, support!.id, 'Backline', adminId);
    expect(renamed.name).toBe('Backline');

    const removed = await service.remove(guildId, renamed.id, adminId);
    expect(removed.isActive).toBe(false);
    expect((await service.listActive(guildId)).map((position) => position.name)).toEqual(['Main Fight']);
    expect(await db.select().from(memberFightPositions).where(eq(memberFightPositions.guildId, guildId))).toHaveLength(0);
    expect((await service.listRoster(guildId)).every((entry) => entry.positionId === null)).toBe(true);

    const persisted = await db.select().from(fightPositions).where(eq(fightPositions.id, renamed.id));
    expect(persisted[0]?.isActive).toBe(false);
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(jobs.some((job) => job.jobType === 'FIGHT_POSITION_REFRESH')).toBe(true);
    expect(jobs.some((job) => job.jobType === 'AUDIT_PUBLISH')).toBe(true);
  });
});
