import { jest } from '@jest/globals';
import type { REST } from 'discord.js';
import { publishBotStatus } from '../../src/infrastructure/discord/bot-status-publisher.js';
import type { GuildConfigService } from '../../src/modules/guild-config/service.js';

function setup() {
  const settings = {
    botStatusChannelId: 'channel-1',
    botStatusMessageId: 'message-1',
    botStatus: 'OPERATIONAL' as const,
    botStatusDetail: 'พร้อมใช้งาน',
    headRoleId: 'leader-role',
    deputyRoleId: 'deputy-role',
    activeMemberRoleId: 'member-role',
  };
  const saveBotStatus = jest.fn<() => Promise<void>>().mockResolvedValue();
  const guildConfig = {
    get: jest.fn<() => Promise<typeof settings>>().mockResolvedValue(settings),
    saveBotStatus,
  } as unknown as GuildConfigService;
  const patch = jest.fn<() => Promise<unknown>>().mockResolvedValue({ id: 'message-1' });
  const post = jest.fn<() => Promise<unknown>>().mockResolvedValue({ id: 'alert-1' });
  const rest = { patch, post } as unknown as REST;
  return { guildConfig, patch, post, rest, saveBotStatus };
}

describe('bot status publisher', () => {
  it('refreshes the tracked panel without alerting members when the status and detail are unchanged', async () => {
    const { guildConfig, patch, post, rest, saveBotStatus } = setup();

    const result = await publishBotStatus({
      rest,
      guildConfig,
      guildId: 'guild-1',
      status: 'OPERATIONAL',
      detail: 'พร้อมใช้งาน',
      actorDiscordUserId: null,
      now: new Date('2026-09-19T15:00:00.000Z'),
    });

    expect(result.outcome).toBe('UNCHANGED');
    expect(patch).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(saveBotStatus).toHaveBeenCalledTimes(1);
  });

  it('alerts members after a successful startup even when the status is unchanged', async () => {
    const { guildConfig, patch, post, rest } = setup();

    const result = await publishBotStatus({
      rest,
      guildConfig,
      guildId: 'guild-1',
      status: 'OPERATIONAL',
      detail: 'พร้อมใช้งาน',
      actorDiscordUserId: null,
      now: new Date('2026-09-19T15:00:00.000Z'),
      announceWhenUnchanged: true,
    });

    expect(result.outcome).toBe('PUBLISHED');
    expect(patch).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('alerts members when the detail changes under the same operational status', async () => {
    const { guildConfig, post, rest } = setup();

    const result = await publishBotStatus({
      rest,
      guildConfig,
      guildId: 'guild-1',
      status: 'OPERATIONAL',
      detail: 'กู้คืนฐานข้อมูลเสร็จแล้ว',
      actorDiscordUserId: null,
      now: new Date('2026-09-19T15:00:00.000Z'),
    });

    expect(result.outcome).toBe('PUBLISHED');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
