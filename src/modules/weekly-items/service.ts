import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { and, asc, desc, eq, inArray, like } from 'drizzle-orm';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  inventoryBatches,
  inventoryItems,
  members,
  scheduledJobs,
  weeklyItemCollections,
  weeklyItemObligationItems,
  weeklyItemObligations,
  weeklyItemProofItems,
  weeklyItemProofs,
  weeklyItemRequirements,
} from '../../infrastructure/db/schema.js';
import { writeAudit } from '../audit/service.js';
import {
  applyInventoryDeltasWithTransaction,
  lockInventoryGuild,
  queueStockBatchPublish,
  queueStockRefresh,
  type InventoryItem,
  type InventoryTransaction,
} from '../inventory/service.js';

export const WEEKLY_ITEMS_RESERVE_EXEMPTION_REASON = 'ยกเว้นเนื่องจากเป็นตำแหน่งสำรอง';
export const WEEKLY_ITEMS_ADMIN_EXEMPTION_REASON = 'ยกเว้นโดย Admin';
const SYSTEM_ACTOR = 'SYSTEM';

export type WeeklyItemCollection = typeof weeklyItemCollections.$inferSelect;
export type WeeklyItemRequirement = typeof weeklyItemRequirements.$inferSelect;
export type WeeklyItemObligation = typeof weeklyItemObligations.$inferSelect;
export type WeeklyItemProof = typeof weeklyItemProofs.$inferSelect;
export type WeeklyItemMemberRule = 'REQUIRED' | 'EXEMPT';

export interface WeeklyItemRequirementInput {
  readonly itemId: string;
  readonly requiredQuantity: number;
  readonly initialPenaltyQuantity: number;
  readonly recurringPenaltyQuantity: number;
}

export interface WeeklyItemRequirementView {
  readonly requirement: WeeklyItemRequirement;
  readonly item: InventoryItem;
}

export interface WeeklyItemObligationView {
  readonly obligation: WeeklyItemObligation;
  readonly member: { readonly id: string; readonly discordUserId: string; readonly inGameName: string };
  readonly items: readonly { readonly item: InventoryItem; readonly quantity: number }[];
}

export interface WeeklyItemCollectionView {
  readonly collection: WeeklyItemCollection;
  readonly requirements: readonly WeeklyItemRequirementView[];
  readonly obligations: readonly WeeklyItemObligationView[];
}

export interface WeeklyItemProofView {
  readonly proof: WeeklyItemProof;
  readonly collection: WeeklyItemCollection;
  readonly obligation: WeeklyItemObligation;
  readonly member: WeeklyItemObligationView['member'];
  readonly items: WeeklyItemObligationView['items'];
}

export interface CreateWeeklyItemCollectionInput {
  readonly guildId: string;
  readonly requestId: string;
  readonly title: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly requirements: readonly WeeklyItemRequirementInput[];
  readonly timezone: string;
  readonly actorDiscordUserId: string;
  readonly now: Date;
}

export interface PersistWeeklyItemProofInput {
  readonly proofId: string;
  readonly guildId: string;
  readonly collectionId: string;
  readonly requestId: string;
  readonly submittedByDiscordUserId: string;
  readonly attachmentId: string;
  readonly logChannelId: string;
  readonly logMessageId: string;
  readonly now: Date;
}

export class WeeklyItemsService {
  public constructor(private readonly db: Database) {}

  public async create(input: CreateWeeklyItemCollectionInput): Promise<WeeklyItemCollectionView> {
    const title = requireText(input.title, 'ชื่อรอบส่งของ', 2, 100);
    validateRequirements(input.requirements);
    const startsAt = parseLocalDateStart(input.startsOn, input.timezone, 'วันที่เริ่ม');
    const firstPenaltyAt = parseLocalDateStart(input.endsOn, input.timezone, 'วันที่สิ้นสุด').plus({ days: 1 });
    if (firstPenaltyAt <= startsAt) throw new ValidationError('วันที่สิ้นสุดต้องไม่อยู่ก่อนวันที่เริ่ม');
    if (firstPenaltyAt.toJSDate() <= input.now) throw new ValidationError('รอบส่งของต้องยังไม่หมดเวลา');

    const collectionId = await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(weeklyItemCollections).where(and(
        eq(weeklyItemCollections.guildId, input.guildId),
        eq(weeklyItemCollections.requestId, input.requestId),
      )).limit(1);
      if (existing !== undefined) return existing.id;

      const itemIds = input.requirements.map((requirement) => requirement.itemId);
      const stockItems = await tx.select().from(inventoryItems).where(and(
        eq(inventoryItems.guildId, input.guildId),
        eq(inventoryItems.isActive, true),
        inArray(inventoryItems.id, itemIds),
      )).for('update');
      if (stockItems.length !== itemIds.length) throw new ValidationError('มีสิ่งของที่ไม่พบหรือถูกปิดใช้งาน กรุณาเลือกใหม่');

      const activeMembers = await tx.select({ id: members.id, rosterTitle: members.rosterTitle })
        .from(members).where(and(eq(members.guildId, input.guildId), eq(members.status, 'ACTIVE')));
      if (activeMembers.length === 0) throw new ValidationError('ยังไม่มีสมาชิกสถานะใช้งานสำหรับสร้างรอบส่งของ');

      const [collection] = await tx.insert(weeklyItemCollections).values({
        guildId: input.guildId,
        requestId: input.requestId,
        title,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        firstPenaltyAt: firstPenaltyAt.toJSDate(),
        createdByDiscordUserId: input.actorDiscordUserId,
        createdAt: input.now,
        updatedAt: input.now,
      }).returning();
      if (collection === undefined) throw new Error('Weekly item collection creation did not return a row');

      await tx.insert(weeklyItemRequirements).values(input.requirements.map((requirement) => ({
        collectionId: collection.id,
        ...requirement,
      })));
      for (const member of activeMembers) {
        const exempt = member.rosterTitle === 'RESERVE';
        const [obligation] = await tx.insert(weeklyItemObligations).values({
          guildId: input.guildId,
          collectionId: collection.id,
          memberId: member.id,
          status: exempt ? 'EXEMPT' : 'UNPAID',
          exemptionReason: exempt ? WEEKLY_ITEMS_RESERVE_EXEMPTION_REASON : null,
          createdAt: input.now,
          updatedAt: input.now,
        }).returning();
        if (obligation === undefined) throw new Error('Weekly item obligation creation did not return a row');
        await tx.insert(weeklyItemObligationItems).values(input.requirements.map((requirement) => ({
          obligationId: obligation.id,
          itemId: requirement.itemId,
          quantity: requirement.requiredQuantity,
        })));
      }
      await queueJob(tx, input.guildId, 'WEEKLY_ITEMS_PUBLISH', collection.id, input.now, 'publish');
      if (input.requirements.some(hasPenalty)) {
        await queueJob(tx, input.guildId, 'WEEKLY_ITEMS_PENALTY', collection.id, collection.firstPenaltyAt, 'penalty:0');
      }
      await writeAudit(tx, {
        guildId: input.guildId,
        actorDiscordUserId: input.actorDiscordUserId,
        action: 'WEEKLY_ITEMS_COLLECTION_CREATED',
        entityType: 'WEEKLY_ITEM_COLLECTION',
        entityId: collection.id,
        after: { collection, requirements: input.requirements },
      });
      return collection.id;
    });
    return this.get(input.guildId, collectionId);
  }

  public async list(guildId: string, limit = 25): Promise<WeeklyItemCollectionView[]> {
    const collections = await this.db.select({ id: weeklyItemCollections.id }).from(weeklyItemCollections)
      .where(eq(weeklyItemCollections.guildId, guildId)).orderBy(desc(weeklyItemCollections.createdAt)).limit(limit);
    return Promise.all(collections.map(({ id }) => this.get(guildId, id)));
  }

  public async get(guildId: string, collectionId: string): Promise<WeeklyItemCollectionView> {
    const [collection] = await this.db.select().from(weeklyItemCollections).where(and(
      eq(weeklyItemCollections.guildId, guildId), eq(weeklyItemCollections.id, collectionId),
    )).limit(1);
    if (collection === undefined) throw new NotFoundError('ไม่พบรอบส่งของประจำสัปดาห์');
    const requirements = await this.db.select({ requirement: weeklyItemRequirements, item: inventoryItems })
      .from(weeklyItemRequirements).innerJoin(inventoryItems, eq(weeklyItemRequirements.itemId, inventoryItems.id))
      .where(eq(weeklyItemRequirements.collectionId, collectionId)).orderBy(asc(inventoryItems.itemCode));
    const obligationRows = await this.db.select({ obligation: weeklyItemObligations, member: members })
      .from(weeklyItemObligations).innerJoin(members, eq(weeklyItemObligations.memberId, members.id))
      .where(eq(weeklyItemObligations.collectionId, collectionId)).orderBy(asc(members.inGameName));
    const obligations = await Promise.all(obligationRows.map(async ({ obligation, member }) => ({
      obligation,
      member: { id: member.id, discordUserId: member.discordUserId, inGameName: member.inGameName },
      items: await this.getObligationItems(obligation.id),
    })));
    return { collection, requirements, obligations };
  }

  public async prepareSubmission(guildId: string, collectionId: string, discordUserId: string): Promise<WeeklyItemObligationView> {
    const view = await this.get(guildId, collectionId);
    if (view.collection.isClosed || view.collection.cancelledAt !== null) throw new ConflictError('รอบส่งของนี้ปิดแล้ว');
    const obligation = view.obligations.find((candidate) => candidate.member.discordUserId === discordUserId);
    if (obligation === undefined) throw new AuthorizationError('คุณไม่มีรายการส่งของในรอบนี้');
    if (obligation.obligation.status === 'EXEMPT') throw new ConflictError('คุณได้รับการยกเว้นในรอบนี้');
    if (obligation.obligation.status === 'PENDING_VERIFICATION') throw new ConflictError('หลักฐานกำลังรอตรวจสอบ');
    if (obligation.obligation.status === 'FULFILLED') throw new ConflictError('คุณส่งของรอบนี้ครบแล้ว');
    return obligation;
  }

  public async persistProof(input: PersistWeeklyItemProofInput): Promise<WeeklyItemProofView> {
    const proofId = await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(weeklyItemProofs).where(and(
        eq(weeklyItemProofs.guildId, input.guildId), eq(weeklyItemProofs.requestId, input.requestId),
      )).limit(1);
      if (existing !== undefined) return existing.id;
      const [context] = await tx.select({ obligation: weeklyItemObligations, member: members, collection: weeklyItemCollections })
        .from(weeklyItemObligations)
        .innerJoin(members, eq(weeklyItemObligations.memberId, members.id))
        .innerJoin(weeklyItemCollections, eq(weeklyItemObligations.collectionId, weeklyItemCollections.id))
        .where(and(
          eq(weeklyItemObligations.guildId, input.guildId),
          eq(weeklyItemObligations.collectionId, input.collectionId),
          eq(members.discordUserId, input.submittedByDiscordUserId),
        )).limit(1).for('update');
      if (context === undefined) throw new AuthorizationError('คุณไม่มีรายการส่งของในรอบนี้');
      if (context.collection.isClosed || context.collection.cancelledAt !== null) throw new ConflictError('รอบส่งของนี้ปิดแล้ว');
      if (context.obligation.status !== 'UNPAID') throw new ConflictError('รายการนี้ส่งหลักฐานแล้วหรือได้รับการยกเว้น');
      const items = await tx.select().from(weeklyItemObligationItems)
        .where(eq(weeklyItemObligationItems.obligationId, context.obligation.id)).for('update');
      if (items.length === 0) throw new ConflictError('รายการส่งของไม่มีสิ่งของที่กำหนด');
      const [proof] = await tx.insert(weeklyItemProofs).values({
        id: input.proofId,
        guildId: input.guildId,
        requestId: input.requestId,
        obligationId: context.obligation.id,
        submittedByDiscordUserId: input.submittedByDiscordUserId,
        attachmentId: input.attachmentId,
        logChannelId: input.logChannelId,
        logMessageId: input.logMessageId,
        submittedAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      }).returning();
      if (proof === undefined) throw new Error('Weekly item proof creation did not return a row');
      await tx.insert(weeklyItemProofItems).values(items.map((item) => ({
        proofId: proof.id, itemId: item.itemId, quantity: item.quantity,
      })));
      await tx.update(weeklyItemObligations).set({ status: 'PENDING_VERIFICATION', updatedAt: input.now })
        .where(eq(weeklyItemObligations.id, context.obligation.id));
      await queueRefresh(tx, input.guildId, input.collectionId, input.now);
      await writeAudit(tx, {
        guildId: input.guildId,
        actorDiscordUserId: input.submittedByDiscordUserId,
        action: 'WEEKLY_ITEMS_PROOF_SUBMITTED',
        entityType: 'WEEKLY_ITEM_PROOF',
        entityId: proof.id,
        after: proof,
      });
      return proof.id;
    });
    return this.getProof(input.guildId, proofId);
  }

  public async getProof(guildId: string, proofId: string): Promise<WeeklyItemProofView> {
    const [context] = await this.db.select({
      proof: weeklyItemProofs,
      obligation: weeklyItemObligations,
      collection: weeklyItemCollections,
      member: members,
    }).from(weeklyItemProofs)
      .innerJoin(weeklyItemObligations, eq(weeklyItemProofs.obligationId, weeklyItemObligations.id))
      .innerJoin(weeklyItemCollections, eq(weeklyItemObligations.collectionId, weeklyItemCollections.id))
      .innerJoin(members, eq(weeklyItemObligations.memberId, members.id))
      .where(and(eq(weeklyItemProofs.guildId, guildId), eq(weeklyItemProofs.id, proofId))).limit(1);
    if (context === undefined) throw new NotFoundError('ไม่พบหลักฐานส่งของประจำสัปดาห์');
    const rows = await this.db.select({ proofItem: weeklyItemProofItems, item: inventoryItems })
      .from(weeklyItemProofItems).innerJoin(inventoryItems, eq(weeklyItemProofItems.itemId, inventoryItems.id))
      .where(eq(weeklyItemProofItems.proofId, proofId)).orderBy(asc(inventoryItems.itemCode));
    return {
      proof: context.proof,
      collection: context.collection,
      obligation: context.obligation,
      member: { id: context.member.id, discordUserId: context.member.discordUserId, inGameName: context.member.inGameName },
      items: rows.map(({ proofItem, item }) => ({ item, quantity: proofItem.quantity })),
    };
  }

  public async approveProof(guildId: string, proofId: string, actorDiscordUserId: string, now: Date): Promise<WeeklyItemProofView> {
    await this.db.transaction(async (tx) => {
      await lockInventoryGuild(tx, guildId);
      const proof = await lockProof(tx, guildId, proofId);
      if (proof.status === 'APPROVED') return;
      if (proof.status !== 'PENDING') throw new ConflictError('หลักฐานนี้ถูกดำเนินการแล้ว');
      const [obligationContext] = await tx.select({ collectionId: weeklyItemObligations.collectionId })
        .from(weeklyItemObligations).where(eq(weeklyItemObligations.id, proof.obligationId)).limit(1);
      if (obligationContext === undefined) throw new NotFoundError('ไม่พบรายการส่งของของสมาชิก');
      await lockCollection(tx, guildId, obligationContext.collectionId);
      const [obligation] = await tx.select().from(weeklyItemObligations)
        .where(eq(weeklyItemObligations.id, proof.obligationId)).limit(1).for('update');
      if (obligation === undefined) throw new NotFoundError('ไม่พบรายการส่งของของสมาชิก');
      if (obligation.status !== 'PENDING_VERIFICATION') throw new ConflictError('สถานะรายการส่งของไม่ตรงกับหลักฐาน');
      const rows = await tx.select({ proofItem: weeklyItemProofItems, item: inventoryItems })
        .from(weeklyItemProofItems).innerJoin(inventoryItems, eq(weeklyItemProofItems.itemId, inventoryItems.id))
        .where(eq(weeklyItemProofItems.proofId, proof.id)).for('update');
      if (rows.length === 0) throw new ConflictError('หลักฐานนี้ไม่มีรายการสิ่งของ');
      const [batch] = await tx.insert(inventoryBatches).values({
        guildId,
        batchRef: `WEEKLY-ITEM-${proof.id}`,
        sourceType: 'WEEKLY_ITEM',
        sourceId: proof.id,
        originalAttachmentId: proof.attachmentId,
        publicChannelId: proof.logChannelId,
        publicMessageId: proof.logMessageId,
        reason: 'รับของจากรอบส่งของประจำสัปดาห์',
        createdByDiscordUserId: actorDiscordUserId,
        createdAt: now,
        updatedAt: now,
      }).returning();
      if (batch === undefined) throw new Error('Weekly item inventory batch creation did not return a row');
      await applyInventoryDeltasWithTransaction(tx, {
        guildId,
        batchId: batch.id,
        action: 'DEPOSIT',
        deltas: rows.map(({ proofItem, item }) => ({ item, quantityChange: proofItem.quantity })),
        now,
      });
      await tx.update(weeklyItemProofs).set({
        status: 'APPROVED', inventoryBatchId: batch.id, decidedAt: now,
        decidedByDiscordUserId: actorDiscordUserId, updatedAt: now,
      }).where(eq(weeklyItemProofs.id, proof.id));
      await tx.update(weeklyItemObligations).set({
        status: 'FULFILLED', fulfilledAt: now, decidedAt: now,
        decidedByDiscordUserId: actorDiscordUserId, updatedAt: now,
      }).where(eq(weeklyItemObligations.id, obligation.id));
      await queueStockBatchPublish(tx, guildId, batch.id, now);
      await queueStockRefresh(tx, guildId, now);
      await queueProofRefresh(tx, guildId, proof.id, now);
      await queueRefresh(tx, guildId, obligation.collectionId, now);
      await closeIfComplete(tx, guildId, obligation.collectionId, now);
      await writeAudit(tx, {
        guildId,
        actorDiscordUserId,
        action: 'WEEKLY_ITEMS_PROOF_APPROVED',
        entityType: 'WEEKLY_ITEM_PROOF',
        entityId: proof.id,
        before: proof,
        after: { status: 'APPROVED', inventoryBatchId: batch.id },
      });
    });
    return this.getProof(guildId, proofId);
  }

  public async rejectProof(
    guildId: string,
    proofId: string,
    actorDiscordUserId: string,
    reason: string,
    now: Date,
  ): Promise<WeeklyItemProofView> {
    const rejectionReason = requireText(reason, 'เหตุผลที่ปฏิเสธ', 2, 500);
    await this.db.transaction(async (tx) => {
      const proof = await lockProof(tx, guildId, proofId);
      if (proof.status === 'REJECTED') return;
      if (proof.status !== 'PENDING') throw new ConflictError('หลักฐานนี้ถูกดำเนินการแล้ว');
      const [obligationContext] = await tx.select({ collectionId: weeklyItemObligations.collectionId })
        .from(weeklyItemObligations).where(eq(weeklyItemObligations.id, proof.obligationId)).limit(1);
      if (obligationContext === undefined) throw new NotFoundError('ไม่พบรายการส่งของของสมาชิก');
      const collection = await lockCollection(tx, guildId, obligationContext.collectionId);
      const [obligation] = await tx.select().from(weeklyItemObligations)
        .where(eq(weeklyItemObligations.id, proof.obligationId)).limit(1).for('update');
      if (obligation === undefined) throw new NotFoundError('ไม่พบรายการส่งของของสมาชิก');
      await tx.update(weeklyItemProofs).set({
        status: 'REJECTED', rejectionReason, decidedAt: now,
        decidedByDiscordUserId: actorDiscordUserId, updatedAt: now,
      }).where(eq(weeklyItemProofs.id, proof.id));
      await tx.update(weeklyItemObligations).set({ status: 'UNPAID', updatedAt: now })
        .where(eq(weeklyItemObligations.id, obligation.id));
      await synchronizeObligationQuantities(tx, obligation.id, obligation.collectionId, collection.penaltyRunCount);
      await queueProofRefresh(tx, guildId, proof.id, now);
      await queueRefresh(tx, guildId, obligation.collectionId, now);
      await writeAudit(tx, {
        guildId,
        actorDiscordUserId,
        action: 'WEEKLY_ITEMS_PROOF_REJECTED',
        entityType: 'WEEKLY_ITEM_PROOF',
        entityId: proof.id,
        before: proof,
        after: { status: 'REJECTED', rejectionReason },
        reason: rejectionReason,
      });
    });
    return this.getProof(guildId, proofId);
  }

  public async setMemberRule(
    guildId: string,
    collectionId: string,
    memberDiscordUserId: string,
    rule: WeeklyItemMemberRule,
    exemptionReason: string | null,
    actorDiscordUserId: string,
    now: Date,
  ): Promise<WeeklyItemCollectionView> {
    const reason = rule === 'EXEMPT'
      ? exemptionReason === null || exemptionReason.trim().length === 0
        ? WEEKLY_ITEMS_ADMIN_EXEMPTION_REASON
        : requireText(exemptionReason, 'เหตุผลยกเว้น', 2, 200)
      : null;
    await this.db.transaction(async (tx) => {
      const collection = await lockCollection(tx, guildId, collectionId);
      ensureCollectionOpen(collection);
      const [row] = await tx.select({ obligation: weeklyItemObligations }).from(weeklyItemObligations)
        .innerJoin(members, eq(weeklyItemObligations.memberId, members.id))
        .where(and(eq(weeklyItemObligations.collectionId, collectionId), eq(members.discordUserId, memberDiscordUserId)))
        .limit(1).for('update');
      if (row === undefined) throw new NotFoundError('สมาชิกนี้ไม่ได้อยู่ในรอบส่งของ');
      if (row.obligation.status !== 'UNPAID' && row.obligation.status !== 'EXEMPT') {
        throw new ConflictError('แก้ไขได้เฉพาะสมาชิกที่ยังไม่ส่งหลักฐานหรือได้รับการยกเว้น');
      }
      await tx.update(weeklyItemObligations).set(rule === 'EXEMPT'
        ? { status: 'EXEMPT', exemptionReason: reason, decidedAt: now, decidedByDiscordUserId: actorDiscordUserId, updatedAt: now }
        : { status: 'UNPAID', exemptionReason: null, decidedAt: null, decidedByDiscordUserId: null, updatedAt: now })
        .where(eq(weeklyItemObligations.id, row.obligation.id));
      if (rule === 'REQUIRED') {
        await synchronizeObligationQuantities(tx, row.obligation.id, collectionId, collection.penaltyRunCount);
      }
      await queueRefresh(tx, guildId, collectionId, now);
      await writeAudit(tx, {
        guildId,
        actorDiscordUserId,
        action: rule === 'EXEMPT' ? 'WEEKLY_ITEMS_MEMBER_EXEMPTED' : 'WEEKLY_ITEMS_MEMBER_REQUIRED',
        entityType: 'WEEKLY_ITEM_OBLIGATION',
        entityId: row.obligation.id,
        before: row.obligation,
        after: { status: rule === 'EXEMPT' ? 'EXEMPT' : 'UNPAID', exemptionReason: reason },
        ...(reason === null ? {} : { reason }),
      });
    });
    return this.get(guildId, collectionId);
  }

  public async processPenalty(guildId: string, collectionId: string, now: Date): Promise<WeeklyItemCollectionView> {
    await this.db.transaction(async (tx) => {
      const collection = await lockCollection(tx, guildId, collectionId);
      if (collection.isClosed || collection.cancelledAt !== null) return;
      if (now < collection.firstPenaltyAt) return;
      const requirements = await tx.select().from(weeklyItemRequirements)
        .where(eq(weeklyItemRequirements.collectionId, collectionId)).for('update');
      const elapsedDays = Math.floor((now.getTime() - collection.firstPenaltyAt.getTime()) / 86_400_000);
      const targetRunCount = elapsedDays + 1;
      const penaltyRun = collection.penaltyRunCount;
      if (targetRunCount <= penaltyRun) return;
      const deltaByItem = new Map(requirements.map((requirement) => [
        requirement.itemId,
        (penaltyRun === 0 ? requirement.initialPenaltyQuantity : 0)
          + (targetRunCount - Math.max(1, penaltyRun)) * requirement.recurringPenaltyQuantity,
      ]));
      const unpaid = await tx.select().from(weeklyItemObligations).where(and(
        eq(weeklyItemObligations.collectionId, collectionId), eq(weeklyItemObligations.status, 'UNPAID'),
      )).for('update');
      for (const obligation of unpaid) {
        const rows = await tx.select().from(weeklyItemObligationItems)
          .where(eq(weeklyItemObligationItems.obligationId, obligation.id)).for('update');
        for (const row of rows) {
          const delta = deltaByItem.get(row.itemId) ?? 0;
          if (delta === 0) continue;
          const quantity = row.quantity + delta;
          if (!Number.isSafeInteger(quantity)) throw new ConflictError('จำนวนค่าปรับสิ่งของเกินขอบเขตที่ระบบรองรับ');
          await tx.update(weeklyItemObligationItems).set({ quantity }).where(and(
            eq(weeklyItemObligationItems.obligationId, row.obligationId),
            eq(weeklyItemObligationItems.itemId, row.itemId),
          ));
        }
      }
      const nextRunCount = targetRunCount;
      await tx.update(weeklyItemCollections).set({ penaltyRunCount: nextRunCount, updatedAt: now })
        .where(eq(weeklyItemCollections.id, collectionId));
      await queueRefresh(tx, guildId, collectionId, now);
      if (requirements.some((requirement) => requirement.recurringPenaltyQuantity > 0)) {
        await queueJob(
          tx,
          guildId,
          'WEEKLY_ITEMS_PENALTY',
          collectionId,
          new Date(collection.firstPenaltyAt.getTime() + nextRunCount * 86_400_000),
          `penalty:${nextRunCount.toString()}`,
        );
      }
      await writeAudit(tx, {
        guildId,
        actorDiscordUserId: SYSTEM_ACTOR,
        action: penaltyRun === 0 ? 'WEEKLY_ITEMS_INITIAL_PENALTY_APPLIED' : 'WEEKLY_ITEMS_RECURRING_PENALTY_APPLIED',
        entityType: 'WEEKLY_ITEM_COLLECTION',
        entityId: collectionId,
        before: { penaltyRunCount: penaltyRun },
        after: { penaltyRunCount: nextRunCount, affectedObligations: unpaid.length },
      });
    });
    return this.get(guildId, collectionId);
  }

  public async cancelCollection(
    guildId: string,
    collectionId: string,
    actorDiscordUserId: string,
    reason: string,
    now: Date,
  ): Promise<WeeklyItemCollectionView> {
    const cancellationReason = requireText(reason, 'เหตุผลยกเลิกรอบ', 2, 500);
    await this.db.transaction(async (tx) => {
      const collection = await lockCollection(tx, guildId, collectionId);
      if (collection.cancelledAt !== null) return;
      if (collection.isClosed) throw new ConflictError('รอบส่งของนี้ปิดแล้ว');
      const [pending] = await tx.select({ id: weeklyItemProofs.id }).from(weeklyItemProofs)
        .innerJoin(weeklyItemObligations, eq(weeklyItemProofs.obligationId, weeklyItemObligations.id))
        .where(and(eq(weeklyItemObligations.collectionId, collectionId), eq(weeklyItemProofs.status, 'PENDING'))).limit(1);
      if (pending !== undefined) throw new ConflictError('ยังมีหลักฐานรอตรวจสอบ กรุณาอนุมัติหรือปฏิเสธก่อนยกเลิกรอบ');
      await tx.update(weeklyItemCollections).set({
        isClosed: true,
        cancelledAt: now,
        cancelledByDiscordUserId: actorDiscordUserId,
        cancellationReason,
        updatedAt: now,
      }).where(eq(weeklyItemCollections.id, collectionId));
      await tx.update(scheduledJobs).set({ status: 'CANCELLED', updatedAt: now }).where(and(
        eq(scheduledJobs.guildId, guildId),
        eq(scheduledJobs.status, 'PENDING'),
        eq(scheduledJobs.jobType, 'WEEKLY_ITEMS_PENALTY'),
        like(scheduledJobs.deduplicationKey, `weekly-items:${collectionId}:penalty:%`),
      ));
      await queueRefresh(tx, guildId, collectionId, now);
      await writeAudit(tx, {
        guildId,
        actorDiscordUserId,
        action: 'WEEKLY_ITEMS_COLLECTION_CANCELLED',
        entityType: 'WEEKLY_ITEM_COLLECTION',
        entityId: collectionId,
        before: collection,
        after: { isClosed: true, cancellationReason },
        reason: cancellationReason,
      });
    });
    return this.get(guildId, collectionId);
  }

  public async markPublished(guildId: string, collectionId: string, channelId: string, messageId: string): Promise<void> {
    await this.db.update(weeklyItemCollections).set({ publicChannelId: channelId, publicMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(weeklyItemCollections.guildId, guildId), eq(weeklyItemCollections.id, collectionId)));
  }

  private async getObligationItems(obligationId: string): Promise<WeeklyItemObligationView['items']> {
    const rows = await this.db.select({ obligationItem: weeklyItemObligationItems, item: inventoryItems })
      .from(weeklyItemObligationItems).innerJoin(inventoryItems, eq(weeklyItemObligationItems.itemId, inventoryItems.id))
      .where(eq(weeklyItemObligationItems.obligationId, obligationId)).orderBy(asc(inventoryItems.itemCode));
    return rows.map(({ obligationItem, item }) => ({ item, quantity: obligationItem.quantity }));
  }
}

async function synchronizeObligationQuantities(
  tx: InventoryTransaction,
  obligationId: string,
  collectionId: string,
  penaltyRunCount: number,
): Promise<void> {
  const requirements = await tx.select().from(weeklyItemRequirements)
    .where(eq(weeklyItemRequirements.collectionId, collectionId)).for('update');
  for (const requirement of requirements) {
    const quantity = requirement.requiredQuantity
      + (penaltyRunCount > 0 ? requirement.initialPenaltyQuantity : 0)
      + Math.max(0, penaltyRunCount - 1) * requirement.recurringPenaltyQuantity;
    await tx.update(weeklyItemObligationItems).set({ quantity }).where(and(
      eq(weeklyItemObligationItems.obligationId, obligationId),
      eq(weeklyItemObligationItems.itemId, requirement.itemId),
    ));
  }
}

async function closeIfComplete(tx: InventoryTransaction, guildId: string, collectionId: string, now: Date): Promise<void> {
  const [outstanding] = await tx.select({ id: weeklyItemObligations.id }).from(weeklyItemObligations).where(and(
    eq(weeklyItemObligations.collectionId, collectionId),
    inArray(weeklyItemObligations.status, ['UNPAID', 'PENDING_VERIFICATION']),
  )).limit(1);
  if (outstanding !== undefined) return;
  await tx.update(weeklyItemCollections).set({ isClosed: true, updatedAt: now }).where(eq(weeklyItemCollections.id, collectionId));
  await tx.update(scheduledJobs).set({ status: 'CANCELLED', updatedAt: now }).where(and(
    eq(scheduledJobs.guildId, guildId),
    eq(scheduledJobs.status, 'PENDING'),
    eq(scheduledJobs.jobType, 'WEEKLY_ITEMS_PENALTY'),
    like(scheduledJobs.deduplicationKey, `weekly-items:${collectionId}:penalty:%`),
  ));
}

async function lockCollection(
  tx: InventoryTransaction,
  guildId: string,
  collectionId: string,
): Promise<WeeklyItemCollection> {
  const [collection] = await tx.select().from(weeklyItemCollections).where(and(
    eq(weeklyItemCollections.guildId, guildId), eq(weeklyItemCollections.id, collectionId),
  )).limit(1).for('update');
  if (collection === undefined) throw new NotFoundError('ไม่พบรอบส่งของประจำสัปดาห์');
  return collection;
}

async function lockProof(tx: InventoryTransaction, guildId: string, proofId: string): Promise<WeeklyItemProof> {
  const [proof] = await tx.select().from(weeklyItemProofs).where(and(
    eq(weeklyItemProofs.guildId, guildId), eq(weeklyItemProofs.id, proofId),
  )).limit(1).for('update');
  if (proof === undefined) throw new NotFoundError('ไม่พบหลักฐานส่งของประจำสัปดาห์');
  return proof;
}

function ensureCollectionOpen(collection: WeeklyItemCollection): void {
  if (collection.isClosed || collection.cancelledAt !== null) throw new ConflictError('แก้ไขได้เฉพาะรอบส่งของที่ยังเปิดอยู่');
}

function validateRequirements(requirements: readonly WeeklyItemRequirementInput[]): void {
  if (requirements.length < 1 || requirements.length > 10) throw new ValidationError('ต้องกำหนดสิ่งของ 1–10 รายการ');
  if (new Set(requirements.map((requirement) => requirement.itemId)).size !== requirements.length) {
    throw new ValidationError('มีรายการสิ่งของซ้ำกัน');
  }
  for (const requirement of requirements) {
    validateQuantity(requirement.requiredQuantity, 'จำนวนที่ต้องส่ง', false);
    validateQuantity(requirement.initialPenaltyQuantity, 'ค่าปรับครั้งแรก', true);
    validateQuantity(requirement.recurringPenaltyQuantity, 'ค่าปรับทุก 24 ชั่วโมง', true);
  }
}

function validateQuantity(value: number, label: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ValidationError(`${label}ต้องเป็นจำนวนเต็ม${allowZero ? 'ตั้งแต่ 0' : 'มากกว่า 0'}`);
  }
}

function hasPenalty(requirement: WeeklyItemRequirementInput): boolean {
  return requirement.initialPenaltyQuantity > 0 || requirement.recurringPenaltyQuantity > 0;
}

function parseLocalDateStart(value: string, timezone: string, label: string): DateTime {
  const parsed = DateTime.fromISO(value, { zone: timezone }).startOf('day');
  if (!parsed.isValid || parsed.toISODate() !== value) throw new ValidationError(`${label}ไม่ถูกต้อง`);
  return parsed;
}

function requireText(value: string, label: string, minLength: number, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new ValidationError(`${label}ต้องมี ${minLength.toString()}–${maxLength.toString()} ตัวอักษร`);
  }
  return normalized;
}

async function queueJob(
  tx: InventoryTransaction,
  guildId: string,
  jobType: string,
  collectionId: string,
  runAt: Date,
  suffix: string,
): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType,
    deduplicationKey: `weekly-items:${collectionId}:${suffix}`,
    payload: { collectionId },
    runAt,
  }).onConflictDoNothing();
}

async function queueRefresh(tx: InventoryTransaction, guildId: string, collectionId: string, runAt: Date): Promise<void> {
  await queueJob(tx, guildId, 'WEEKLY_ITEMS_REFRESH', collectionId, runAt, `refresh:${randomUUID()}`);
}

async function queueProofRefresh(tx: InventoryTransaction, guildId: string, proofId: string, runAt: Date): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'WEEKLY_ITEMS_PROOF_REFRESH',
    deduplicationKey: `weekly-items-proof:${proofId}:refresh:${randomUUID()}`,
    payload: { proofId },
    runAt,
  });
}
