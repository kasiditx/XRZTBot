/* global console, process */
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, ne } from 'drizzle-orm';
import { Client, GatewayIntentBits } from 'discord.js';
import { createDatabase } from '../dist/infrastructure/db/client.js';
import {
  finePaymentProofs,
  guildSettings,
  scheduledJobs,
  treasuryEntries,
  treasuryWithdrawalRequests,
  weeklyObligations,
  weeklyPaymentProofs,
} from '../dist/infrastructure/db/schema.js';
import { FineService } from '../dist/modules/fines/service.js';
import { TreasuryWithdrawalService } from '../dist/modules/treasury-withdrawals/service.js';
import { WeeklyDuesService } from '../dist/modules/weekly-dues/service.js';
import { buildFineProofLog } from '../dist/infrastructure/discord/fine-components.js';
import { buildTreasuryWithdrawalRequestLog } from '../dist/infrastructure/discord/treasury-components.js';
import { buildWeeklyProofLog } from '../dist/infrastructure/discord/weekly-dues-components.js';

const databaseUrl = requireEnvironment('DATABASE_URL');
const discordToken = requireEnvironment('DISCORD_TOKEN');
const guildId = requireEnvironment('DISCORD_GUILD_ID');
const { db, pool } = createDatabase(databaseUrl);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

try {
  await client.login(discordToken);
  const [settings] = await db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).limit(1);
  if (settings === undefined) throw new Error('Guild settings are not configured');
  const weeklyLogChannel = await fetchConfiguredChannel(
    settings.weeklyDuesLogChannelId,
    'Weekly dues log channel',
  );
  const fineLogChannel = await fetchConfiguredChannel(settings.fineLogChannelId, 'Fine log channel');
  const withdrawalLogChannel = await fetchConfiguredChannel(
    settings.treasuryWithdrawalLogChannelId,
    'Treasury withdrawal log channel',
  );
  const context = {
    db,
    guildId,
    weeklyLogChannel,
    fineLogChannel,
    withdrawalLogChannel,
    fines: new FineService(db),
    weeklyDues: new WeeklyDuesService(db),
    treasuryWithdrawals: new TreasuryWithdrawalService(db),
  };

  const [weeklyMoved, finesMoved, withdrawalsMoved] = await Promise.all([
    moveWeeklyProofs(context),
    moveFineProofs(context),
    moveTreasuryWithdrawals(context),
  ]);
  const withdrawalMappingsRepaired = await repairDuplicateTreasuryWithdrawalMessages(context);
  await db.insert(scheduledJobs).values({
    guildId,
    jobType: 'TREASURY_REFRESH',
    deduplicationKey: `treasury:${guildId}:finance-log-migration:${randomUUID()}`,
    payload: {},
    runAt: new Date(),
  });
  console.log(JSON.stringify({ weeklyMoved, finesMoved, withdrawalsMoved, withdrawalMappingsRepaired }));
} finally {
  client.destroy();
  await pool.end();
}

async function moveWeeklyProofs(context) {
  const proofs = await context.db
    .select()
    .from(weeklyPaymentProofs)
    .where(and(
      eq(weeklyPaymentProofs.guildId, context.guildId),
      ne(weeklyPaymentProofs.logChannelId, context.weeklyLogChannel.id),
    ))
    .orderBy(asc(weeklyPaymentProofs.createdAt));
  let moved = 0;
  for (const proof of proofs) {
    const view = await context.weeklyDues.getProof(context.guildId, proof.id);
    const relocated = await relocateProofMessage(
      proof.logChannelId,
      proof.logMessageId,
      proof.attachmentId,
      context.weeklyLogChannel,
      buildWeeklyProofLog(view),
      `weekly-${proof.id}`,
    );
    const updated = await context.db.transaction(async (tx) => {
      const rows = await tx
        .update(weeklyPaymentProofs)
        .set({
          attachmentId: relocated.attachmentId,
          logChannelId: context.weeklyLogChannel.id,
          logMessageId: relocated.message.id,
          updatedAt: new Date(),
        })
        .where(and(
          eq(weeklyPaymentProofs.id, proof.id),
          eq(weeklyPaymentProofs.logChannelId, proof.logChannelId),
          eq(weeklyPaymentProofs.logMessageId, proof.logMessageId),
        ))
        .returning({ id: weeklyPaymentProofs.id });
      if (rows.length === 0) return false;
      await tx
        .update(weeklyObligations)
        .set({ attachmentId: relocated.attachmentId, updatedAt: new Date() })
        .where(and(
          eq(weeklyObligations.id, proof.obligationId),
          eq(weeklyObligations.attachmentId, proof.attachmentId),
        ));
      await updateTreasuryEvidence(tx, 'WEEKLY_PAYMENT', proof.id, proof.attachmentId, relocated.attachmentId);
      return true;
    });
    if (!updated) {
      await relocated.message.delete().catch(() => undefined);
      continue;
    }
    await relocated.original.delete().catch(() => undefined);
    moved += 1;
  }
  return moved;
}

async function moveFineProofs(context) {
  const proofs = await context.db
    .select()
    .from(finePaymentProofs)
    .where(and(
      eq(finePaymentProofs.guildId, context.guildId),
      ne(finePaymentProofs.logChannelId, context.fineLogChannel.id),
    ))
    .orderBy(asc(finePaymentProofs.createdAt));
  let moved = 0;
  for (const proof of proofs) {
    const view = await context.fines.getProof(context.guildId, proof.id);
    const relocated = await relocateProofMessage(
      proof.logChannelId,
      proof.logMessageId,
      proof.attachmentId,
      context.fineLogChannel,
      buildFineProofLog(view),
      `fine-${proof.id}`,
    );
    const updated = await context.db.transaction(async (tx) => {
      const rows = await tx
        .update(finePaymentProofs)
        .set({
          attachmentId: relocated.attachmentId,
          logChannelId: context.fineLogChannel.id,
          logMessageId: relocated.message.id,
          updatedAt: new Date(),
        })
        .where(and(
          eq(finePaymentProofs.id, proof.id),
          eq(finePaymentProofs.logChannelId, proof.logChannelId),
          eq(finePaymentProofs.logMessageId, proof.logMessageId),
        ))
        .returning({ id: finePaymentProofs.id });
      if (rows.length === 0) return false;
      await updateTreasuryEvidence(tx, 'FINE_PAYMENT', proof.id, proof.attachmentId, relocated.attachmentId);
      return true;
    });
    if (!updated) {
      await relocated.message.delete().catch(() => undefined);
      continue;
    }
    await relocated.original.delete().catch(() => undefined);
    moved += 1;
  }
  return moved;
}

async function moveTreasuryWithdrawals(context) {
  const requests = await context.db
    .select()
    .from(treasuryWithdrawalRequests)
    .where(and(
      eq(treasuryWithdrawalRequests.guildId, context.guildId),
      ne(treasuryWithdrawalRequests.publicChannelId, context.withdrawalLogChannel.id),
    ))
    .orderBy(asc(treasuryWithdrawalRequests.createdAt));
  let moved = 0;
  for (const request of requests) {
    if (request.publicChannelId === null || request.publicMessageId === null) continue;
    const originalChannel = await fetchSendableChannel(request.publicChannelId);
    const original = await originalChannel.messages.fetch(request.publicMessageId);
    const view = await context.treasuryWithdrawals.get(context.guildId, request.id);
    const message = await context.withdrawalLogChannel.send({
      ...buildTreasuryWithdrawalRequestLog(view),
      nonce: migrationNonce(`withdrawal-${request.id}`),
      enforceNonce: true,
    });
    const rows = await context.db
      .update(treasuryWithdrawalRequests)
      .set({
        publicChannelId: context.withdrawalLogChannel.id,
        publicMessageId: message.id,
        updatedAt: new Date(),
      })
      .where(and(
        eq(treasuryWithdrawalRequests.id, request.id),
        eq(treasuryWithdrawalRequests.publicChannelId, request.publicChannelId),
        eq(treasuryWithdrawalRequests.publicMessageId, request.publicMessageId),
      ))
      .returning({ id: treasuryWithdrawalRequests.id });
    if (rows.length === 0) {
      await message.delete().catch(() => undefined);
      continue;
    }
    await original.delete().catch(() => undefined);
    moved += 1;
  }
  return moved;
}

async function repairDuplicateTreasuryWithdrawalMessages(context) {
  const requests = await context.db
    .select()
    .from(treasuryWithdrawalRequests)
    .where(eq(treasuryWithdrawalRequests.guildId, context.guildId))
    .orderBy(asc(treasuryWithdrawalRequests.createdAt));
  const seenMessageIds = new Set();
  let repaired = 0;
  for (const request of requests) {
    if (request.publicChannelId !== context.withdrawalLogChannel.id || request.publicMessageId === null) continue;
    if (!seenMessageIds.has(request.publicMessageId)) {
      seenMessageIds.add(request.publicMessageId);
      continue;
    }
    const view = await context.treasuryWithdrawals.get(context.guildId, request.id);
    const message = await context.withdrawalLogChannel.send({
      ...buildTreasuryWithdrawalRequestLog(view),
      nonce: migrationNonce(`withdrawal-repair-${request.id}`),
      enforceNonce: true,
    });
    const rows = await context.db
      .update(treasuryWithdrawalRequests)
      .set({ publicMessageId: message.id, updatedAt: new Date() })
      .where(and(
        eq(treasuryWithdrawalRequests.id, request.id),
        eq(treasuryWithdrawalRequests.publicChannelId, request.publicChannelId),
        eq(treasuryWithdrawalRequests.publicMessageId, request.publicMessageId),
      ))
      .returning({ id: treasuryWithdrawalRequests.id });
    if (rows.length === 0) {
      await message.delete().catch(() => undefined);
      continue;
    }
    seenMessageIds.add(message.id);
    repaired += 1;
  }
  return repaired;
}

async function relocateProofMessage(oldChannelId, oldMessageId, oldAttachmentId, targetChannel, payload, nonceSeed) {
  const originalChannel = await fetchSendableChannel(oldChannelId);
  const original = await originalChannel.messages.fetch(oldMessageId);
  const attachment = original.attachments.get(oldAttachmentId);
  if (attachment === undefined) throw new Error(`Missing evidence attachment for message ${oldMessageId}`);
  const message = await targetChannel.send({
    ...payload,
    files: [{ attachment: attachment.url, name: attachment.name ?? `evidence-${oldAttachmentId}` }],
    nonce: migrationNonce(nonceSeed),
    enforceNonce: true,
  });
  const persistedAttachment = [...message.attachments.values()][0];
  if (persistedAttachment === undefined) {
    await message.delete().catch(() => undefined);
    throw new Error(`Discord did not persist migrated evidence for message ${oldMessageId}`);
  }
  return { original, message, attachmentId: persistedAttachment.id };
}

async function updateTreasuryEvidence(tx, sourceType, sourceId, oldAttachmentId, newAttachmentId) {
  await tx
    .update(treasuryEntries)
    .set({ attachmentId: newAttachmentId, updatedAt: new Date() })
    .where(and(
      eq(treasuryEntries.guildId, guildId),
      eq(treasuryEntries.sourceType, sourceType),
      eq(treasuryEntries.sourceId, sourceId),
      eq(treasuryEntries.attachmentId, oldAttachmentId),
    ));
}

async function fetchSendableChannel(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
    throw new Error(`Channel ${channelId} is not sendable`);
  }
  return channel;
}

async function fetchConfiguredChannel(channelId, label) {
  if (channelId === null || channelId === undefined) throw new Error(`${label} is not configured`);
  return fetchSendableChannel(channelId);
}

function migrationNonce(value) {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `finance-move-${digest}`;
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing environment variable ${name}`);
  return value;
}
