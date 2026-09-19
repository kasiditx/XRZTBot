/* global console, process */
import 'dotenv/config';
import { REST } from 'discord.js';
import { createDatabase } from '../dist/infrastructure/db/client.js';
import { publishBotStatus } from '../dist/infrastructure/discord/bot-status-publisher.js';
import { GuildConfigService } from '../dist/modules/guild-config/service.js';

const databaseUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const guildId = process.env.DISCORD_GUILD_ID;
const token = process.env.DISCORD_TOKEN;

if (databaseUrl === undefined || guildId === undefined || token === undefined) {
  console.error('Automatic pre-start status skipped: DATABASE_URL, DISCORD_GUILD_ID or DISCORD_TOKEN is missing');
} else {
  const { db, pool } = createDatabase(databaseUrl);
  try {
    const result = await publishBotStatus({
      rest: new REST({ version: '10' }).setToken(token),
      guildConfig: new GuildConfigService(db),
      guildId,
      status: 'UPDATING',
      detail: 'กำลังติดตั้งเวอร์ชันใหม่ กรุณางดใช้งานชั่วคราว',
      actorDiscordUserId: null,
      now: new Date(),
      announceWhenUnchanged: true,
    });
    console.log(`Automatic pre-start status: ${result.outcome}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`Automatic pre-start status failed: ${message}`);
  } finally {
    await pool.end();
  }
}
