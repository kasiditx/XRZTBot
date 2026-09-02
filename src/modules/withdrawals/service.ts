import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  inventoryBatches,
  inventoryItems,
  members,
  scheduledJobs,
  withdrawalFulfillments,
  withdrawalRequestItems,
  withdrawalRequests,
} from '../../infrastructure/db/schema.js';
import {
  applyInventoryDeltasWithTransaction,
  lockInventoryGuild,
  queueStockBatchPublish,
  queueStockRefresh,
  writeInventoryAudit,
  type InventoryItem,
  type InventoryTransaction,
} from '../inventory/service.js';
import { requirePartialFulfillmentReason, type InventoryQuantityInput } from '../inventory/rules.js';

export type WithdrawalRequest = typeof withdrawalRequests.$inferSelect;
export type WithdrawalFulfillment = typeof withdrawalFulfillments.$inferSelect;

export interface WithdrawalItemView {
  readonly item: InventoryItem;
  readonly requestedQuantity: number;
  readonly fulfilledQuantity: number;
}

export interface WithdrawalRequestView {
  readonly request: WithdrawalRequest;
  readonly requester: {
    readonly discordUserId: string;
    readonly inGameName: string;
  };
  readonly items: readonly WithdrawalItemView[];
  readonly fulfillments: readonly WithdrawalFulfillment[];
}

export interface CreateWithdrawalInput {
  readonly guildId: string;
  readonly clientRequestId: string;
  readonly requesterDiscordUserId: string;
  readonly reason: string;
  readonly items: readonly InventoryQuantityInput[];
  readonly now: Date;
}

export interface FulfillWithdrawalInput {
  readonly guildId: string;
  readonly clientRequestId: string;
  readonly withdrawalRequestId: string;
  readonly items: readonly InventoryQuantityInput[];
  readonly partialReason: string;
  readonly actorDiscordUserId: string;
  readonly now: Date;
}

export interface RejectWithdrawalInput {
  readonly guildId: string;
  readonly withdrawalRequestId: string;
  readonly actorDiscordUserId: string;
  readonly reason: string;
  readonly now: Date;
}

export class WithdrawalService {
  public constructor(private readonly db: Database) {}

  public async create(input: CreateWithdrawalInput): Promise<WithdrawalRequestView> {
    const reason = requireText(input.reason, 'เหตุผลเบิกของ', 2, 500);
    validateItemInputs(input.items);
    const requestId = await this.db.transaction(async (tx) => {
      await lockInventoryGuild(tx, input.guildId);
      const [existing] = await tx
        .select()
        .from(withdrawalRequests)
        .where(and(
          eq(withdrawalRequests.guildId, input.guildId),
          eq(withdrawalRequests.clientRequestId, input.clientRequestId),
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
      if (member === undefined) throw new AuthorizationError('ต้องเป็นสมาชิกสถานะใช้งานจึงเบิกของได้');

      const codes = input.items.map((item) => item.itemCode);
      const stockItems = await tx
        .select()
        .from(inventoryItems)
        .where(and(
          eq(inventoryItems.guildId, input.guildId),
          eq(inventoryItems.isActive, true),
          inArray(inventoryItems.itemCode, codes),
        ));
      if (stockItems.length !== codes.length) throw new ValidationError('มีสิ่งของที่ไม่มีอยู่ใน Stock หรือถูกปิดใช้งาน');
      const stockByCode = new Map(stockItems.map((item) => [item.itemCode, item]));
      const [request] = await tx
        .insert(withdrawalRequests)
        .values({
          guildId: input.guildId,
          clientRequestId: input.clientRequestId,
          requesterMemberId: member.id,
          reason,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (request === undefined) throw new Error('Withdrawal request creation did not return a row');
      await tx.insert(withdrawalRequestItems).values(input.items.map((requested) => ({
        requestId: request.id,
        itemId: requireStockItem(stockByCode, requested.itemCode).id,
        requestedQuantity: requested.quantity,
      })));
      await queueWithdrawalJob(tx, input.guildId, 'WITHDRAWAL_PUBLISH', request.id, input.now, 'publish');
      await writeInventoryAudit(tx, input.guildId, input.requesterDiscordUserId, 'WITHDRAWAL_REQUESTED', 'WITHDRAWAL_REQUEST', request.id, null, request);
      return request.id;
    });
    return this.get(input.guildId, requestId);
  }

  public async get(guildId: string, requestId: string): Promise<WithdrawalRequestView> {
    const [requestContext] = await this.db
      .select({ request: withdrawalRequests, member: members })
      .from(withdrawalRequests)
      .innerJoin(members, eq(withdrawalRequests.requesterMemberId, members.id))
      .where(and(eq(withdrawalRequests.guildId, guildId), eq(withdrawalRequests.id, requestId)))
      .limit(1);
    if (requestContext === undefined) throw new NotFoundError('ไม่พบคำขอเบิกของ');
    const [items, fulfillments] = await Promise.all([
      this.db
        .select({ requestItem: withdrawalRequestItems, item: inventoryItems })
        .from(withdrawalRequestItems)
        .innerJoin(inventoryItems, eq(withdrawalRequestItems.itemId, inventoryItems.id))
        .where(eq(withdrawalRequestItems.requestId, requestId))
        .orderBy(asc(inventoryItems.itemCode)),
      this.db
        .select()
        .from(withdrawalFulfillments)
        .where(eq(withdrawalFulfillments.requestId, requestId))
        .orderBy(asc(withdrawalFulfillments.createdAt)),
    ]);
    return {
      request: requestContext.request,
      requester: {
        discordUserId: requestContext.member.discordUserId,
        inGameName: requestContext.member.inGameName,
      },
      items: items.map(({ requestItem, item }) => ({
        item,
        requestedQuantity: requestItem.requestedQuantity,
        fulfilledQuantity: requestItem.fulfilledQuantity,
      })),
      fulfillments,
    };
  }

  public async list(guildId: string, limit = 25): Promise<WithdrawalRequestView[]> {
    const requests = await this.db
      .select({ id: withdrawalRequests.id })
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.guildId, guildId))
      .orderBy(desc(withdrawalRequests.createdAt))
      .limit(limit);
    return Promise.all(requests.map(async ({ id }) => this.get(guildId, id)));
  }

  public async fulfill(input: FulfillWithdrawalInput): Promise<WithdrawalRequestView> {
    validateItemInputs(input.items);
    const requestId = await this.db.transaction(async (tx) => {
      await lockInventoryGuild(tx, input.guildId);
      const [existing] = await tx
        .select()
        .from(withdrawalFulfillments)
        .where(and(
          eq(withdrawalFulfillments.guildId, input.guildId),
          eq(withdrawalFulfillments.clientRequestId, input.clientRequestId),
        ))
        .limit(1);
      if (existing !== undefined) return existing.requestId;

      const [request] = await tx
        .select()
        .from(withdrawalRequests)
        .where(and(eq(withdrawalRequests.guildId, input.guildId), eq(withdrawalRequests.id, input.withdrawalRequestId)))
        .limit(1)
        .for('update');
      if (request === undefined) throw new NotFoundError('ไม่พบคำขอเบิกของ');
      if (request.status === 'FULFILLED') throw new ConflictError('คำขอนี้จ่ายครบแล้ว');
      if (request.status === 'CANCELLED') throw new ConflictError('คำขอนี้ถูกปฏิเสธแล้ว');

      const requestedRows = await tx
        .select({ requestItem: withdrawalRequestItems, item: inventoryItems })
        .from(withdrawalRequestItems)
        .innerJoin(inventoryItems, eq(withdrawalRequestItems.itemId, inventoryItems.id))
        .where(eq(withdrawalRequestItems.requestId, request.id))
        .for('update');
      const requestedByCode = new Map(requestedRows.map((row) => [row.item.itemCode, row]));
      const deltas = input.items.map((fulfillment) => {
        const row = requestedByCode.get(fulfillment.itemCode);
        if (row === undefined) throw new ValidationError('มีสิ่งของที่ไม่ได้อยู่ในคำขอนี้');
        const remaining = row.requestItem.requestedQuantity - row.requestItem.fulfilledQuantity;
        if (fulfillment.quantity > remaining) {
          throw new ValidationError(`${row.item.itemName} เหลือให้จ่ายได้ ${remaining.toString()} ชิ้น`);
        }
        if (fulfillment.quantity > row.item.quantity) {
          throw new ConflictError(`${row.item.itemName} ใน Stock มีเพียง ${row.item.quantity.toString()} ชิ้น`);
        }
        return { item: row.item, quantityChange: -fulfillment.quantity, action: 'WITHDRAWAL' as const };
      });
      const fulfillmentByCode = new Map(input.items.map((item) => [item.itemCode, item.quantity]));
      const isComplete = requestedRows.every(({ requestItem, item }) => (
        requestItem.fulfilledQuantity + (fulfillmentByCode.get(item.itemCode) ?? 0) === requestItem.requestedQuantity
      ));
      const partialReason = requirePartialFulfillmentReason(input.partialReason, isComplete);

      const fulfillmentId = randomUUID();
      const [batch] = await tx
        .insert(inventoryBatches)
        .values({
          guildId: input.guildId,
          batchRef: `WITHDRAWAL-${input.clientRequestId}`,
          sourceType: 'WITHDRAWAL',
          sourceId: request.id,
          reason: partialReason ?? `จ่ายของตามคำขอ ${request.id}`,
          createdByDiscordUserId: input.actorDiscordUserId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (batch === undefined) throw new Error('Withdrawal inventory batch creation did not return a row');
      await applyInventoryDeltasWithTransaction(tx, {
        guildId: input.guildId,
        batchId: batch.id,
        action: 'WITHDRAWAL',
        deltas,
        now: input.now,
      });
      for (const fulfillment of input.items) {
        const row = requestedByCode.get(fulfillment.itemCode);
        if (row === undefined) throw new Error('Validated withdrawal item disappeared');
        await tx
          .update(withdrawalRequestItems)
          .set({ fulfilledQuantity: row.requestItem.fulfilledQuantity + fulfillment.quantity })
          .where(and(
            eq(withdrawalRequestItems.requestId, request.id),
            eq(withdrawalRequestItems.itemId, row.item.id),
            eq(withdrawalRequestItems.fulfilledQuantity, row.requestItem.fulfilledQuantity),
          ));
      }
      await tx.insert(withdrawalFulfillments).values({
        id: fulfillmentId,
        guildId: input.guildId,
        clientRequestId: input.clientRequestId,
        requestId: request.id,
        inventoryBatchId: batch.id,
        partialReason,
        fulfilledByDiscordUserId: input.actorDiscordUserId,
        createdAt: input.now,
      });
      await queueStockBatchPublish(tx, input.guildId, batch.id, input.now);
      await tx
        .update(withdrawalRequests)
        .set({ status: isComplete ? 'FULFILLED' : 'PARTIALLY_FULFILLED', updatedAt: input.now })
        .where(eq(withdrawalRequests.id, request.id));
      await queueStockRefresh(tx, input.guildId, input.now);
      await queueWithdrawalJob(tx, input.guildId, 'WITHDRAWAL_REFRESH', request.id, input.now, `refresh:${input.clientRequestId}`);
      await writeInventoryAudit(tx, input.guildId, input.actorDiscordUserId, 'WITHDRAWAL_FULFILLED', 'WITHDRAWAL_REQUEST', request.id, request, { fulfillmentId, batchId: batch.id, isComplete }, partialReason ?? undefined);
      return request.id;
    });
    return this.get(input.guildId, requestId);
  }

  public async reject(input: RejectWithdrawalInput): Promise<WithdrawalRequestView> {
    const rejectionReason = requireText(input.reason, 'เหตุผลที่ปฏิเสธ', 2, 500);
    await this.db.transaction(async (tx) => {
      await lockInventoryGuild(tx, input.guildId);
      const [request] = await tx
        .select()
        .from(withdrawalRequests)
        .where(and(
          eq(withdrawalRequests.guildId, input.guildId),
          eq(withdrawalRequests.id, input.withdrawalRequestId),
        ))
        .limit(1)
        .for('update');
      if (request === undefined) throw new NotFoundError('ไม่พบคำขอเบิกของ');
      if (request.status === 'CANCELLED') return;
      if (request.status !== 'PENDING') {
        throw new ConflictError('ปฏิเสธได้เฉพาะคำขอที่ยังรอจ่ายและยังไม่เคยจ่ายของ');
      }

      await tx
        .update(withdrawalRequests)
        .set({
          status: 'CANCELLED',
          decidedAt: input.now,
          decidedByDiscordUserId: input.actorDiscordUserId,
          rejectionReason,
          updatedAt: input.now,
        })
        .where(eq(withdrawalRequests.id, request.id));
      await queueWithdrawalJob(tx, input.guildId, 'WITHDRAWAL_REFRESH', request.id, input.now, 'reject');
      await writeInventoryAudit(
        tx,
        input.guildId,
        input.actorDiscordUserId,
        'WITHDRAWAL_REJECTED',
        'WITHDRAWAL_REQUEST',
        request.id,
        request,
        { status: 'CANCELLED', rejectionReason },
        rejectionReason,
      );
    });
    return this.get(input.guildId, input.withdrawalRequestId);
  }

  public async markPublished(guildId: string, requestId: string, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(withdrawalRequests)
      .set({ publicChannelId: channelId, publicMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(withdrawalRequests.guildId, guildId), eq(withdrawalRequests.id, requestId)));
  }
}

async function queueWithdrawalJob(
  tx: InventoryTransaction,
  guildId: string,
  jobType: string,
  requestId: string,
  runAt: Date,
  key: string,
): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType,
    deduplicationKey: `withdrawal:${requestId}:${key}`,
    payload: { requestId },
    runAt,
  }).onConflictDoNothing();
}

function validateItemInputs(items: readonly InventoryQuantityInput[]): void {
  if (items.length < 1 || items.length > 50) throw new ValidationError('ต้องระบุรายการของ 1–50 รายการ');
  const codes = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!/^[A-Z0-9][A-Z0-9_-]{0,49}$/u.test(item.itemCode)) throw new ValidationError(`รายการที่ ${(index + 1).toString()} ไม่ถูกต้อง`);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new ValidationError(`จำนวนของรายการที่ ${(index + 1).toString()} ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป`);
    if (codes.has(item.itemCode)) throw new ValidationError(`รายการที่ ${(index + 1).toString()} ซ้ำกัน`);
    codes.add(item.itemCode);
  }
}

function requireStockItem(items: ReadonlyMap<string, InventoryItem>, itemCode: string): InventoryItem {
  const item = items.get(itemCode);
  if (item === undefined) throw new ValidationError('ไม่พบสิ่งของใน Stock');
  return item;
}

function requireText(value: string, label: string, minimum: number, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ValidationError(`${label}ต้องมี ${String(minimum)}–${String(maximum)} ตัวอักษร`);
  }
  return normalized;
}
