import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  depositRequestItems,
  depositRequests,
  inventoryBatches,
  inventoryItems,
  members,
} from '../../infrastructure/db/schema.js';
import {
  applyInventoryDeltasWithTransaction,
  lockInventoryGuild,
  queueStockRefresh,
  writeInventoryAudit,
  type InventoryItem,
  type InventoryTransaction,
} from '../inventory/service.js';
import { normalizeInventoryItemName, type InventoryNameQuantityInput } from '../inventory/rules.js';

export type DepositRequest = typeof depositRequests.$inferSelect;

export interface DepositItemView {
  readonly item: InventoryItem;
  readonly quantity: number;
}

export interface DepositRequestView {
  readonly request: DepositRequest;
  readonly sender: {
    readonly discordUserId: string;
    readonly inGameName: string;
  };
  readonly items: readonly DepositItemView[];
}

export interface PreparedDeposit {
  readonly requestId: string;
  readonly guildId: string;
  readonly sender: DepositRequestView['sender'];
  readonly source: string;
  readonly items: readonly DepositItemView[];
}

export interface PersistDepositInput {
  readonly prepared: PreparedDeposit;
  readonly clientRequestId: string;
  readonly senderDiscordUserId: string;
  readonly attachmentId: string;
  readonly publicChannelId: string;
  readonly publicMessageId: string;
  readonly now: Date;
}

export class DepositService {
  public constructor(private readonly db: Database) {}

  public async prepare(
    guildId: string,
    senderDiscordUserId: string,
    source: string,
    requestedItems: readonly InventoryNameQuantityInput[],
  ): Promise<PreparedDeposit> {
    const normalizedSource = requireText(source, 'ที่มาของของ', 2, 200);
    validateItemInputs(requestedItems);
    const [member] = await this.db
      .select()
      .from(members)
      .where(and(
        eq(members.guildId, guildId),
        eq(members.discordUserId, senderDiscordUserId),
        eq(members.status, 'ACTIVE'),
      ))
      .limit(1);
    if (member === undefined) throw new AuthorizationError('ต้องเป็นสมาชิกสถานะใช้งานจึงส่งของเข้าแก๊งได้');
    const stockItems = await this.db
      .select()
      .from(inventoryItems)
      .where(and(
        eq(inventoryItems.guildId, guildId),
        eq(inventoryItems.isActive, true),
      ));
    const stockByName = new Map(stockItems.map((item) => [normalizeInventoryItemName(item.itemName), item]));
    const resolvedItems = requestedItems.map(({ itemName, quantity }) => {
      const item = stockByName.get(normalizeInventoryItemName(itemName));
      if (item === undefined) throw new ValidationError(`ไม่พบชื่อสิ่งของ ${itemName} ใน Stock หรือรายการถูกปิดใช้งาน`);
      return { item, quantity };
    });
    return {
      requestId: randomUUID(),
      guildId,
      sender: { discordUserId: member.discordUserId, inGameName: member.inGameName },
      source: normalizedSource,
      items: resolvedItems.sort((left, right) => left.item.itemCode.localeCompare(right.item.itemCode)),
    };
  }

  public async persist(input: PersistDepositInput): Promise<DepositRequestView> {
    const requestId = await this.db.transaction(async (tx) => {
      await lockInventoryGuild(tx, input.prepared.guildId);
      const [existing] = await tx
        .select()
        .from(depositRequests)
        .where(and(
          eq(depositRequests.guildId, input.prepared.guildId),
          eq(depositRequests.clientRequestId, input.clientRequestId),
        ))
        .limit(1);
      if (existing !== undefined) return existing.id;
      const [member] = await tx
        .select()
        .from(members)
        .where(and(
          eq(members.guildId, input.prepared.guildId),
          eq(members.discordUserId, input.senderDiscordUserId),
          eq(members.status, 'ACTIVE'),
        ))
        .limit(1);
      if (member === undefined || member.discordUserId !== input.prepared.sender.discordUserId) {
        throw new AuthorizationError('ส่งรายการแทนสมาชิกคนอื่นไม่ได้');
      }
      const codes = input.prepared.items.map(({ item }) => item.itemCode);
      const currentItems = await tx
        .select()
        .from(inventoryItems)
        .where(and(
          eq(inventoryItems.guildId, input.prepared.guildId),
          eq(inventoryItems.isActive, true),
          inArray(inventoryItems.itemCode, codes),
        ));
      if (currentItems.length !== codes.length) throw new ConflictError('รายการ Stock มีการเปลี่ยนแปลง กรุณาส่งใหม่');
      const itemByCode = new Map(currentItems.map((item) => [item.itemCode, item]));
      const [request] = await tx
        .insert(depositRequests)
        .values({
          id: input.prepared.requestId,
          guildId: input.prepared.guildId,
          clientRequestId: input.clientRequestId,
          senderMemberId: member.id,
          source: input.prepared.source,
          attachmentId: input.attachmentId,
          publicChannelId: input.publicChannelId,
          publicMessageId: input.publicMessageId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (request === undefined) throw new Error('Deposit request creation did not return a row');
      await tx.insert(depositRequestItems).values(input.prepared.items.map(({ item, quantity }) => ({
        requestId: request.id,
        itemId: requireStockItem(itemByCode, item.itemCode).id,
        quantity,
      })));
      await writeInventoryAudit(tx, request.guildId, input.senderDiscordUserId, 'DEPOSIT_SUBMITTED', 'DEPOSIT_REQUEST', request.id, null, request);
      return request.id;
    });
    return this.get(input.prepared.guildId, requestId);
  }

  public async approve(guildId: string, requestId: string, actorDiscordUserId: string, now: Date): Promise<DepositRequestView> {
    await this.db.transaction(async (tx) => {
      await lockInventoryGuild(tx, guildId);
      const request = await lockRequest(tx, guildId, requestId);
      if (request.status === 'APPROVED') return;
      if (request.status !== 'PENDING') throw new ConflictError('คำขอนี้ถูกดำเนินการแล้ว');
      const rows = await tx
        .select({ requestItem: depositRequestItems, item: inventoryItems })
        .from(depositRequestItems)
        .innerJoin(inventoryItems, eq(depositRequestItems.itemId, inventoryItems.id))
        .where(eq(depositRequestItems.requestId, request.id))
        .for('update');
      if (rows.length === 0) throw new ConflictError('คำขอส่งของไม่มีรายการ');
      const [batch] = await tx
        .insert(inventoryBatches)
        .values({
          guildId,
          batchRef: `DEPOSIT-${request.clientRequestId}`,
          sourceType: 'DEPOSIT',
          sourceId: request.id,
          originalAttachmentId: request.attachmentId,
          publicChannelId: request.publicChannelId,
          publicMessageId: request.publicMessageId,
          reason: `รับของเข้าแก๊ง: ${request.source}`,
          createdByDiscordUserId: actorDiscordUserId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (batch === undefined) throw new Error('Deposit inventory batch creation did not return a row');
      await applyInventoryDeltasWithTransaction(tx, {
        guildId,
        batchId: batch.id,
        action: 'DEPOSIT',
        deltas: rows.map(({ requestItem, item }) => ({ item, quantityChange: requestItem.quantity })),
        now,
      });
      await tx
        .update(depositRequests)
        .set({
          status: 'APPROVED',
          inventoryBatchId: batch.id,
          decidedAt: now,
          decidedByDiscordUserId: actorDiscordUserId,
          updatedAt: now,
        })
        .where(eq(depositRequests.id, request.id));
      await queueStockRefresh(tx, guildId, now);
      await writeInventoryAudit(tx, guildId, actorDiscordUserId, 'DEPOSIT_APPROVED', 'DEPOSIT_REQUEST', request.id, request, { status: 'APPROVED', batchId: batch.id });
    });
    return this.get(guildId, requestId);
  }

  public async reject(
    guildId: string,
    requestId: string,
    actorDiscordUserId: string,
    reason: string,
    now: Date,
  ): Promise<DepositRequestView> {
    const rejectionReason = requireText(reason, 'เหตุผลที่ปฏิเสธ', 2, 500);
    await this.db.transaction(async (tx) => {
      await lockInventoryGuild(tx, guildId);
      const request = await lockRequest(tx, guildId, requestId);
      if (request.status === 'REJECTED') return;
      if (request.status !== 'PENDING') throw new ConflictError('คำขอนี้ถูกดำเนินการแล้ว');
      await tx
        .update(depositRequests)
        .set({
          status: 'REJECTED',
          decidedAt: now,
          decidedByDiscordUserId: actorDiscordUserId,
          rejectionReason,
          updatedAt: now,
        })
        .where(eq(depositRequests.id, request.id));
      await writeInventoryAudit(tx, guildId, actorDiscordUserId, 'DEPOSIT_REJECTED', 'DEPOSIT_REQUEST', request.id, request, { status: 'REJECTED', rejectionReason }, rejectionReason);
    });
    return this.get(guildId, requestId);
  }

  public async get(guildId: string, requestId: string): Promise<DepositRequestView> {
    const [context] = await this.db
      .select({ request: depositRequests, member: members })
      .from(depositRequests)
      .innerJoin(members, eq(depositRequests.senderMemberId, members.id))
      .where(and(eq(depositRequests.guildId, guildId), eq(depositRequests.id, requestId)))
      .limit(1);
    if (context === undefined) throw new NotFoundError('ไม่พบคำขอส่งของเข้าแก๊ง');
    const items = await this.db
      .select({ requestItem: depositRequestItems, item: inventoryItems })
      .from(depositRequestItems)
      .innerJoin(inventoryItems, eq(depositRequestItems.itemId, inventoryItems.id))
      .where(eq(depositRequestItems.requestId, requestId))
      .orderBy(asc(inventoryItems.itemCode));
    return {
      request: context.request,
      sender: { discordUserId: context.member.discordUserId, inGameName: context.member.inGameName },
      items: items.map(({ requestItem, item }) => ({ item, quantity: requestItem.quantity })),
    };
  }

  public async list(guildId: string, limit = 25): Promise<DepositRequestView[]> {
    const requests = await this.db
      .select({ id: depositRequests.id })
      .from(depositRequests)
      .where(eq(depositRequests.guildId, guildId))
      .orderBy(desc(depositRequests.createdAt))
      .limit(limit);
    return Promise.all(requests.map(async ({ id }) => this.get(guildId, id)));
  }
}

async function lockRequest(tx: InventoryTransaction, guildId: string, requestId: string): Promise<DepositRequest> {
  const [request] = await tx
    .select()
    .from(depositRequests)
    .where(and(eq(depositRequests.guildId, guildId), eq(depositRequests.id, requestId)))
    .limit(1)
    .for('update');
  if (request === undefined) throw new NotFoundError('ไม่พบคำขอส่งของเข้าแก๊ง');
  return request;
}

function validateItemInputs(items: readonly InventoryNameQuantityInput[]): void {
  if (items.length < 1 || items.length > 50) throw new ValidationError('ต้องระบุรายการของ 1–50 รายการ');
  const names = new Set<string>();
  for (const item of items) {
    const itemName = item.itemName.trim();
    if (itemName.length < 1 || itemName.length > 100) throw new ValidationError('ชื่อสิ่งของต้องมี 1–100 ตัวอักษร');
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new ValidationError(`จำนวนของ ${itemName} ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป`);
    const normalizedName = normalizeInventoryItemName(itemName);
    if (names.has(normalizedName)) throw new ValidationError(`ชื่อสิ่งของ ${itemName} ซ้ำกัน`);
    names.add(normalizedName);
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
