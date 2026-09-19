import { REST } from 'discord.js';
import { loadEnv } from './config/env.js';
import { bootstrap } from './app/bootstrap.js';
import { handleFatalError, normalizeFatalError } from './app/fatal-error-handler.js';
import { createDatabase } from './infrastructure/db/client.js';
import { publishBotStatus } from './infrastructure/discord/bot-status-publisher.js';
import { GuildConfigService } from './modules/guild-config/service.js';

let fatalHandlingStarted = false;
const reportFatalError = (reason: unknown): void => {
  if (fatalHandlingStarted) return;
  fatalHandlingStarted = true;
  void handleFatalError(normalizeFatalError(reason), {
    publishDegradedStatus: publishAutomaticDegradedStatus,
    logFatalError: (error) => console.error('Fatal MiruBot process error', error),
    logStatusFailure: (error) => console.error('Failed to publish degraded MiruBot status', error),
    exit: (code) => process.exit(code),
  });
};

process.once('uncaughtException', reportFatalError);
process.once('unhandledRejection', reportFatalError);

const application = await bootstrap();
let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  try {
    await application.stop();
    process.exitCode = 0;
  } catch (error: unknown) {
    console.error(`Shutdown after ${signal} failed`, error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

async function publishAutomaticDegradedStatus(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = createDatabase(env.DATABASE_URL, (error) => {
    console.error('Unexpected error from the fatal-status PostgreSQL client', error);
  });
  try {
    await publishBotStatus({
      rest: new REST({ version: '10' }).setToken(env.DISCORD_TOKEN),
      guildConfig: new GuildConfigService(db),
      guildId: env.DISCORD_GUILD_ID,
      status: 'DEGRADED',
      detail: 'ระบบตรวจพบข้อผิดพลาดร้ายแรงและกำลังเริ่มการทำงานใหม่โดยอัตโนมัติ',
      actorDiscordUserId: null,
      now: new Date(),
    });
  } finally {
    await pool.end();
  }
}
