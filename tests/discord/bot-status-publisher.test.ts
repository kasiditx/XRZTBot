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
    botStatusUpdatedByDiscordUserId: null,
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
  return { guildConfig, patch, post, rest, saveBotStatus, settings };
}

describe('bot status publisher', () => {
  it('serializes health and operator publications and rechecks the manual status before writing', async () => {
    const { guildConfig, settings, patch, post, rest } = setup();
    const manualSettings = {
      ...settings, botStatus: 'UPDATING', botStatusUpdatedByDiscordUserId: 'operator',
    } as Awaited<ReturnType<GuildConfigService['get']>>;
    const getSettings = jest.spyOn(guildConfig, 'get').mockResolvedValueOnce(settings as Awaited<ReturnType<GuildConfigService['get']>>)
      .mockResolvedValueOnce(manualSettings);
    let releasePatch: ((message: { id: string }) => void) | undefined;
    patch.mockImplementationOnce(() => new Promise((resolve) => { releasePatch = resolve; }));
    const baseInput = { rest, guildConfig, guildId: 'guild-1', detail: 'ปรับปรุงระบบ', now: new Date() };
    const manual = publishBotStatus({ ...baseInput, status: 'UPDATING', actorDiscordUserId: 'operator' });
    const automatic = publishBotStatus({
      ...baseInput, status: 'OPERATIONAL', actorDiscordUserId: null, automaticHealthCheck: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(getSettings).toHaveBeenCalledTimes(1);
    releasePatch?.({ id: 'message-1' });
    await manual;
    expect(await automatic).toEqual({ outcome: 'SKIPPED', reason: 'MANUAL_STATUS_ACTIVE' });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('releases the per-guild publication lock after a Discord failure', async () => {
    const { guildConfig, patch, rest } = setup();
    patch.mockRejectedValueOnce(new Error('Discord unavailable'));
    const input = { rest, guildConfig, guildId: 'guild-1', status: 'OPERATIONAL' as const,
      detail: 'พร้อมใช้งาน', actorDiscordUserId: null, now: new Date() };
    await expect(publishBotStatus(input)).rejects.toThrow('Discord unavailable');
    await expect(publishBotStatus(input)).resolves.toEqual(expect.objectContaining({ outcome: 'UNCHANGED' }));
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it('updates a changed health panel without mentioning members during a metric refresh', async () => {
    const { guildConfig, patch, post, rest, saveBotStatus } = setup();
    await publishBotStatus({
      rest, guildConfig, guildId: 'guild-1', status: 'OPERATIONAL',
      detail: 'Database: 35 ms', actorDiscordUserId: null, now: new Date(), notify: false,
    });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(saveBotStatus).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

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
