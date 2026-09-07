/* global console, process */
import 'dotenv/config';
import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import { REST, Routes } from 'discord.js';
import { createDatabase } from '../dist/infrastructure/db/client.js';
import { activitySubmissions, depositRequests, finePaymentProofs, fines, guildSettings, leaves, treasuryWithdrawalRequests, weeklyCollections, weeklyPaymentProofs, withdrawalRequests } from '../dist/infrastructure/db/schema.js';
import { ActivityService } from '../dist/modules/activities/service.js';
import { AttendanceService } from '../dist/modules/attendance/service.js';
import { DepositService } from '../dist/modules/deposits/service.js';
import { FineService } from '../dist/modules/fines/service.js';
import { TreasuryWithdrawalService } from '../dist/modules/treasury-withdrawals/service.js';
import { WeeklyDuesService } from '../dist/modules/weekly-dues/service.js';
import { WithdrawalService } from '../dist/modules/withdrawals/service.js';
import { buildSubmissionLog } from '../dist/infrastructure/discord/activity-components.js';
import { buildLeaveLog } from '../dist/infrastructure/discord/attendance-components.js';
import { buildFineAnnouncement, buildFineProofLog } from '../dist/infrastructure/discord/fine-components.js';
import { buildDepositLog, buildWithdrawalLog } from '../dist/infrastructure/discord/stock-components.js';
import { buildTreasuryWithdrawalRequestLog } from '../dist/infrastructure/discord/treasury-components.js';
import { buildWeeklyAnnouncement, buildWeeklyProofLog } from '../dist/infrastructure/discord/weekly-dues-components.js';

// Run only after deploying the matching handlers. Default is a read-only inventory.
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some((arg) => arg !== '--apply')) throw new Error('Supported option: --apply');
const guildId = required('DISCORD_GUILD_ID');
const { db, pool } = createDatabase(process.env.DATABASE_URL_UNPOOLED ?? required('DATABASE_URL'));
const rest = apply ? new REST({ version: '10' }).setToken(required('DISCORD_TOKEN')) : null;
const activities = new ActivityService(db);
const attendance = new AttendanceService(db);
const deposits = new DepositService(db);
const fineService = new FineService(db);
const treasury = new TreasuryWithdrawalService(db);
const weekly = new WeeklyDuesService(db);
const withdrawals = new WithdrawalService(db);
const targets = [
  ['activity', activitySubmissions, 'logChannelId', 'logMessageId', (id) => activities.getSubmission(guildId, id), buildSubmissionLog],
  ['leave', leaves, 'publicChannelId', 'publicMessageId', (id) => attendance.getLeave(guildId, id), buildLeaveLog],
  ['fine', fines, 'publicChannelId', 'publicMessageId', (id) => fineService.get(guildId, id), buildFineAnnouncement],
  ['fine-proof', finePaymentProofs, 'logChannelId', 'logMessageId', (id) => fineService.getProof(guildId, id), buildFineProofLog],
  ['weekly-collection', weeklyCollections, 'publicChannelId', 'publicMessageId', (id) => weekly.get(guildId, id), buildWeeklyAnnouncement],
  ['weekly-proof', weeklyPaymentProofs, 'logChannelId', 'logMessageId', (id) => weekly.getProof(guildId, id), buildWeeklyProofLog],
  ['treasury-withdrawal', treasuryWithdrawalRequests, 'publicChannelId', 'publicMessageId', (id) => treasury.get(guildId, id), buildTreasuryWithdrawalRequestLog],
  ['withdrawal', withdrawalRequests, 'publicChannelId', 'publicMessageId', (id) => withdrawals.get(guildId, id), buildWithdrawalLog],
  ['deposit', depositRequests, 'publicChannelId', 'publicMessageId', (id) => deposits.get(guildId, id), buildDepositLog],
];
const verifiedChannels = new Set();
try {
  const [settings] = await db.select({ guildId: guildSettings.guildId }).from(guildSettings).where(eq(guildSettings.guildId, guildId));
  if (settings === undefined) throw new Error('Guild is not configured');
  const bot = rest === null ? null : await rest.get(Routes.user('@me'));
  for (const [name, table, channelKey, messageKey, getView, build] of targets) {
    let cursor;
    let count = 0;
    let missing = 0;
    while (true) {
      const rows = await db.select({ id: table.id, channelId: table[channelKey], messageId: table[messageKey] })
        .from(table).where(and(eq(table.guildId, guildId), isNotNull(table[channelKey]), isNotNull(table[messageKey]), cursor === undefined ? undefined : gt(table.id, cursor)))
        .orderBy(asc(table.id)).limit(100);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (rest !== null) {
          if (!verifiedChannels.has(row.channelId)) {
            const channel = await rest.get(Routes.channel(row.channelId));
            if (channel.guild_id !== guildId) throw new Error('Stored channel belongs to another guild');
            verifiedChannels.add(row.channelId);
          }
          try {
            const route = Routes.channelMessage(row.channelId, row.messageId);
            const message = await rest.get(route);
            if (message.author.id !== bot.id) throw new Error('Stored message is not owned by this bot');
            const payload = build(await getView(row.id));
            // Edit UI only: preserve uploaded evidence, content, and message location.
            await rest.patch(route, { body: {
              embeds: payload.embeds.map((embed) => embed.toJSON()),
              components: payload.components.map((component) => component.toJSON()),
              allowed_mentions: { parse: [] },
            } });
          } catch (error) {
            if (error?.code !== 10008) throw error;
            missing += 1;
            continue;
          }
        }
        count += 1;
      }
      cursor = rows.at(-1).id;
    }
    console.log(`${name}: ${String(count)} ${apply ? 'refreshed' : 'eligible'}, ${String(missing)} deleted messages skipped`);
  }
} finally {
  await pool.end();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
