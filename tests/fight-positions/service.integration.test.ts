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
    const set1 = await service.getActiveSet(guildId);
    const set2 = await service.createSet(guildId, 'Set 2', adminId);
    await service.assign(guildId, set1.id, active!.id, main.id, adminId);
    await service.assign(guildId, set1.id, active!.id, support.id, adminId);
    await service.assign(guildId, set2.id, active!.id, main.id, adminId);

    const assignments = await db
      .select()
      .from(memberFightPositions)
      .where(and(eq(memberFightPositions.guildId, guildId), eq(memberFightPositions.memberId, active!.id)));
    expect(assignments).toHaveLength(2);
    expect(assignments.find((assignment) => assignment.setId === set1.id)?.positionId).toBe(support.id);
    expect(assignments.find((assignment) => assignment.setId === set2.id)?.positionId).toBe(main.id);
    expect((await service.listAssignedMembers(guildId, set1.id)).map((member) => member.inGameName)).toEqual(['Zixx']);
    expect(await service.listUnassignedMembers(guildId, set1.id)).toEqual([]);
    await expect(service.assign(guildId, set1.id, pending!.id, main.id, adminId)).rejects.toBeInstanceOf(ConflictError);

    const activated = await service.activateSet(guildId, set2.id, adminId);
    expect(activated.isActive).toBe(true);
    expect((await service.getActiveSet(guildId)).id).toBe(set2.id);
  });

  it('lists every active member and marks members without a position as unassigned', async () => {
    await db.insert(members).values({
      guildId,
      discordUserId: '700000000000000003',
      inGameName: 'Lily',
      status: 'ACTIVE',
    });
    const set1 = (await service.listSets(guildId)).find((set) => set.name === 'Set 1');
    expect(set1).toBeDefined();
    const roster = await service.listRoster(guildId, set1!.id);

    expect((await service.listUnassignedMembers(guildId, set1!.id)).map((member) => member.inGameName)).toEqual(['Lily']);
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
    const remainingAssignments = await db.select().from(memberFightPositions)
      .where(eq(memberFightPositions.guildId, guildId));
    expect(remainingAssignments).toHaveLength(1);
    expect(remainingAssignments[0]?.positionId).not.toBe(removed.id);
    const allSetRosters = await service.listAllSetRosters(guildId);
    expect(allSetRosters).toHaveLength(2);
    expect(allSetRosters.find(({ set }) => set.name === 'Set 1')?.roster.every((entry) => entry.positionId === null)).toBe(true);
    expect(allSetRosters.find(({ set }) => set.name === 'Set 2')?.roster.some((entry) => entry.positionName === 'Main Fight')).toBe(true);

    const persisted = await db.select().from(fightPositions).where(eq(fightPositions.id, renamed.id));
    expect(persisted[0]?.isActive).toBe(false);
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(jobs.some((job) => job.jobType === 'FIGHT_POSITION_REFRESH')).toBe(true);
    expect(jobs.some((job) => job.jobType === 'AUDIT_PUBLISH')).toBe(true);
  });
});
