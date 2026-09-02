import { once } from 'node:events';
import type { Server } from 'node:http';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadEnv } from '../config/env.js';
import { createDatabase } from '../infrastructure/db/client.js';
import { ActivityInteractionHandler } from '../infrastructure/discord/activity-interaction-handler.js';
import { AttendanceInteractionHandler } from '../infrastructure/discord/attendance-interaction-handler.js';
import { FineInteractionHandler } from '../infrastructure/discord/fine-interaction-handler.js';
import { TreasuryInteractionHandler } from '../infrastructure/discord/treasury-interaction-handler.js';
import { WeeklyDuesInteractionHandler } from '../infrastructure/discord/weekly-dues-interaction-handler.js';
import { StockInteractionHandler } from '../infrastructure/discord/stock-interaction-handler.js';
import { FightPositionInteractionHandler } from '../infrastructure/discord/fight-position-interaction-handler.js';
import { registerGuildCommands } from '../infrastructure/discord/commands.js';
import { DiscordInteractionHandler } from '../infrastructure/discord/interaction-handler.js';
import { createDiscordJobHandlers } from '../infrastructure/discord/job-handlers.js';
import { startHealthServer } from '../infrastructure/health/server.js';
import { createLogger } from '../infrastructure/logger.js';
import { GuildConfigService } from '../modules/guild-config/service.js';
import { ActivityService } from '../modules/activities/service.js';
import { AttendanceService } from '../modules/attendance/service.js';
import { FineService } from '../modules/fines/service.js';
import { TreasuryService } from '../modules/treasury/service.js';
import { TreasuryWithdrawalService } from '../modules/treasury-withdrawals/service.js';
import { WeeklyDuesService } from '../modules/weekly-dues/service.js';
import { InventoryService } from '../modules/inventory/service.js';
import { DepositService } from '../modules/deposits/service.js';
import { WithdrawalService } from '../modules/withdrawals/service.js';
import { MemberService } from '../modules/members/service.js';
import { AuditService } from '../modules/audit/service.js';
import { FightPositionService } from '../modules/fight-positions/service.js';
import { DurableScheduler } from '../modules/scheduler/service.js';

export interface RunningApplication {
  readonly stop: () => Promise<void>;
}

export async function bootstrap(): Promise<RunningApplication> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const { db, pool } = createDatabase(env.DATABASE_URL);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
  const guildConfig = new GuildConfigService(db);
  const memberService = new MemberService(db);
  const activityService = new ActivityService(db);
  const attendanceService = new AttendanceService(db);
  const fineService = new FineService(db);
  const treasuryService = new TreasuryService(db);
  const treasuryWithdrawalService = new TreasuryWithdrawalService(db);
  const weeklyDuesService = new WeeklyDuesService(db);
  const inventoryService = new InventoryService(db);
  const withdrawalService = new WithdrawalService(db);
  const depositService = new DepositService(db);
  const auditService = new AuditService(db);
  const fightPositionService = new FightPositionService(db);
  const checkDatabase = async (): Promise<boolean> => {
    const result = await pool.query<{ healthy: number }>('select 1 as healthy');
    return result.rows[0]?.healthy === 1;
  };

  await guildConfig.ensureGuild(env.DISCORD_GUILD_ID, env.TIMEZONE);
  await registerGuildCommands(env.DISCORD_TOKEN, env.DISCORD_APPLICATION_ID, env.DISCORD_GUILD_ID);

  const activityInteractions = new ActivityInteractionHandler({
    client,
    activities: activityService,
    guildConfig,
    members: memberService,
    logger,
  });
  const attendanceInteractions = new AttendanceInteractionHandler({
    client,
    attendance: attendanceService,
    guildConfig,
    members: memberService,
  });
  const fineInteractions = new FineInteractionHandler({
    client,
    fines: fineService,
    guildConfig,
    members: memberService,
    logger,
  });
  const treasuryInteractions = new TreasuryInteractionHandler({
    client,
    treasury: treasuryService,
    treasuryWithdrawals: treasuryWithdrawalService,
    guildConfig,
    members: memberService,
    logger,
  });
  const weeklyDuesInteractions = new WeeklyDuesInteractionHandler({
    client,
    weeklyDues: weeklyDuesService,
    guildConfig,
    members: memberService,
    logger,
  });
  const stockInteractions = new StockInteractionHandler({
    client,
    inventory: inventoryService,
    withdrawals: withdrawalService,
    deposits: depositService,
    guildConfig,
    members: memberService,
    logger,
  });
  const fightPositionInteractions = new FightPositionInteractionHandler({
    client,
    fightPositions: fightPositionService,
    guildConfig,
    members: memberService,
  });
  const interactionHandler = new DiscordInteractionHandler({
    client,
    guildConfig,
    members: memberService,
    activityInteractions,
    attendanceInteractions,
    fineInteractions,
    treasuryInteractions,
    weeklyDuesInteractions,
    stockInteractions,
    fightPositionInteractions,
    logger,
    checkDatabase,
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void interactionHandler.handle(interaction).catch((error: unknown) => {
      logger.error({ err: error, interactionId: interaction.id }, 'unhandled interaction failure');
    });
  });

  const ready = once(client, Events.ClientReady);
  await client.login(env.DISCORD_TOKEN);
  await ready;
  logger.info({ botUserId: client.user?.id, guildId: env.DISCORD_GUILD_ID }, 'Discord client ready');

  const scheduler = new DurableScheduler(
    db,
    createDiscordJobHandlers(
      client,
      memberService,
      activityService,
      attendanceService,
      fineService,
      treasuryService,
      treasuryWithdrawalService,
      weeklyDuesService,
      inventoryService,
      withdrawalService,
      auditService,
      fightPositionService,
      guildConfig,
      logger,
    ),
    env.DISCORD_GUILD_ID,
    env.SCHEDULER_POLL_MS,
    logger,
  );
  await scheduler.start();

  let healthServer: Server | null = null;
  try {
    healthServer = await startHealthServer(env.HEALTH_PORT, { client, checkDatabase });
    logger.info({ port: env.HEALTH_PORT }, 'health server listening');
  } catch (error: unknown) {
    await scheduler.stop();
    await client.destroy();
    await pool.end();
    throw error;
  }

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      logger.info('shutting down');
      await scheduler.stop();
      await client.destroy();
      await closeServer(healthServer);
      await pool.end();
      logger.info('shutdown complete');
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}
