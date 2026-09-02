import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { auditLogs, guildSettings, scheduledJobs } from '../../src/infrastructure/db/schema.js';
import { AuditService } from '../../src/modules/audit/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('AuditService PostgreSQL integration', () => {
  const guildId = 'audit-integration-guild';
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: AuditService;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new AuditService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId });
  });

  afterAll(async () => {
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await pool.end();
  });

  it('writes the audit row and queues exactly one durable Discord publish job', async () => {
    await service.record({
      guildId,
      actorDiscordUserId: '123456789012345678',
      action: 'TEST_ACTION',
      entityType: 'TEST_ENTITY',
      entityId: 'entity-1',
      after: { status: 'CREATED' },
    });

    const rows = await db.select().from(auditLogs).where(eq(auditLogs.guildId, guildId));
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));

    expect(rows).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobType).toBe('AUDIT_PUBLISH');
    expect(jobs[0]?.payload).toEqual({ auditId: rows[0]?.id });
  });
});
