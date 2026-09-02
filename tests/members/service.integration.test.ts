import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import {
  fightPositions,
  fightPositionSets,
  guildSettings,
  memberFightPositions,
  scheduledJobs,
} from '../../src/infrastructure/db/schema.js';
import { MemberService, type MemberRoleIds } from '../../src/modules/members/service.js';
import { ConflictError } from '../../src/domain/errors.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('MemberService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: MemberService;
  const guildId = `member-integration-guild-${process.pid.toString()}`;
  const admin = '700000000000000099';
  const roleIds: MemberRoleIds = {
    headRoleId: '800000000000000003',
    deputyRoleId: '800000000000000004',
    activeMemberRoleId: '800000000000000001',
    formerMemberRoleId: '800000000000000002',
  };

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new MemberService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('adds a direct member to the active roster and queues a roster refresh', async () => {
    await service.addDirectly(guildId, '700000000000000001', 'Zixx Quint', admin, roleIds);

    const activeMembers = await service.listActive(guildId);
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(activeMembers.map((member) => member.inGameName)).toEqual(['Zixx Quint']);
    expect(jobs.some((job) => job.jobType === 'MEMBER_ROSTER_REFRESH')).toBe(true);
  });

  it('adds an approved registration to the active roster', async () => {
    const pending = await service.register(guildId, '700000000000000002', 'Miko');
    await service.approve(guildId, pending.id, admin, roleIds);

    const activeMembers = await service.listActive(guildId);
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(activeMembers.map((member) => member.inGameName)).toEqual(['Miko', 'Zixx Quint']);
    expect(await service.getRegistrationEligibility(guildId, pending.discordUserId)).toBe('ACTIVE');
    expect(jobs.filter((job) => (
      job.jobType === 'MEMBER_REGISTRATION_REQUEST_SYNC'
      && job.payload.memberId === pending.id
    ))).toHaveLength(2);
  });

  it('reports registration eligibility before opening the form and rejects duplicate submission', async () => {
    const userId = '700000000000000003';
    expect(await service.getRegistrationEligibility(guildId, userId)).toBe('ELIGIBLE');
    await service.register(guildId, userId, 'Pending Miru');
    expect(await service.getRegistrationEligibility(guildId, userId)).toBe('PENDING');
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(jobs.some((job) => job.jobType === 'MEMBER_REGISTRATION_REQUEST_SYNC')).toBe(true);
    const queued = await service.queuePendingRegistrationRequestSync(guildId);
    expect(queued).toBeGreaterThanOrEqual(1);
    await expect(service.register(guildId, userId, 'Pending Miru')).rejects.toBeInstanceOf(ConflictError);
  });

  it('assigns display-only roster titles, permits multiple deputies, and replaces a singleton title', async () => {
    const miko = await service.findByDiscordUserId(guildId, '700000000000000002');
    const zixx = await service.findByDiscordUserId(guildId, '700000000000000001');
    expect(miko).not.toBeNull();
    expect(zixx).not.toBeNull();
    const nami = await service.addDirectly(guildId, '700000000000000004', 'Nami', admin, roleIds);
    await service.assignRosterTitle(guildId, miko!.id, 'HEAD', admin, roleIds);
    await service.assignRosterTitle(guildId, nami.id, 'DEPUTY', admin, roleIds);
    await service.assignRosterTitle(guildId, zixx!.id, 'ACCOUNTANT', admin, roleIds);
    expect((await service.listActive(guildId)).map((member) => [member.inGameName, member.rosterTitle])).toEqual([
      ['Miko', 'HEAD'],
      ['Nami', 'DEPUTY'],
      ['Zixx Quint', 'ACCOUNTANT'],
    ]);

    await service.assignRosterTitle(guildId, nami.id, 'HEAD', admin, roleIds);
    expect((await service.findById(guildId, miko!.id))?.rosterTitle).toBeNull();
    expect((await service.findById(guildId, nami.id))?.rosterTitle).toBe('HEAD');
    const adminRoleSyncJobs = (await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId)))
      .filter((job) => job.jobType === 'MEMBER_ADMIN_ROLE_SYNC');
    expect(adminRoleSyncJobs.some((job) => job.payload.discordUserId === miko!.discordUserId && job.payload.desiredRole === 'HEAD')).toBe(true);
    expect(adminRoleSyncJobs.some((job) => job.payload.discordUserId === nami.discordUserId && job.payload.desiredRole === 'DEPUTY')).toBe(true);
    expect(adminRoleSyncJobs.some((job) => job.payload.discordUserId === zixx!.discordUserId && job.payload.desiredRole === null)).toBe(true);
  });

  it('removes a former member from the active roster and queues another refresh', async () => {
    const refreshJobsBefore = (await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId)))
      .filter((job) => job.jobType === 'MEMBER_ROSTER_REFRESH').length;
    const zixxBeforeDeparture = await service.findByDiscordUserId(guildId, '700000000000000001');
    expect(zixxBeforeDeparture).not.toBeNull();
    const [fightSet] = await db.insert(fightPositionSets).values({
      guildId,
      name: 'Set 1',
      isActive: true,
    }).returning();
    const [fightPosition] = await db.insert(fightPositions).values({ guildId, name: 'Main Fight' }).returning();
    await db.insert(memberFightPositions).values({
      guildId,
      setId: fightSet!.id,
      memberId: zixxBeforeDeparture!.id,
      positionId: fightPosition!.id,
      assignedByDiscordUserId: admin,
    });

    await service.markFormer(guildId, '700000000000000001', admin, 'ออกจากแก๊ง', roleIds);

    const activeMembers = await service.listActive(guildId);
    const former = await service.findByDiscordUserId(guildId, '700000000000000001');
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(activeMembers.map((member) => member.inGameName)).toEqual(['Nami', 'Miko']);
    expect(former?.rosterTitle).toBeNull();
    expect(await db.select().from(memberFightPositions).where(eq(memberFightPositions.memberId, former!.id))).toHaveLength(0);
    expect(jobs.filter((job) => job.jobType === 'MEMBER_ROSTER_REFRESH')).toHaveLength(refreshJobsBefore + 1);
  });
});
