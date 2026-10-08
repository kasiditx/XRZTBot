import { jest } from '@jest/globals';
import { REST, type Client } from 'discord.js';
import type pino from 'pino';
import type { GuildSettings } from '../../src/infrastructure/db/schema.js';

const query = jest.fn<() => Promise<{ rows: { healthy: number }[] }>>();
const end = jest.fn<() => Promise<void>>();
const get = jest.fn<() => Promise<GuildSettings | null>>();
const saveBotStatus = jest.fn<() => Promise<void>>();
const createDatabase = jest.fn(() => ({ db: {}, pool: { query, end } }));

jest.unstable_mockModule('../../src/infrastructure/db/client.js', () => ({ createDatabase }));
jest.unstable_mockModule('../../src/modules/guild-config/service.js', () => ({
  GuildConfigService: class {
    public get = get;
    public saveBotStatus = saveBotStatus;
  },
}));

const { createRuntimeHealthMonitor } = await import('../../src/infrastructure/health/runtime-monitor.js');

function settings(overrides: Partial<GuildSettings> = {}): GuildSettings {
  return {
    botStatusChannelId: 'status-channel', botStatusMessageId: 'status-message',
    botStatus: 'OPERATIONAL', botStatusDetail: 'พร้อมใช้งาน', botStatusUpdatedByDiscordUserId: null,
    headRoleId: 'leader', deputyRoleId: 'deputy', activeMemberRoleId: 'member',
    ...overrides,
  } as GuildSettings;
}

describe('runtime health status delivery', () => {
  let runtime: ReturnType<typeof createRuntimeHealthMonitor> | undefined;
  let patch: jest.SpiedFunction<REST['patch']>;
  let post: jest.SpiedFunction<REST['post']>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-08T13:00:00Z'));
    query.mockReset().mockResolvedValue({ rows: [{ healthy: 1 }] });
    end.mockReset().mockResolvedValue();
    get.mockReset().mockResolvedValue(settings());
    saveBotStatus.mockReset().mockResolvedValue();
    createDatabase.mockClear();
    patch = jest.spyOn(REST.prototype, 'patch').mockResolvedValue({ id: 'status-message' });
    post = jest.spyOn(REST.prototype, 'post').mockResolvedValue({ id: 'alert-message' });
  });

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function start(): Promise<void> {
    runtime = createRuntimeHealthMonitor({
      client: { isReady: () => true, ws: { ping: 50 } } as unknown as Client,
      databaseUrl: 'postgres://unused', discordToken: 'test-token', guildId: 'guild-1',
      logger: { warn: jest.fn(), error: jest.fn() } as unknown as pino.Logger,
    });
    await runtime.start();
  }

  it('uses cached channel settings to report database outages without trying to persist them', async () => {
    await start();
    query.mockRejectedValue(new Error('Database unavailable'));
    await jest.advanceTimersByTimeAsync(6 * 60_000);
    expect(get).toHaveBeenCalledTimes(1);
    expect(saveBotStatus).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(patch.mock.calls.at(-1))).toContain('เชื่อมต่อฐานข้อมูลไม่ได้');
    expect(createDatabase).toHaveBeenCalledWith('postgres://unused', expect.any(Function), {
      max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 6_000,
    });
  });

  it.each(['UPDATING', 'DEGRADED'] as const)('preserves %s explicitly set by an operator', async (status) => {
    get.mockResolvedValue(settings({ botStatus: status, botStatusUpdatedByDiscordUserId: 'operator' }));
    await start();
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(saveBotStatus).not.toHaveBeenCalled();
  });

  it('retries an incident alert even if the panel was already updated before Discord rejected the alert', async () => {
    await start();
    query.mockRejectedValue(new Error('Database unavailable'));
    post.mockRejectedValueOnce(new Error('Discord temporarily unavailable'));
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('persists recovery and alerts members once after three healthy checks', async () => {
    await start();
    query.mockRejectedValueOnce(new Error('Database unavailable'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(post).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(saveBotStatus).toHaveBeenLastCalledWith(
      'guild-1', 'OPERATIONAL', expect.any(String), 'status-message', null, expect.any(Date),
    );
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('does not post when the status channel is not configured', async () => {
    get.mockResolvedValue(settings({ botStatusChannelId: null }));
    await start();
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('stops checks and closes its dedicated connection pool', async () => {
    await start();
    await runtime?.stop();
    runtime = undefined;
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(query).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
