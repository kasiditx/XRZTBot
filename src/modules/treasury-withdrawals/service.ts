import { and, eq } from 'drizzle-orm';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  members,
  scheduledJobs,
  treasuryWithdrawalRequests,
} from '../../infrastructure/db/schema.js';
import { writeAudit } from '../audit/service.js';
import {
  appendTreasuryEntryWithTransaction,
  type TreasuryTransaction,
} from '../treasury/service.js';

export type TreasuryWithdrawalRequest = typeof treasuryWithdrawalRequests.$inferSelect;

export interface TreasuryWithdrawalRequestView {
  readonly request: TreasuryWithdrawalRequest;
  readonly requester: {
    readonly discordUserId: string;
    readonly inGameName: string;
  };
}

export interface CreateTreasuryWithdrawalInput {
  readonly guildId: string;
  readonly clientRequestId: string;
  readonly requesterDiscordUserId: string;
  readonly amount: number;
  readonly reason: string;
  readonly now: Date;
}

export class TreasuryWithdrawalService {
  public constructor(private readonly db: Database) {}

  public async create(input: CreateTreasuryWithdrawalInput): Promise<TreasuryWithdrawalRequestView> {
    validatePositiveAmount(input.amount);
    const reason = requireText(input.reason, 'วัตถุประสงค์การเบิก', 2, 500);
    const requestId = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(treasuryWithdrawalRequests)
        .where(and(
          eq(treasuryWithdrawalRequests.guildId, input.guildId),
          eq(treasuryWithdrawalRequests.clientRequestId, input.clientRequestId),
        ))
        .limit(1);
      if (existing !== undefined) return existing.id;

      const [member] = await tx
        .select()
        .from(members)
        .where(and(
          eq(members.guildId, input.guildId),
          eq(members.discordUserId, input.requesterDiscordUserId),
          eq(members.status, 'ACTIVE'),
        ))
        .limit(1);
      if (member === undefined) {
        throw new AuthorizationError('ต้องเป็นสมาชิกสถานะใช้งานจึงขอเบิกเงินได้');
      }

      const [request] = await tx
        .insert(treasuryWithdrawalRequests)
        .values({
          guildId: input.guildId,
          clientRequestId: input.clientRequestId,
          requesterMemberId: member.id,
          amount: input.amount,
          reason,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (request === undefined) throw new Error('Treasury withdrawal request creation did not return a row');

      await queueRequestJob(tx, input.guildId, 'TREASURY_WITHDRAWAL_PUBLISH', request.id, input.now, 'publish');
      await writeAudit(tx, {
        guildId: input.guildId,
        actorDiscordUserId: input.requesterDiscordUserId,
        action: 'TREASURY_WITHDRAWAL_REQUESTED',
        entityType: 'TREASURY_WITHDRAWAL_REQUEST',
        entityId: request.id,
        after: request,
      });
      return request.id;
    });
    return this.get(input.guildId, requestId);
  }

  public async get(guildId: string, requestId: string): Promise<TreasuryWithdrawalRequestView> {
    const [row] = await this.db
      .select({ request: treasuryWithdrawalRequests, member: members })
      .from(treasuryWithdrawalRequests)
      .innerJoin(members, eq(treasuryWithdrawalRequests.requesterMemberId, members.id))
      .where(and(
        eq(treasuryWithdrawalRequests.guildId, guildId),
        eq(treasuryWithdrawalRequests.id, requestId),
      ))
      .limit(1);
    if (row === undefined) throw new NotFoundError('ไม่พบคำขอเบิกเงินแก๊ง');
    return {
      request: row.request,
      requester: {
        discordUserId: row.member.discordUserId,
        inGameName: row.member.inGameName,
      },
    };
  }

  public async approve(
    guildId: string,
    requestId: string,
    actorDiscordUserId: string,
    now: Date,
  ): Promise<TreasuryWithdrawalRequestView> {
    await this.db.transaction(async (tx) => {
      const request = await lockRequest(tx, guildId, requestId);
      if (request.status === 'APPROVED') return;
      requirePending(request);

      const entry = await appendTreasuryEntryWithTransaction(tx, {
        guildId,
        entryType: 'EXPENSE',
        amount: -request.amount,
        description: `เบิกเงินแก๊ง: ${request.reason}`,
        sourceType: 'TREASURY_WITHDRAWAL_REQUEST',
        sourceId: request.id,
        createdByDiscordUserId: actorDiscordUserId,
        now,
      });
      const [updated] = await tx
        .update(treasuryWithdrawalRequests)
        .set({
          status: 'APPROVED',
          treasuryEntryId: entry.id,
          decidedAt: now,
          decidedByDiscordUserId: actorDiscordUserId,
          updatedAt: now,
        })
        .where(eq(treasuryWithdrawalRequests.id, request.id))
        .returning();
      if (updated === undefined) throw new Error('Treasury withdrawal approval did not return a row');

      await queueRequestJob(tx, guildId, 'TREASURY_WITHDRAWAL_REFRESH', request.id, now, 'approve');
      await writeAudit(tx, {
        guildId,
        actorDiscordUserId,
        action: 'TREASURY_WITHDRAWAL_APPROVED',
        entityType: 'TREASURY_WITHDRAWAL_REQUEST',
        entityId: request.id,
        before: request,
        after: updated,
      });
    });
    return this.get(guildId, requestId);
  }

  public async reject(
    guildId: string,
    requestId: string,
    actorDiscordUserId: string,
    reason: string,
    now: Date,
  ): Promise<TreasuryWithdrawalRequestView> {
    const rejectionReason = requireText(reason, 'เหตุผลปฏิเสธ', 2, 500);
    await this.db.transaction(async (tx) => {
      const request = await lockRequest(tx, guildId, requestId);
      requirePending(request);
      const [updated] = await tx
        .update(treasuryWithdrawalRequests)
        .set({
          status: 'REJECTED',
          decidedAt: now,
          decidedByDiscordUserId: actorDiscordUserId,
          rejectionReason,
          updatedAt: now,
        })
        .where(eq(treasuryWithdrawalRequests.id, request.id))
        .returning();
      if (updated === undefined) throw new Error('Treasury withdrawal rejection did not return a row');

      await queueRequestJob(tx, guildId, 'TREASURY_WITHDRAWAL_REFRESH', request.id, now, 'reject');
      await writeAudit(tx, {
        guildId,
        actorDiscordUserId,
        action: 'TREASURY_WITHDRAWAL_REJECTED',
        entityType: 'TREASURY_WITHDRAWAL_REQUEST',
        entityId: request.id,
        before: request,
        after: updated,
        reason: rejectionReason,
      });
    });
    return this.get(guildId, requestId);
  }

  public async cancel(
    guildId: string,
    requestId: string,
    actorDiscordUserId: string,
    now: Date,
  ): Promise<TreasuryWithdrawalRequestView> {
    await this.db.transaction(async (tx) => {
      const request = await lockRequest(tx, guildId, requestId);
      requirePending(request);
      const [requester] = await tx
        .select({ discordUserId: members.discordUserId })
        .from(members)
        .where(eq(members.id, request.requesterMemberId))
        .limit(1);
      if (requester?.discordUserId !== actorDiscordUserId) {
        throw new AuthorizationError('ยกเลิกได้เฉพาะผู้ส่งคำขอ');
      }
      const [updated] = await tx
        .update(treasuryWithdrawalRequests)
        .set({ status: 'CANCELLED', updatedAt: now })
        .where(eq(treasuryWithdrawalRequests.id, request.id))
        .returning();
      if (updated === undefined) throw new Error('Treasury withdrawal cancellation did not return a row');

      await queueRequestJob(tx, guildId, 'TREASURY_WITHDRAWAL_REFRESH', request.id, now, 'cancel');
      await writeAudit(tx, {
        guildId,
        actorDiscordUserId,
        action: 'TREASURY_WITHDRAWAL_CANCELLED',
        entityType: 'TREASURY_WITHDRAWAL_REQUEST',
        entityId: request.id,
        before: request,
        after: updated,
      });
    });
    return this.get(guildId, requestId);
  }

  public async markPublished(guildId: string, requestId: string, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(treasuryWithdrawalRequests)
      .set({ publicChannelId: channelId, publicMessageId: messageId, updatedAt: new Date() })
      .where(and(
        eq(treasuryWithdrawalRequests.guildId, guildId),
        eq(treasuryWithdrawalRequests.id, requestId),
      ));
  }
}

async function lockRequest(
  tx: TreasuryTransaction,
  guildId: string,
  requestId: string,
): Promise<TreasuryWithdrawalRequest> {
  const [request] = await tx
    .select()
    .from(treasuryWithdrawalRequests)
    .where(and(
      eq(treasuryWithdrawalRequests.guildId, guildId),
      eq(treasuryWithdrawalRequests.id, requestId),
    ))
    .limit(1)
    .for('update');
  if (request === undefined) throw new NotFoundError('ไม่พบคำขอเบิกเงินแก๊ง');
  return request;
}

function requirePending(request: TreasuryWithdrawalRequest): void {
  if (request.status !== 'PENDING') {
    throw new ConflictError('คำขอนี้ถูกดำเนินการแล้ว');
  }
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

async function queueRequestJob(
  tx: TreasuryTransaction,
  guildId: string,
  jobType: string,
  requestId: string,
  runAt: Date,
  action: string,
): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType,
    deduplicationKey: `treasury-withdrawal:${requestId}:${action}`,
    payload: { requestId },
    runAt,
  }).onConflictDoNothing();
}
