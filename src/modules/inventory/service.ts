import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  guildSettings,
  inventoryBatches,
  inventoryItems,
  inventoryMovements,
  scheduledJobs,
} from '../../infrastructure/db/schema.js';
import { writeAudit } from '../audit/service.js';
import {
  hashCsv,
  parseInitialStockCsv,
  parseStockMovementCsv,
  planStockMovements,
} from './csv.js';
import { formatInventoryItemCode } from './rules.js';

export type InventoryItem = typeof inventoryItems.$inferSelect;
export type InventoryBatch = typeof inventoryBatches.$inferSelect;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InventoryTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface InventoryBatchView {
  readonly batch: InventoryBatch;
  readonly movements: readonly {
    readonly movement: InventoryMovement;
    readonly item: InventoryItem;
  }[];
}

export interface StockDashboard {
  readonly items: readonly InventoryItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

const STOCK_DASHBOARD_DESCRIPTION_LIMIT = 3_900;

export interface ApplyStockCsvInput {
  readonly guildId: string;
  readonly content: Buffer;
  readonly originalAttachmentId: string;
  readonly publicChannelId: string;
  readonly publicMessageId: string;
  readonly actorDiscordUserId: string;
  readonly now: Date;
}

export interface InventoryDelta {
  readonly item: InventoryItem;
  readonly quantityChange: number;
}

export class InventoryService {
  public constructor(private readonly db: Database) {}

  public async getDashboard(guildId: string, requestedPage = 1, pageSize?: number): Promise<StockDashboard> {
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) throw new ValidationError('หน้า stock ไม่ถูกต้อง');
    if (pageSize === undefined) {
      const items = await this.listActiveDashboardItems(guildId);
      const pages = paginateStockDashboardItems(items);
      const totalPages = pages.length;
      const page = Math.min(requestedPage, totalPages);
      const visibleItems = pages[page - 1] ?? [];
      return {
        items: visibleItems,
        page,
        pageSize: visibleItems.length,
        totalItems: items.length,
        totalPages,
      };
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 25) throw new ValidationError('จำนวนรายการต่อหน้าต้องอยู่ระหว่าง 1–25');
    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.guildId, guildId), eq(inventoryItems.isActive, true)));
    const totalItems = countRow?.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const items = await this.db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.guildId, guildId), eq(inventoryItems.isActive, true)))
      .orderBy(asc(inventoryItems.itemCode))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items, page, pageSize, totalItems, totalPages };
  }

  private async listActiveDashboardItems(guildId: string): Promise<InventoryItem[]> {
    return this.db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.guildId, guildId), eq(inventoryItems.isActive, true)))
      .orderBy(asc(inventoryItems.itemCode));
  }

  public async getActiveItems(guildId: string, itemIds: readonly string[]): Promise<InventoryItem[]> {
    if (itemIds.length < 1 || itemIds.length > 25 || new Set(itemIds).size !== itemIds.length) {
      throw new ValidationError('รายการสิ่งของที่เลือกไม่ถูกต้อง');
    }
    const items = await this.db
      .select()
      .from(inventoryItems)
      .where(and(
        eq(inventoryItems.guildId, guildId),
        eq(inventoryItems.isActive, true),
        inArray(inventoryItems.id, [...itemIds]),
      ))
      .orderBy(asc(inventoryItems.itemCode));
    if (items.length !== itemIds.length) {
      throw new NotFoundError('มีสิ่งของในตะกร้าที่ไม่พบหรือถูกปิดใช้งาน กรุณาเลือกใหม่');
    }
    return items;
  }

  public async listRecentBatches(guildId: string, limit = 25): Promise<InventoryBatchView[]> {
    const batches = await this.db
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.guildId, guildId))
      .orderBy(desc(inventoryBatches.createdAt))
      .limit(limit);
    return Promise.all(batches.map(async (batch) => this.getBatch(guildId, batch.id)));
  }

  public async getBatch(guildId: string, batchId: string): Promise<InventoryBatchView> {
    const [batch] = await this.db
      .select()
      .from(inventoryBatches)
      .where(and(eq(inventoryBatches.guildId, guildId), eq(inventoryBatches.id, batchId)))
      .limit(1);
    if (batch === undefined) throw new NotFoundError('ไม่พบรายการเคลื่อนไหว stock');
    const movements = await this.db
      .select({ movement: inventoryMovements, item: inventoryItems })
      .from(inventoryMovements)
      .innerJoin(inventoryItems, eq(inventoryMovements.itemId, inventoryItems.id))
      .where(eq(inventoryMovements.batchId, batchId))
      .orderBy(asc(inventoryItems.itemCode));
    return { batch, movements };
  }

  public async applyOpeningCsv(input: ApplyStockCsvInput): Promise<InventoryBatchView> {
    const rows = parseInitialStockCsv(input.content);
    const fileHash = hashCsv(input.content);
    const batchId = await this.db.transaction(async (tx) => {
      await lockInventoryGuild(tx, input.guildId);
      const existing = await findBatchByHash(tx, input.guildId, fileHash);
      if (existing !== null) return existing.id;
      const [itemExists] = await tx
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(eq(inventoryItems.guildId, input.guildId))
        .limit(1);
      if (itemExists !== undefined) throw new ConflictError('ตั้งยอดเริ่มต้นได้ก่อนมีรายการ stock เท่านั้น');

      const [batch] = await tx
        .insert(inventoryBatches)
        .values({
          guildId: input.guildId,
          batchRef: `OPENING-${fileHash.slice(0, 16).toUpperCase()}`,
          fileHash,
          sourceType: 'OPENING_CSV',
          originalAttachmentId: input.originalAttachmentId,
          publicChannelId: input.publicChannelId,
          publicMessageId: input.publicMessageId,
          reason: 'นำเข้ายอดตั้งต้นจาก CSV',
          createdByDiscordUserId: input.actorDiscordUserId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (batch === undefined) throw new Error('Opening inventory batch creation did not return a row');

      const createdItems = await tx
        .insert(inventoryItems)
        .values(rows.map((row, index) => ({
          guildId: input.guildId,
          itemCode: formatInventoryItemCode(index + 1),
          itemName: row.itemName,
          quantity: row.openingQuantity,
          createdAt: input.now,
          updatedAt: input.now,
        })))
        .returning();
      const quantityByName = new Map(rows.map((row) => [row.itemName, row.openingQuantity]));
      const movements = createdItems
        .map((item) => ({ item, quantity: quantityByName.get(item.itemName) ?? 0 }))
        .filter(({ quantity }) => quantity > 0)
        .map(({ item, quantity }) => ({
          guildId: input.guildId,
          batchId: batch.id,
          itemId: item.id,
          action: 'OPENING' as const,
          quantityChange: quantity,
          quantityBefore: 0,
          quantityAfter: quantity,
          createdAt: input.now,
        }));
      if (movements.length > 0) await tx.insert(inventoryMovements).values(movements);
      await queueStockRefresh(tx, input.guildId, input.now);
      await writeInventoryAudit(tx, input.guildId, input.actorDiscordUserId, 'STOCK_OPENING_IMPORTED', 'INVENTORY_BATCH', batch.id, null, { batch, itemCount: createdItems.length });
      return batch.id;
    });
    return this.getBatch(input.guildId, batchId);
  }

  public async applyMovementCsv(input: ApplyStockCsvInput): Promise<InventoryBatchView> {
    const rows = parseStockMovementCsv(input.content);
    const fileHash = hashCsv(input.content);
    const batchRef = rows[0]?.batchRef;
    if (batchRef === undefined) throw new ValidationError('ไฟล์ CSV ไม่มี batch_ref');
    const batchId = await this.db.transaction(async (tx) => {
      await lockInventoryGuild(tx, input.guildId);
      const existingByHash = await findBatchByHash(tx, input.guildId, fileHash);
      if (existingByHash !== null) return existingByHash.id;
      const [existingByRef] = await tx
        .select()
        .from(inventoryBatches)
        .where(and(eq(inventoryBatches.guildId, input.guildId), eq(inventoryBatches.batchRef, batchRef)))
        .limit(1);
      if (existingByRef !== undefined) throw new ConflictError('batch_ref นี้ถูกใช้กับไฟล์อื่นแล้ว');

      const codes = rows.map((row) => row.itemCode);
      const currentItems = await tx
        .select()
        .from(inventoryItems)
        .where(and(eq(inventoryItems.guildId, input.guildId), inArray(inventoryItems.itemCode, codes)))
        .for('update');
      const currentState = new Map(currentItems.map((item) => [item.itemCode, {
        itemCode: item.itemCode,
        itemName: item.itemName,
        quantity: item.quantity,
      }]));
      const planned = planStockMovements(rows, currentState);
      const itemsByCode = new Map(currentItems.map((item) => [item.itemCode, item]));
      const [batch] = await tx
        .insert(inventoryBatches)
        .values({
          guildId: input.guildId,
          batchRef,
          fileHash,
          sourceType: 'STOCK_CSV',
          originalAttachmentId: input.originalAttachmentId,
          publicChannelId: input.publicChannelId,
          publicMessageId: input.publicMessageId,
          reason: summarizeReasons(rows.map((row) => row.reason)),
          createdByDiscordUserId: input.actorDiscordUserId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (batch === undefined) throw new Error('Inventory batch creation did not return a row');
      await applyInventoryDeltasWithTransaction(tx, {
        guildId: input.guildId,
        batchId: batch.id,
        action: null,
        deltas: planned.map((movement) => ({
          item: requireItem(itemsByCode, movement.itemCode),
          quantityChange: movement.quantityChange,
          action: movement.action,
        })),
        now: input.now,
      });
      await queueStockRefresh(tx, input.guildId, input.now);
      await writeInventoryAudit(tx, input.guildId, input.actorDiscordUserId, 'STOCK_CSV_APPLIED', 'INVENTORY_BATCH', batch.id, null, batch);
      return batch.id;
    });
    return this.getBatch(input.guildId, batchId);
  }

  public async reverseBatch(
    guildId: string,
    requestId: string,
    targetBatchId: string,
    reason: string,
    actorDiscordUserId: string,
    now: Date,
  ): Promise<InventoryBatchView> {
    const normalizedReason = requireText(reason, 'เหตุผลย้อนรายการ', 2, 500);
    const reversalId = await this.db.transaction(async (tx) => {
      await lockInventoryGuild(tx, guildId);
      const [existing] = await tx
        .select()
        .from(inventoryBatches)
        .where(and(eq(inventoryBatches.guildId, guildId), eq(inventoryBatches.batchRef, `REVERSAL-${requestId}`)))
        .limit(1);
      if (existing !== undefined) return existing.id;
      const [target] = await tx
        .select()
        .from(inventoryBatches)
        .where(and(eq(inventoryBatches.guildId, guildId), eq(inventoryBatches.id, targetBatchId)))
        .limit(1)
        .for('update');
      if (target === undefined) throw new NotFoundError('ไม่พบ batch ที่ต้องการย้อน');
      if (target.sourceType !== 'STOCK_CSV') throw new ConflictError('ย้อนจากหน้านี้ได้เฉพาะ batch เพิ่ม/หัก stock ด้วย CSV');
      if (target.reversedAt !== null) throw new ConflictError('batch นี้ถูกย้อนแล้ว');

      const targetMovements = await tx
        .select({ movement: inventoryMovements, item: inventoryItems })
        .from(inventoryMovements)
        .innerJoin(inventoryItems, eq(inventoryMovements.itemId, inventoryItems.id))
        .where(eq(inventoryMovements.batchId, target.id))
        .for('update');
      const [reversal] = await tx
        .insert(inventoryBatches)
        .values({
          guildId,
          batchRef: `REVERSAL-${requestId}`,
          sourceType: 'REVERSAL',
          sourceId: target.id,
          reason: normalizedReason,
          createdByDiscordUserId: actorDiscordUserId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (reversal === undefined) throw new Error('Inventory reversal creation did not return a row');
      await applyInventoryDeltasWithTransaction(tx, {
        guildId,
        batchId: reversal.id,
        action: 'REVERSAL',
        deltas: targetMovements.map(({ movement, item }) => ({ item, quantityChange: -movement.quantityChange })),
        now,
      });
      await tx
        .update(inventoryBatches)
        .set({ reversedAt: now, reversedByDiscordUserId: actorDiscordUserId, updatedAt: now })
        .where(eq(inventoryBatches.id, target.id));
      await queueStockBatchPublish(tx, guildId, reversal.id, now);
      await queueStockBatchRefresh(tx, guildId, target.id, now);
      await queueStockRefresh(tx, guildId, now);
      await writeInventoryAudit(tx, guildId, actorDiscordUserId, 'STOCK_BATCH_REVERSED', 'INVENTORY_BATCH', target.id, target, { reversalId: reversal.id }, normalizedReason);
      return reversal.id;
    });
    return this.getBatch(guildId, reversalId);
  }

  public async markBatchPublished(guildId: string, batchId: string, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(inventoryBatches)
      .set({ publicChannelId: channelId, publicMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(inventoryBatches.guildId, guildId), eq(inventoryBatches.id, batchId)));
  }
}

/**
 * Discord permits at most 4,096 characters in an embed description.  The dashboard
 * uses a slightly lower limit so the same panel can keep showing as many items as fit
 * without risking a rejected message when names or quantities become longer.
 */
export function paginateStockDashboardItems(items: readonly InventoryItem[]): readonly (readonly InventoryItem[])[] {
  if (items.length === 0) return [[]];

  const pages: InventoryItem[][] = [];
  let currentPage: InventoryItem[] = [];
  let descriptionLength = 0;

  for (const item of items) {
    const lineLength = stockDashboardLine(item).length;
    const separatorLength = currentPage.length === 0 ? 0 : 1;
    if (currentPage.length > 0 && descriptionLength + separatorLength + lineLength > STOCK_DASHBOARD_DESCRIPTION_LIMIT) {
      pages.push(currentPage);
      currentPage = [];
      descriptionLength = 0;
    }
    if (currentPage.length > 0) descriptionLength += 1;
    currentPage.push(item);
    descriptionLength += lineLength;
  }

  pages.push(currentPage);
  return pages;
}

export function stockDashboardLine(item: Pick<InventoryItem, 'itemName' | 'quantity'>): string {
  return `**${item.itemName}** — คงเหลือ **${item.quantity.toLocaleString('th-TH')} ชิ้น**`;
}

export async function lockInventoryGuild(tx: InventoryTransaction, guildId: string): Promise<void> {
  const [guild] = await tx
    .select({ guildId: guildSettings.guildId })
    .from(guildSettings)
    .where(eq(guildSettings.guildId, guildId))
    .limit(1)
    .for('update');
  if (guild === undefined) throw new NotFoundError('ไม่พบการตั้งค่า Server');
}

export async function applyInventoryDeltasWithTransaction(
  tx: InventoryTransaction,
  input: {
    readonly guildId: string;
    readonly batchId: string;
    readonly action: InventoryMovement['action'] | null;
    readonly deltas: readonly (InventoryDelta & { readonly action?: InventoryMovement['action'] })[];
    readonly now: Date;
  },
): Promise<void> {
  for (const delta of input.deltas) {
    if (!Number.isSafeInteger(delta.quantityChange) || delta.quantityChange === 0) {
      throw new ValidationError('จำนวนเปลี่ยนแปลง stock ต้องเป็นจำนวนเต็มและห้ามเป็นศูนย์');
    }
    const quantityAfter = delta.item.quantity + delta.quantityChange;
    if (!Number.isSafeInteger(quantityAfter) || quantityAfter < 0) {
      throw new ConflictError(`stock ${delta.item.itemCode} ไม่พอสำหรับรายการนี้`);
    }
    const [updated] = await tx
      .update(inventoryItems)
      .set({ quantity: quantityAfter, updatedAt: input.now })
      .where(and(eq(inventoryItems.id, delta.item.id), eq(inventoryItems.quantity, delta.item.quantity)))
      .returning();
    if (updated === undefined) throw new ConflictError(`stock ${delta.item.itemCode} ถูกเปลี่ยนโดยรายการอื่น กรุณาลองใหม่`);
    await tx.insert(inventoryMovements).values({
      guildId: input.guildId,
      batchId: input.batchId,
      itemId: delta.item.id,
      action: delta.action ?? input.action ?? 'REMOVE',
      quantityChange: delta.quantityChange,
      quantityBefore: delta.item.quantity,
      quantityAfter,
      createdAt: input.now,
    });
  }
}

export async function queueStockRefresh(tx: InventoryTransaction, guildId: string, runAt: Date): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'STOCK_REFRESH',
    deduplicationKey: `stock:refresh:${randomUUID()}`,
    payload: {},
    runAt,
  });
}

export async function queueStockBatchPublish(tx: InventoryTransaction, guildId: string, batchId: string, runAt: Date): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'STOCK_BATCH_PUBLISH',
    deduplicationKey: `stock:${batchId}:publish`,
    payload: { batchId },
    runAt,
  }).onConflictDoNothing();
}

async function queueStockBatchRefresh(tx: InventoryTransaction, guildId: string, batchId: string, runAt: Date): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'STOCK_BATCH_REFRESH',
    deduplicationKey: `stock:${batchId}:refresh:${randomUUID()}`,
    payload: { batchId },
    runAt,
  });
}

export async function writeInventoryAudit(
  tx: InventoryTransaction,
  guildId: string,
  actorDiscordUserId: string,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason?: string,
): Promise<void> {
  await writeAudit(tx, {
    guildId,
    actorDiscordUserId,
    action,
    entityType,
    entityId,
    before,
    after,
    ...(reason === undefined ? {} : { reason }),
  });
}

async function findBatchByHash(tx: InventoryTransaction, guildId: string, fileHash: string): Promise<InventoryBatch | null> {
  const [batch] = await tx
    .select()
    .from(inventoryBatches)
    .where(and(eq(inventoryBatches.guildId, guildId), eq(inventoryBatches.fileHash, fileHash)))
    .limit(1);
  return batch ?? null;
}

function requireItem(itemsByCode: ReadonlyMap<string, InventoryItem>, itemCode: string): InventoryItem {
  const item = itemsByCode.get(itemCode);
  if (item === undefined) throw new ValidationError(`ไม่พบ item code ${itemCode}`);
  return item;
}

function summarizeReasons(reasons: readonly string[]): string {
  const unique = [...new Set(reasons)];
  const summary = unique.join(' / ');
  return summary.length <= 500 ? summary : `${summary.slice(0, 497)}...`;
}

function requireText(value: string, label: string, minimum: number, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ValidationError(`${label}ต้องมี ${String(minimum)}–${String(maximum)} ตัวอักษร`);
  }
  return normalized;
}
