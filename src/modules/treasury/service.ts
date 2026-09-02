import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  finePaymentProofs,
  guildSettings,
  scheduledJobs,
  treasuryEntries,
  weeklyPaymentProofs,
} from '../../infrastructure/db/schema.js';
import { writeAudit } from '../audit/service.js';
import { calculateNextBalance } from './rules.js';

export type TreasuryEntry = typeof treasuryEntries.$inferSelect;
export type TreasuryTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface TreasuryDashboard {
  readonly balance: number;
  readonly recentEntries: readonly TreasuryEntry[];
}

export interface TreasuryEvidenceLocation {
  readonly channelId: string;
  readonly messageId: string;
  readonly attachmentId: string;
}

export interface PreparedTreasuryEntry {
  readonly entryId: string;
  readonly guildId: string;
  readonly requestId: string;
  readonly entryType: 'INCOME' | 'EXPENSE';
  readonly amount: number;
  readonly description: string;
  readonly actorDiscordUserId: string;
  readonly estimatedBalanceAfter: number;
}

export interface PersistTreasuryEntryInput {
  readonly prepared: PreparedTreasuryEntry;
  readonly attachmentId: string;
  readonly publicChannelId: string;
  readonly publicMessageId: string;
  readonly now: Date;
}

export interface AppendTreasuryEntryInput {
  readonly id?: string;
  readonly guildId: string;
  readonly entryType: TreasuryEntry['entryType'];
  readonly amount: number;
  readonly description: string;
  readonly attachmentId?: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reversalOfEntryId?: string;
  readonly createdByDiscordUserId: string;
  readonly publicChannelId?: string;
  readonly publicMessageId?: string;
  readonly now: Date;
}

export class TreasuryService {
  public constructor(private readonly db: Database) {}

  public async getDashboard(guildId: string, limit = 10): Promise<TreasuryDashboard> {
    const [balance, recentEntries] = await Promise.all([
      getCurrentBalance(this.db, guildId),
      this.db
        .select()
        .from(treasuryEntries)
        .where(eq(treasuryEntries.guildId, guildId))
        .orderBy(desc(treasuryEntries.createdAt), desc(treasuryEntries.id))
        .limit(limit),
    ]);
    return { balance, recentEntries };
  }

  public async getEntry(guildId: string, entryId: string): Promise<TreasuryEntry> {
    const [entry] = await this.db
      .select()
      .from(treasuryEntries)
      .where(and(eq(treasuryEntries.guildId, guildId), eq(treasuryEntries.id, entryId)))
      .limit(1);
    if (entry === undefined) throw new NotFoundError('ไม่พบรายการเงินกองกลาง');
    return entry;
  }

  public async getEvidenceLocation(entry: TreasuryEntry): Promise<TreasuryEvidenceLocation | null> {
    if (entry.sourceId === null) return null;
    if (entry.sourceType === 'FINE_PAYMENT') {
      const [proof] = await this.db
        .select({
          channelId: finePaymentProofs.logChannelId,
          messageId: finePaymentProofs.logMessageId,
          attachmentId: finePaymentProofs.attachmentId,
        })
        .from(finePaymentProofs)
        .where(eq(finePaymentProofs.id, entry.sourceId))
        .limit(1);
      return proof ?? null;
    }
    if (entry.sourceType === 'WEEKLY_PAYMENT') {
      const [proof] = await this.db
        .select({
          channelId: weeklyPaymentProofs.logChannelId,
          messageId: weeklyPaymentProofs.logMessageId,
          attachmentId: weeklyPaymentProofs.attachmentId,
        })
        .from(weeklyPaymentProofs)
        .where(eq(weeklyPaymentProofs.id, entry.sourceId))
        .limit(1);
      return proof ?? null;
    }
    return null;
  }

  /** Estimates a manual entry before Discord durably re-uploads its evidence image. */
  public async prepareManualEntry(
    guildId: string,
    requestId: string,
    entryType: 'INCOME' | 'EXPENSE',
    amount: number,
    description: string,
    actorDiscordUserId: string,
  ): Promise<PreparedTreasuryEntry> {
    validatePositiveAmount(amount);
    const normalizedDescription = requireText(description, 'รายละเอียด', 2, 500);
    return this.db.transaction(async (tx) => {
      await lockTreasuryGuild(tx, guildId);
      const sourceType = manualSourceType(entryType);
      const [existing] = await tx
        .select()
        .from(treasuryEntries)
        .where(and(
          eq(treasuryEntries.guildId, guildId),
          eq(treasuryEntries.sourceType, sourceType),
          eq(treasuryEntries.sourceId, requestId),
        ))
        .limit(1);
      if (existing !== undefined) throw new ConflictError('รายการนี้ถูกบันทึกแล้ว');
      const balance = await getCurrentBalance(tx, guildId);
      const amountChange = entryType === 'INCOME' ? amount : -amount;
      return {
        entryId: randomUUID(),
        guildId,
        requestId,
        entryType,
        amount,
        description: normalizedDescription,
        actorDiscordUserId,
        estimatedBalanceAfter: calculateNextBalance(balance, amountChange),
      };
    });
  }

  public async persistManualEntry(input: PersistTreasuryEntryInput): Promise<TreasuryEntry> {
    return this.db.transaction(async (tx) => appendTreasuryEntryWithTransaction(tx, {
      id: input.prepared.entryId,
      guildId: input.prepared.guildId,
      entryType: input.prepared.entryType,
      amount: input.prepared.entryType === 'INCOME' ? input.prepared.amount : -input.prepared.amount,
      description: input.prepared.description,
      attachmentId: input.attachmentId,
      sourceType: manualSourceType(input.prepared.entryType),
      sourceId: input.prepared.requestId,
      createdByDiscordUserId: input.prepared.actorDiscordUserId,
      publicChannelId: input.publicChannelId,
      publicMessageId: input.publicMessageId,
      now: input.now,
    }));
  }

  public async createOpeningBalance(
    guildId: string,
    requestId: string,
    amount: number,
    actorDiscordUserId: string,
    now: Date,
  ): Promise<TreasuryEntry> {
    validatePositiveAmount(amount);
    return this.db.transaction(async (tx) => {
      await lockTreasuryGuild(tx, guildId);
      const [existingRequest] = await tx
        .select()
        .from(treasuryEntries)
        .where(and(
          eq(treasuryEntries.guildId, guildId),
          eq(treasuryEntries.sourceType, 'OPENING_BALANCE'),
          eq(treasuryEntries.sourceId, requestId),
        ))
        .limit(1);
      if (existingRequest !== undefined) return existingRequest;
      const [existingEntry] = await tx
        .select({ id: treasuryEntries.id })
        .from(treasuryEntries)
        .where(eq(treasuryEntries.guildId, guildId))
        .limit(1);
      if (existingEntry !== undefined) {
        throw new ConflictError('ตั้งยอดเริ่มต้นได้ก่อนมีรายการเงินกองกลางรายการแรกเท่านั้น');
      }
      return appendTreasuryEntryLocked(tx, {
        guildId,
        entryType: 'OPENING_BALANCE',
        amount,
        description: 'ยอดตั้งต้นเงินกองกลาง',
        sourceType: 'OPENING_BALANCE',
        sourceId: requestId,
        createdByDiscordUserId: actorDiscordUserId,
        now,
      });
    });
  }

  public async reverseEntry(
    guildId: string,
    requestId: string,
    targetEntryId: string,
    reason: string,
    actorDiscordUserId: string,
    now: Date,
  ): Promise<TreasuryEntry> {
    const normalizedReason = requireText(reason, 'เหตุผลย้อนรายการ', 2, 500);
    return this.db.transaction(async (tx) => {
      await lockTreasuryGuild(tx, guildId);
      const [target] = await tx
        .select()
        .from(treasuryEntries)
        .where(and(eq(treasuryEntries.guildId, guildId), eq(treasuryEntries.id, targetEntryId)))
        .limit(1)
        .for('update');
      if (target === undefined) throw new NotFoundError('ไม่พบรายการที่ต้องการย้อน');
      if (target.entryType === 'REVERSAL') throw new ConflictError('ไม่สามารถย้อนรายการย้อนกลับได้');
      if (
        target.sourceType === 'FINE_PAYMENT'
        || target.sourceType === 'WEEKLY_PAYMENT'
        || target.sourceType === 'TREASURY_WITHDRAWAL_REQUEST'
      ) {
        throw new ConflictError('รายการที่เชื่อมกับระบบต้นทางต้องแก้ผ่านระบบนั้นเพื่อรักษาสถานะให้ตรงกัน');
      }
      const [existingReversal] = await tx
        .select()
        .from(treasuryEntries)
        .where(eq(treasuryEntries.reversalOfEntryId, target.id))
        .limit(1);
      if (existingReversal !== undefined) return existingReversal;
      return appendTreasuryEntryLocked(tx, {
        guildId,
        entryType: 'REVERSAL',
        amount: -target.amount,
        description: `ย้อนรายการ: ${normalizedReason}`,
        sourceType: 'TREASURY_REVERSAL',
        sourceId: requestId,
        reversalOfEntryId: target.id,
        createdByDiscordUserId: actorDiscordUserId,
        now,
      });
    });
  }

  public async markPublished(guildId: string, entryId: string, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(treasuryEntries)
      .set({ publicChannelId: channelId, publicMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(treasuryEntries.guildId, guildId), eq(treasuryEntries.id, entryId)));
  }
}

/** Appends one idempotent ledger entry while serializing all writes for the guild. */
export async function appendTreasuryEntryWithTransaction(
  tx: TreasuryTransaction,
  input: AppendTreasuryEntryInput,
): Promise<TreasuryEntry> {
  await lockTreasuryGuild(tx, input.guildId);
  return appendTreasuryEntryLocked(tx, input);
}

async function appendTreasuryEntryLocked(
  tx: TreasuryTransaction,
  input: AppendTreasuryEntryInput,
): Promise<TreasuryEntry> {
  const [existing] = await tx
    .select()
    .from(treasuryEntries)
    .where(and(
      eq(treasuryEntries.guildId, input.guildId),
      eq(treasuryEntries.sourceType, input.sourceType),
      eq(treasuryEntries.sourceId, input.sourceId),
    ))
    .limit(1);
  if (existing !== undefined) return existing;

  const description = requireText(input.description, 'รายละเอียด', 2, 500);
  if (!Number.isSafeInteger(input.amount) || input.amount === 0) {
    throw new ValidationError('จำนวนเงินต้องเป็นจำนวนเต็มและห้ามเป็นศูนย์');
  }
  const balance = await getCurrentBalance(tx, input.guildId);
  const balanceAfter = calculateNextBalance(balance, input.amount);
  const [entry] = await tx
    .insert(treasuryEntries)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      guildId: input.guildId,
      entryType: input.entryType,
      amount: input.amount,
      balanceAfter,
      description,
      ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      ...(input.reversalOfEntryId === undefined ? {} : { reversalOfEntryId: input.reversalOfEntryId }),
      createdByDiscordUserId: input.createdByDiscordUserId,
      ...(input.publicChannelId === undefined ? {} : { publicChannelId: input.publicChannelId }),
      ...(input.publicMessageId === undefined ? {} : { publicMessageId: input.publicMessageId }),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (entry === undefined) throw new Error('Treasury entry creation did not return a row');

  if (entry.publicMessageId === null) await queueTreasuryPublish(tx, entry.guildId, entry.id, input.now);
  await queueTreasuryRefresh(tx, entry.guildId, input.now);
  await writeAudit(tx, {
    guildId: entry.guildId,
    actorDiscordUserId: input.createdByDiscordUserId,
    action: 'TREASURY_ENTRY_CREATED',
    entityType: 'TREASURY_ENTRY',
    entityId: entry.id,
    after: entry,
    ...(input.reversalOfEntryId === undefined ? {} : { reason: description }),
  });
  return entry;
}

async function lockTreasuryGuild(tx: TreasuryTransaction, guildId: string): Promise<void> {
  const [guild] = await tx
    .select({ guildId: guildSettings.guildId })
    .from(guildSettings)
    .where(eq(guildSettings.guildId, guildId))
    .limit(1)
    .for('update');
  if (guild === undefined) throw new NotFoundError('ไม่พบการตั้งค่า Server');
}

async function getCurrentBalance(
  source: Pick<Database, 'select'> | TreasuryTransaction,
  guildId: string,
): Promise<number> {
  const [row] = await source
    .select({ balance: sql<number>`coalesce(sum(${treasuryEntries.amount}), 0)`.mapWith(Number) })
    .from(treasuryEntries)
    .where(eq(treasuryEntries.guildId, guildId));
  return row?.balance ?? 0;
}

function manualSourceType(entryType: 'INCOME' | 'EXPENSE'): string {
  return entryType === 'INCOME' ? 'MANUAL_INCOME' : 'MANUAL_EXPENSE';
}

function validatePositiveAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError('จำนวนเงินต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
  }
}

function requireText(value: string, label: string, minimum: number, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ValidationError(`${label}ต้องมี ${String(minimum)}–${String(maximum)} ตัวอักษร`);
  }
  return normalized;
}

async function queueTreasuryPublish(tx: TreasuryTransaction, guildId: string, entryId: string, runAt: Date): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'TREASURY_PUBLISH',
    deduplicationKey: `treasury:${entryId}:publish`,
    payload: { entryId },
    runAt,
  }).onConflictDoNothing();
}

async function queueTreasuryRefresh(tx: TreasuryTransaction, guildId: string, runAt: Date): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'TREASURY_REFRESH',
    deduplicationKey: `treasury:${guildId}:refresh:${randomUUID()}`,
    payload: {},
    runAt,
  });
}
