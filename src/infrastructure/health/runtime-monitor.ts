import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { REST, type Client } from 'discord.js';
import type pino from 'pino';
import { BotHealthMonitor, type BotHealthUpdate } from '../../modules/bot-health/service.js';
import { GuildConfigService } from '../../modules/guild-config/service.js';
import { createDatabase } from '../db/client.js';
import type { GuildSettings } from '../db/schema.js';
import { publishBotStatus } from '../discord/bot-status-publisher.js';

interface RuntimeHealthMonitorInput {
  readonly client: Client;
  readonly databaseUrl: string;
  readonly discordToken: string;
  readonly guildId: string;
  readonly logger: pino.Logger;
}

export function createRuntimeHealthMonitor(input: RuntimeHealthMonitorInput) {
  // A separate, bounded connection keeps a saturated application pool from blocking health reporting.
  const { db, pool } = createDatabase(input.databaseUrl, (error) => {
    input.logger.error({ err: error }, 'health monitor database client failed');
  }, {
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
  });
  const repository = new GuildConfigService(db);
  const rest = new REST({ version: '10', timeout: 5_000, retries: 0 }).setToken(input.discordToken);
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  let cachedSettings: GuildSettings | null = null;

  async function publish(update: BotHealthUpdate): Promise<boolean> {
    let settings = cachedSettings;
    const result = await publishBotStatus({
      rest,
      guildConfig: {
        get: async () => {
          if (update.databaseAvailable) settings = await repository.get(input.guildId);
          cachedSettings = settings;
          return settings;
        },
        saveBotStatus: async (guildId, status, detail, messageId, actorId, updatedAt) => {
          if (update.databaseAvailable) {
            await repository.saveBotStatus(guildId, status, detail, messageId, actorId, updatedAt);
          }
          if (settings === null) return;
          cachedSettings = {
            ...settings,
            botStatus: status,
            botStatusDetail: detail,
            botStatusMessageId: messageId,
            botStatusUpdatedAt: updatedAt,
            botStatusUpdatedByDiscordUserId: actorId,
          };
        },
      },
      guildId: input.guildId,
      status: update.status,
      detail: update.detail,
      actorDiscordUserId: null,
      now: update.now,
      notify: update.notify,
      announceWhenUnchanged: update.notify,
      automaticHealthCheck: true,
    });
    if (result.outcome === 'SKIPPED') {
      if (result.reason !== 'MANUAL_STATUS_ACTIVE') {
        input.logger.warn({ reason: result.reason }, 'automatic health status not configured');
      }
      return false;
    }
    return true;
  }

  const monitor = new BotHealthMonitor({
    sample: async () => {
      const startedAt = performance.now();
      let databaseMs: number | null = null;
      try {
        await pool.query('select 1 as healthy');
        databaseMs = performance.now() - startedAt;
      } catch (error: unknown) {
        input.logger.warn({ err: error }, 'automatic database health check failed');
      }
      const eventLoopDelayMs = eventLoop.max / 1_000_000;
      eventLoop.reset();
      return {
        databaseMs,
        discordReady: input.client.isReady(),
        discordPingMs: input.client.ws.ping,
        eventLoopDelayMs,
      };
    },
    publish,
    reportFailure: (error) => input.logger.error({ err: error }, 'automatic bot health status failed'),
  });

  return {
    monitor,
    start: async (): Promise<void> => {
      try {
        cachedSettings = await repository.get(input.guildId);
      } catch (error: unknown) {
        input.logger.warn({ err: error }, 'health status channel cache initialization failed');
      }
      eventLoop.enable();
      monitor.start();
    },
    stop: async (): Promise<void> => {
      await monitor.stop();
      eventLoop.disable();
      rest.clearHashSweeper();
      rest.clearHandlerSweeper();
      await pool.end();
    },
  };
}
