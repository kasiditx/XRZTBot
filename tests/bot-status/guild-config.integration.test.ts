import { jest } from '@jest/globals';
import type { REST } from 'discord.js';
import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { guildSettings } from '../../src/infrastructure/db/schema.js';
import { publishBotStatus } from '../../src/infrastructure/discord/bot-status-publisher.js';
import { GuildConfigService } from '../../src/modules/guild-config/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('Bot status configuration PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: GuildConfigService;
  const guildId = `bot-status-test-${process.pid}`;

  beforeAll(() => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    ({ db, pool } = createDatabase(testDatabaseUrl));
    service = new GuildConfigService(db);
  });

  beforeEach(async () => {
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
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

  it('publishes updating and operational transitions while mentioning only the member role', async () => {
    await db.update(guildSettings).set({
      botStatusChannelId: 'channel-1',
      headRoleId: 'leader-role-1',
      deputyRoleId: 'deputy-role-1',
      activeMemberRoleId: 'member-role-1',
    }).where(eq(guildSettings.guildId, guildId));
    const post = jest.fn<(route: string, options: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({ id: 'message-1' })
      .mockResolvedValue({ id: 'notification-1' });
    const patch = jest.fn<(route: string, options: unknown) => Promise<unknown>>()
      .mockResolvedValue({ id: 'message-1' });
    const rest = { post, patch } as unknown as REST;

    const updating = await publishBotStatus({
      rest,
      guildConfig: service,
      guildId,
      status: 'UPDATING',
      detail: 'กำลังติดตั้งเวอร์ชันใหม่',
      actorDiscordUserId: null,
      now: new Date('2026-09-14T05:00:00.000Z'),
    });
    expect(updating).toMatchObject({ outcome: 'PUBLISHED', messageId: 'message-1' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[1]).toMatchObject({
      body: {
        content: '<@&leader-role-1> <@&deputy-role-1> <@&member-role-1>',
        allowedMentions: {
          parse: [],
          roles: ['leader-role-1', 'deputy-role-1', 'member-role-1'],
        },
      },
    });

    const operational = await publishBotStatus({
      rest,
      guildConfig: service,
      guildId,
      status: 'OPERATIONAL',
      detail: 'พร้อมใช้งานตามปกติ',
      actorDiscordUserId: null,
      now: new Date('2026-09-14T05:01:00.000Z'),
    });
    expect(operational).toMatchObject({ outcome: 'PUBLISHED', messageId: 'message-1' });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(await service.get(guildId)).toMatchObject({
      botStatus: 'OPERATIONAL',
      botStatusDetail: 'พร้อมใช้งานตามปกติ',
      botStatusMessageId: 'message-1',
      botStatusUpdatedByDiscordUserId: null,
    });

    const unchanged = await publishBotStatus({
      rest,
      guildConfig: service,
      guildId,
      status: 'OPERATIONAL',
      detail: 'ข้อความนี้ต้องไม่ถูกส่ง',
      actorDiscordUserId: null,
      now: new Date('2026-09-14T05:02:00.000Z'),
    });
    expect(unchanged.outcome).toBe('UNCHANGED');
    expect(post).toHaveBeenCalledTimes(3);
    expect(patch).toHaveBeenCalledTimes(1);
  });
});
