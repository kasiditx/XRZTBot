import { and, eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { guildSettings, scheduledJobs } from '../../src/infrastructure/db/schema.js';
import { GuildConfigService } from '../../src/modules/guild-config/service.js';
import { queueCurrentRelease, RELEASE_ANNOUNCEMENT_JOB } from '../../src/modules/releases/service.js';
import type { ReleaseNotes } from '../../src/modules/releases/notes.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('Release announcements PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  const guildId = `release-test-${process.pid}`;
  const release: ReleaseNotes = { id: 'test-1', title: 'ข่าวใหม่', added: ['เพิ่มฟีเจอร์'], improved: [], fixed: [] };
  const jobs = () => db.select().from(scheduledJobs).where(and(
    eq(scheduledJobs.guildId, guildId), eq(scheduledJobs.jobType, RELEASE_ANNOUNCEMENT_JOB),
  ));

  beforeAll(() => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    ({ db, pool } = createDatabase(testDatabaseUrl));
  });
  beforeEach(async () => {
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId, releaseChannelId: '200' });
  });
  afterAll(async () => {
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await pool.end();
  });

  it('queues one immutable job for concurrent startup attempts', async () => {
    await Promise.all(Array.from({ length: 4 }, () => queueCurrentRelease(db, guildId, release)));
    await queueCurrentRelease(db, guildId, { ...release, title: 'edited after enqueue' });
    const result = await jobs();
    expect(result).toHaveLength(1);
    expect(result[0]?.payload).toEqual({ channelId: '200', notes: release });
  });

  it('keeps completed releases completed across restart, rollback and channel changes', async () => {
    await queueCurrentRelease(db, guildId, release);
    await db.update(scheduledJobs).set({ status: 'COMPLETED' }).where(eq(scheduledJobs.guildId, guildId));
    await db.update(guildSettings).set({ releaseChannelId: '201' }).where(eq(guildSettings.guildId, guildId));
    await queueCurrentRelease(db, guildId, { ...release, id: 'test-2' });
    await queueCurrentRelease(db, guildId, release);
    const result = await jobs();
    expect(result).toHaveLength(2);
    expect(result.find((entry) => entry.deduplicationKey === 'release:test-1')?.status).toBe('COMPLETED');
    expect(result.find((entry) => entry.deduplicationKey === 'release:test-2')?.payload.channelId).toBe('201');
  });

  it('does not enqueue without a configured channel or without notes', async () => {
    await queueCurrentRelease(db, guildId, null);
    await db.update(guildSettings).set({ releaseChannelId: null }).where(eq(guildSettings.guildId, guildId));
    await queueCurrentRelease(db, guildId, release);
    expect(await jobs()).toHaveLength(0);
  });

  it('queues the current release when the channel is configured after startup', async () => {
    await db.update(guildSettings).set({ releaseChannelId: null }).where(eq(guildSettings.guildId, guildId));
    const config = new GuildConfigService(db);
    await config.configureChannel(guildId, 'releaseChannelId', '202');
    await config.configureChannel(guildId, 'releaseChannelId', '202');
    const result = await jobs();
    expect(result).toHaveLength(1);
    expect(result[0]?.payload.channelId).toBe('202');
  });

  it('rejects invalid notes before storing a job', async () => {
    await expect(queueCurrentRelease(db, guildId, { ...release, added: [] })).rejects.toThrow();
    expect(await jobs()).toHaveLength(0);
  });
});
