import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { guildSettings } from '../../src/infrastructure/db/schema.js';
import { GuildConfigService } from '../../src/modules/guild-config/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('Bot status configuration PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: GuildConfigService;
  const guildId = `bot-status-test-${process.pid}`;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    ({ db, pool } = createDatabase(testDatabaseUrl));
    service = new GuildConfigService(db);
    await db.insert(guildSettings).values({ guildId });
  });

  afterAll(async () => {
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await pool.end();
  });

  it('stores the current status and resets the tracked message when its channel changes', async () => {
    const updatedAt = new Date('2026-09-14T05:00:00.000Z');
    await service.configureChannel(guildId, 'botStatusChannelId', 'channel-1');
    await service.saveBotStatus(
      guildId,
      'UPDATING',
      'ปรับปรุงระบบส่งเงินรายสัปดาห์',
      'message-1',
      'admin-1',
      updatedAt,
    );
    expect(await service.get(guildId)).toMatchObject({
      botStatusChannelId: 'channel-1',
      botStatusMessageId: 'message-1',
      botStatus: 'UPDATING',
      botStatusDetail: 'ปรับปรุงระบบส่งเงินรายสัปดาห์',
      botStatusUpdatedAt: updatedAt,
      botStatusUpdatedByDiscordUserId: 'admin-1',
    });

    await service.configureChannel(guildId, 'botStatusChannelId', 'channel-2');
    expect(await service.get(guildId)).toMatchObject({
      botStatusChannelId: 'channel-2',
      botStatusMessageId: null,
      botStatus: 'UPDATING',
    });
  });
});
