import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { and, desc, eq } from 'drizzle-orm';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  guildSettings,
  members,
  scheduledJobs,
  weeklyCollections,
  weeklyObligations,
  weeklyPaymentProofs,
} from '../../infrastructure/db/schema.js';
import { writeAudit as persistAudit } from '../audit/service.js';
import { createSourcedFineWithTransaction } from '../fines/service.js';
import { appendTreasuryEntryWithTransaction } from '../treasury/service.js';
import { buildWeeklyOverdueFine } from './rules.js';

export type WeeklyCollection = typeof weeklyCollections.$inferSelect;
export type WeeklyObligation = typeof weeklyObligations.$inferSelect;
export type WeeklyPaymentProof = typeof weeklyPaymentProofs.$inferSelect;

export interface WeeklyObligationView {
  readonly obligation: WeeklyObligation;
  readonly member: MemberIdentity;
}

export interface WeeklyCollectionView {
  readonly collection: WeeklyCollection;
  readonly obligations: readonly WeeklyObligationView[];
}

export interface WeeklyPaymentProofView {
  readonly proof: WeeklyPaymentProof;
  readonly collection: WeeklyCollection;
  readonly obligation: WeeklyObligation;
  readonly member: MemberIdentity;
}

export interface CreateWeeklyCollectionInput {
  readonly guildId: string;
  readonly requestId: string;
  readonly title: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly standardAmount: number;
  readonly overdueFineAmount: number;
  readonly recurringFineAmount: number;
  readonly timezone: string;
  readonly actorDiscordUserId: string;
  readonly now: Date;
}

export interface PreparedWeeklyPayment {
  readonly proofId: string;
  readonly collection: WeeklyCollection;
  readonly obligation: WeeklyObligation;
  readonly member: MemberIdentity;
  readonly amount: number;
}

export interface PersistWeeklyPaymentInput {
  readonly prepared: PreparedWeeklyPayment;
  readonly requestId: string;
  readonly submittedByDiscordUserId: string;
  readonly attachmentId: string;
  readonly logChannelId: string;
  readonly logMessageId: string;
  readonly now: Date;
}

interface MemberIdentity {
  readonly id: string;
  readonly discordUserId: string;
  readonly inGameName: string;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class WeeklyDuesService {
  public constructor(private readonly db: Database) {}

  public async create(input: CreateWeeklyCollectionInput): Promise<WeeklyCollectionView> {
    const title = requireText(input.title, 'ชื่อรอบส่งเงิน', 2, 100);
    validateAmount(input.standardAmount, 'ยอดมาตรฐาน', false);
    validateAmount(input.overdueFineAmount, 'ค่าปรับครั้งแรก', true);
    validateAmount(input.recurringFineAmount, 'ค่าปรับทบทุก 24 ชั่วโมง', true);
    const startsAt = parseLocalDateStart(input.startsOn, input.timezone, 'วันที่เริ่ม');
    const conversionAt = parseLocalDateStart(input.endsOn, input.timezone, 'วันที่สิ้นสุด').plus({ days: 1 });
    if (conversionAt <= startsAt) throw new ValidationError('วันที่สิ้นสุดต้องไม่อยู่ก่อนวันที่เริ่ม');
    if (conversionAt.toJSDate() <= input.now) throw new ValidationError('รอบส่งเงินต้องยังไม่หมดเวลา');

    const collectionId = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(weeklyCollections)
        .where(and(eq(weeklyCollections.guildId, input.guildId), eq(weeklyCollections.requestId, input.requestId)))
        .limit(1);
      if (existing !== undefined) return existing.id;

      const activeMembers = await tx
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.guildId, input.guildId), eq(members.status, 'ACTIVE')));
      if (activeMembers.length === 0) throw new ValidationError('ยังไม่มีสมาชิกสถานะใช้งานสำหรับสร้างรอบส่งเงิน');

      const [collection] = await tx
        .insert(weeklyCollections)
        .values({
          guildId: input.guildId,
          requestId: input.requestId,
          title,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          conversionAt: conversionAt.toJSDate(),
          standardAmount: input.standardAmount,
          overdueFineAmount: input.overdueFineAmount,
          recurringFineAmount: input.recurringFineAmount,
          createdByDiscordUserId: input.actorDiscordUserId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (collection === undefined) throw new Error('Weekly collection creation did not return a row');

      await tx.insert(weeklyObligations).values(activeMembers.map((member) => ({
        guildId: input.guildId,
        collectionId: collection.id,
        memberId: member.id,
        amount: input.standardAmount,
        createdAt: input.now,
        updatedAt: input.now,
      })));
      await queueWeeklyJob(tx, input.guildId, 'WEEKLY_PUBLISH', collection.id, input.now, 'publish');
      await queueWeeklyJob(tx, input.guildId, 'WEEKLY_CONVERT', collection.id, collection.conversionAt, 'convert');
      await writeAudit(tx, input.guildId, input.actorDiscordUserId, 'WEEKLY_COLLECTION_CREATED', 'WEEKLY_COLLECTION', collection.id, null, collection);
      return collection.id;
    });
    return this.get(input.guildId, collectionId);
  }

  public async list(guildId: string, limit = 25): Promise<WeeklyCollectionView[]> {
    const collections = await this.db
      .select()
      .from(weeklyCollections)
      .where(eq(weeklyCollections.guildId, guildId))
      .orderBy(desc(weeklyCollections.createdAt))
      .limit(limit);
    return Promise.all(collections.map(async (collection) => this.get(guildId, collection.id)));
  }

  public async get(guildId: string, collectionId: string): Promise<WeeklyCollectionView> {
    const [collection] = await this.db
      .select()
      .from(weeklyCollections)
      .where(and(eq(weeklyCollections.guildId, guildId), eq(weeklyCollections.id, collectionId)))
      .limit(1);
    if (collection === undefined) throw new NotFoundError('ไม่พบรอบส่งเงินรายสัปดาห์');
    const rows = await this.db
      .select({ obligation: weeklyObligations, member: members })
      .from(weeklyObligations)
      .innerJoin(members, eq(weeklyObligations.memberId, members.id))
      .where(eq(weeklyObligations.collectionId, collectionId))
      .orderBy(members.inGameName);
    return {
      collection,
      obligations: rows.map((row) => ({ obligation: row.obligation, member: toMemberIdentity(row.member) })),
    };
  }

  public async overrideAmount(
    guildId: string,
    collectionId: string,
    memberDiscordUserId: string,
    amount: number,
    actorDiscordUserId: string,
    now: Date,
  ): Promise<WeeklyCollectionView> {
    validateAmount(amount, 'ยอดเฉพาะสมาชิก', false);
    await this.db.transaction(async (tx) => {
      const collection = await lockCollection(tx, guildId, collectionId);
      if (collection.isClosed || now >= collection.conversionAt) throw new ConflictError('รอบส่งเงินนี้ปิดแล้ว');
      const [row] = await tx
        .select({ obligation: weeklyObligations })
        .from(weeklyObligations)
        .innerJoin(members, eq(weeklyObligations.memberId, members.id))
        .where(and(
          eq(weeklyObligations.collectionId, collectionId),
          eq(members.discordUserId, memberDiscordUserId),
        ))
        .limit(1)
        .for('update');
      if (row === undefined) throw new NotFoundError('สมาชิกนี้ไม่ได้อยู่ในรอบส่งเงิน');
      if (row.obligation.status !== 'UNPAID') throw new ConflictError('แก้ยอดได้เฉพาะรายการที่ยังไม่ส่งหลักฐาน');
      const [updated] = await tx
        .update(weeklyObligations)
        .set({ amount, updatedAt: now })
        .where(eq(weeklyObligations.id, row.obligation.id))
        .returning();
      await queueWeeklyRefresh(tx, guildId, collectionId, now);
      await writeAudit(tx, guildId, actorDiscordUserId, 'WEEKLY_AMOUNT_OVERRIDDEN', 'WEEKLY_OBLIGATION', row.obligation.id, row.obligation, updated);
    });
    return this.get(guildId, collectionId);
  }

  public async preparePayment(
    guildId: string,
    collectionId: string,
    submittedByDiscordUserId: string,
    amount: number,
    now: Date,
  ): Promise<PreparedWeeklyPayment> {
    validateAmount(amount, 'จำนวนเงิน', false);
    return this.db.transaction(async (tx) => {
      const collection = await lockCollection(tx, guildId, collectionId);
      await requireCollectionOpen(tx, collection, now);
      const [row] = await tx
        .select({ obligation: weeklyObligations, member: members })
        .from(weeklyObligations)
        .innerJoin(members, eq(weeklyObligations.memberId, members.id))
        .where(and(
          eq(weeklyObligations.collectionId, collectionId),
          eq(members.discordUserId, submittedByDiscordUserId),
        ))
        .limit(1)
        .for('update');
      if (row === undefined) throw new AuthorizationError('คุณไม่มีรายการเรียกเก็บในรอบนี้');
      if (row.obligation.status !== 'UNPAID') throw new ConflictError(obligationConflictMessage(row.obligation.status));
      if (amount !== row.obligation.amount) throw new ValidationError(`ต้องส่งเต็มจำนวน ${row.obligation.amount.toLocaleString('th-TH')}`);
      return {
        proofId: randomUUID(),
        collection,
        obligation: row.obligation,
        member: toMemberIdentity(row.member),
        amount,
      };
    });
  }

  public async persistPayment(input: PersistWeeklyPaymentInput): Promise<WeeklyPaymentProofView> {
    const proofId = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(weeklyPaymentProofs)
        .where(and(
          eq(weeklyPaymentProofs.guildId, input.prepared.collection.guildId),
          eq(weeklyPaymentProofs.requestId, input.requestId),
        ))
        .limit(1);
      if (existing !== undefined) return existing.id;

      const collection = await lockCollection(
        tx,
        input.prepared.collection.guildId,
        input.prepared.collection.id,
      );
      const obligation = await lockObligation(tx, input.prepared.collection.guildId, input.prepared.obligation.id);
      if (obligation.collectionId !== collection.id) throw new ConflictError('ยอดเรียกเก็บไม่อยู่ในรอบที่เลือก');
      await requireCollectionOpen(tx, collection, input.now);
      const member = await getMember(tx, obligation.memberId);
      if (member.discordUserId !== input.submittedByDiscordUserId) throw new AuthorizationError('ส่งหลักฐานแทนสมาชิกคนอื่นไม่ได้');
      if (obligation.status !== 'UNPAID') throw new ConflictError(obligationConflictMessage(obligation.status));
      if (obligation.amount !== input.prepared.amount) throw new ConflictError('ยอดเรียกเก็บมีการเปลี่ยนแปลง กรุณาส่งใหม่');

      const [proof] = await tx
        .insert(weeklyPaymentProofs)
        .values({
          id: input.prepared.proofId,
          guildId: collection.guildId,
          requestId: input.requestId,
          obligationId: obligation.id,
          submittedByDiscordUserId: input.submittedByDiscordUserId,
          amount: input.prepared.amount,
          attachmentId: input.attachmentId,
          logChannelId: input.logChannelId,
          logMessageId: input.logMessageId,
          submittedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (proof === undefined) throw new Error('Weekly payment proof creation did not return a row');
      await tx
        .update(weeklyObligations)
        .set({
          status: 'PENDING_VERIFICATION',
          attachmentId: input.attachmentId,
          submittedAt: input.now,
          updatedAt: input.now,
        })
        .where(eq(weeklyObligations.id, obligation.id));
      await queueWeeklyRefresh(tx, collection.guildId, collection.id, input.now);
      await writeAudit(tx, collection.guildId, input.submittedByDiscordUserId, 'WEEKLY_PAYMENT_SUBMITTED', 'WEEKLY_PAYMENT_PROOF', proof.id, null, proof);
      return proof.id;
    });
    return this.getProof(input.prepared.collection.guildId, proofId);
  }

  public async approvePayment(
    guildId: string,
    proofId: string,
    actorDiscordUserId: string,
    now: Date,
  ): Promise<WeeklyPaymentProofView> {
    await this.db.transaction(async (tx) => {
      const context = await lockProofContext(tx, guildId, proofId);
      if (context.proof.status === 'APPROVED') return;
      if (context.proof.status !== 'PENDING' || context.obligation.status !== 'PENDING_VERIFICATION') {
        throw new ConflictError('หลักฐานนี้ถูกดำเนินการแล้ว');
      }
      await appendTreasuryEntryWithTransaction(tx, {
        guildId,
        entryType: 'INCOME',
        amount: context.proof.amount,
        description: `ส่งเงินรายสัปดาห์: ${context.collection.title}`,
        attachmentId: context.proof.attachmentId,
        sourceType: 'WEEKLY_PAYMENT',
        sourceId: context.proof.id,
        createdByDiscordUserId: actorDiscordUserId,
        now,
      });
      await tx
        .update(weeklyPaymentProofs)
        .set({ status: 'APPROVED', decidedAt: now, decidedByDiscordUserId: actorDiscordUserId, updatedAt: now })
        .where(eq(weeklyPaymentProofs.id, proofId));
      await tx
        .update(weeklyObligations)
        .set({ status: 'PAID', decidedAt: now, decidedByDiscordUserId: actorDiscordUserId, rejectionReason: null, updatedAt: now })
        .where(eq(weeklyObligations.id, context.obligation.id));
      await queueWeeklyRefresh(tx, guildId, context.collection.id, now);
      await writeAudit(tx, guildId, actorDiscordUserId, 'WEEKLY_PAYMENT_APPROVED', 'WEEKLY_PAYMENT_PROOF', proofId, context.proof, { status: 'APPROVED' });
    });
    return this.getProof(guildId, proofId);
  }

  public async rejectPayment(
    guildId: string,
    proofId: string,
    actorDiscordUserId: string,
    reason: string,
    now: Date,
  ): Promise<WeeklyPaymentProofView> {
    const rejectionReason = requireText(reason, 'เหตุผลที่ปฏิเสธ', 2, 500);
    await this.db.transaction(async (tx) => {
      const context = await lockProofContext(tx, guildId, proofId);
      if (context.proof.status !== 'PENDING' || context.obligation.status !== 'PENDING_VERIFICATION') {
        throw new ConflictError('หลักฐานนี้ถูกดำเนินการแล้ว');
      }
      await tx
        .update(weeklyPaymentProofs)
        .set({ status: 'REJECTED', decidedAt: now, decidedByDiscordUserId: actorDiscordUserId, rejectionReason, updatedAt: now })
        .where(eq(weeklyPaymentProofs.id, proofId));
      const [unpaid] = await tx
        .update(weeklyObligations)
        .set({ status: 'UNPAID', decidedAt: now, decidedByDiscordUserId: actorDiscordUserId, rejectionReason, updatedAt: now })
        .where(eq(weeklyObligations.id, context.obligation.id))
        .returning();
      if (unpaid === undefined) throw new Error('Weekly payment rejection did not return a row');
      if (now >= context.collection.conversionAt) {
        await convertObligation(tx, context.collection, unpaid, actorDiscordUserId, now);
      }
      await queueWeeklyRefresh(tx, guildId, context.collection.id, now);
      await writeAudit(tx, guildId, actorDiscordUserId, 'WEEKLY_PAYMENT_REJECTED', 'WEEKLY_PAYMENT_PROOF', proofId, context.proof, { status: 'REJECTED', rejectionReason }, rejectionReason);
    });
    return this.getProof(guildId, proofId);
  }

  public async processConversion(guildId: string, collectionId: string, now: Date): Promise<WeeklyCollectionView> {
    await this.db.transaction(async (tx) => {
      const collection = await lockCollection(tx, guildId, collectionId);
      if (now < collection.conversionAt) throw new ConflictError('ยังไม่ถึงเวลาปิดรอบส่งเงิน');
      const unpaid = await tx
        .select()
        .from(weeklyObligations)
        .where(and(eq(weeklyObligations.collectionId, collectionId), eq(weeklyObligations.status, 'UNPAID')))
        .for('update');
      for (const obligation of unpaid) {
        await convertObligation(tx, collection, obligation, 'SYSTEM', now);
      }
      if (!collection.isClosed) {
        await tx.update(weeklyCollections).set({ isClosed: true, updatedAt: now }).where(eq(weeklyCollections.id, collection.id));
        await writeAudit(tx, guildId, 'SYSTEM', 'WEEKLY_COLLECTION_CLOSED', 'WEEKLY_COLLECTION', collection.id, collection, { isClosed: true });
      }
      await queueWeeklyRefresh(tx, guildId, collectionId, now);
    });
    return this.get(guildId, collectionId);
  }

  public async getProof(guildId: string, proofId: string): Promise<WeeklyPaymentProofView> {
    const [row] = await this.db
      .select({ proof: weeklyPaymentProofs, obligation: weeklyObligations, collection: weeklyCollections, member: members })
      .from(weeklyPaymentProofs)
      .innerJoin(weeklyObligations, eq(weeklyPaymentProofs.obligationId, weeklyObligations.id))
      .innerJoin(weeklyCollections, eq(weeklyObligations.collectionId, weeklyCollections.id))
      .innerJoin(members, eq(weeklyObligations.memberId, members.id))
      .where(and(eq(weeklyPaymentProofs.guildId, guildId), eq(weeklyPaymentProofs.id, proofId)))
      .limit(1);
    if (row === undefined) throw new NotFoundError('ไม่พบหลักฐานส่งเงินรายสัปดาห์');
    return { proof: row.proof, obligation: row.obligation, collection: row.collection, member: toMemberIdentity(row.member) };
  }

  public async markPublished(guildId: string, collectionId: string, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(weeklyCollections)
      .set({ publicChannelId: channelId, publicMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(weeklyCollections.guildId, guildId), eq(weeklyCollections.id, collectionId)));
  }
}

async function convertObligation(
  tx: Transaction,
  collection: WeeklyCollection,
  obligation: WeeklyObligation,
  actorDiscordUserId: string,
  now: Date,
): Promise<void> {
  if (obligation.status !== 'UNPAID') return;
  const amounts = buildWeeklyOverdueFine(obligation.amount, collection.overdueFineAmount, collection.recurringFineAmount);
  const fine = await createSourcedFineWithTransaction(tx, {
    guildId: collection.guildId,
    requestId: `weekly:${obligation.id}:fine`,
    memberId: obligation.memberId,
    reason: `ค้างส่งเงินรายสัปดาห์: ${collection.title}`,
    principalAmount: amounts.principalAmount,
    surchargeAmount: amounts.recurringPenaltyAmount,
    dueAt: collection.conversionAt,
    nextSurchargeAt: DateTime.fromJSDate(collection.conversionAt).plus({ hours: 24 }).toJSDate(),
    sourceType: 'WEEKLY_DUES',
    sourceId: obligation.id,
    actorDiscordUserId,
    now,
  });
  await tx
    .update(weeklyObligations)
    .set({ status: 'CONVERTED_TO_FINE', convertedFineId: fine.id, updatedAt: now })
    .where(and(eq(weeklyObligations.id, obligation.id), eq(weeklyObligations.status, 'UNPAID')));
  await writeAudit(tx, collection.guildId, actorDiscordUserId, 'WEEKLY_OBLIGATION_CONVERTED', 'WEEKLY_OBLIGATION', obligation.id, obligation, { status: 'CONVERTED_TO_FINE', fineId: fine.id });
}

async function lockCollection(tx: Transaction, guildId: string, collectionId: string): Promise<WeeklyCollection> {
  const [collection] = await tx
    .select()
    .from(weeklyCollections)
    .where(and(eq(weeklyCollections.guildId, guildId), eq(weeklyCollections.id, collectionId)))
    .limit(1)
    .for('update');
  if (collection === undefined) throw new NotFoundError('ไม่พบรอบส่งเงินรายสัปดาห์');
  return collection;
}

async function lockObligation(tx: Transaction, guildId: string, obligationId: string): Promise<WeeklyObligation> {
  const [obligation] = await tx
    .select()
    .from(weeklyObligations)
    .where(and(eq(weeklyObligations.guildId, guildId), eq(weeklyObligations.id, obligationId)))
    .limit(1)
    .for('update');
  if (obligation === undefined) throw new NotFoundError('ไม่พบยอดเรียกเก็บรายสัปดาห์');
  return obligation;
}

async function lockProofContext(tx: Transaction, guildId: string, proofId: string) {
  const [proof] = await tx
    .select()
    .from(weeklyPaymentProofs)
    .where(and(eq(weeklyPaymentProofs.guildId, guildId), eq(weeklyPaymentProofs.id, proofId)))
    .limit(1)
    .for('update');
  if (proof === undefined) throw new NotFoundError('ไม่พบหลักฐานส่งเงินรายสัปดาห์');
  const [obligationReference] = await tx
    .select({ collectionId: weeklyObligations.collectionId })
    .from(weeklyObligations)
    .where(and(eq(weeklyObligations.guildId, guildId), eq(weeklyObligations.id, proof.obligationId)))
    .limit(1);
  if (obligationReference === undefined) throw new NotFoundError('ไม่พบยอดเรียกเก็บรายสัปดาห์');
  const collection = await lockCollection(tx, guildId, obligationReference.collectionId);
  const obligation = await lockObligation(tx, guildId, proof.obligationId);
  if (obligation.collectionId !== collection.id) throw new ConflictError('ยอดเรียกเก็บไม่อยู่ในรอบของหลักฐาน');
  return { proof, obligation, collection };
}

async function getMember(tx: Transaction, memberId: string) {
  const [member] = await tx.select().from(members).where(eq(members.id, memberId)).limit(1);
  if (member === undefined) throw new NotFoundError('ไม่พบสมาชิกของยอดเรียกเก็บ');
  return member;
}

async function requireCollectionOpen(tx: Transaction, collection: WeeklyCollection, now: Date): Promise<void> {
  if (collection.isClosed || now >= collection.conversionAt) throw new ConflictError('หมดเวลาส่งเงินรอบนี้แล้ว');
  const [settings] = await tx
    .select({ timezone: guildSettings.timezone })
    .from(guildSettings)
    .where(eq(guildSettings.guildId, collection.guildId))
    .limit(1);
  if (settings === undefined) throw new NotFoundError('ไม่พบการตั้งค่า Server');
  const opensAt = parseLocalDateStart(collection.startsOn, settings.timezone, 'วันที่เริ่ม').toJSDate();
  if (now < opensAt) throw new ConflictError('รอบส่งเงินนี้ยังไม่เปิด');
}

function toMemberIdentity(member: typeof members.$inferSelect): MemberIdentity {
  return { id: member.id, discordUserId: member.discordUserId, inGameName: member.inGameName };
}

function parseLocalDateStart(value: string, timezone: string, label: string): DateTime {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new ValidationError(`${label}ต้องเป็น YYYY-MM-DD`);
  const parsed = DateTime.fromISO(value, { zone: timezone }).startOf('day');
  if (!parsed.isValid || parsed.toISODate() !== value) throw new ValidationError(`${label}ไม่ถูกต้อง`);
  return parsed;
}

function validateAmount(value: number, label: string, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ValidationError(`${label}ต้องเป็นจำนวนเต็มตั้งแต่ ${String(minimum)} ขึ้นไป`);
  }
}

function requireText(value: string, label: string, minimum: number, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ValidationError(`${label}ต้องมี ${String(minimum)}–${String(maximum)} ตัวอักษร`);
  }
  return normalized;
}

function obligationConflictMessage(status: WeeklyObligation['status']): string {
  if (status === 'PENDING_VERIFICATION') return 'มีหลักฐานรอตรวจอยู่แล้ว';
  if (status === 'PAID') return 'รายการนี้ชำระแล้ว';
  if (status === 'CONVERTED_TO_FINE') return 'รายการนี้ถูกเปลี่ยนเป็นค่าปรับแล้ว';
  return 'รายการนี้ไม่เปิดให้ส่งหลักฐาน';
}

async function queueWeeklyJob(
  tx: Transaction,
  guildId: string,
  jobType: string,
  collectionId: string,
  runAt: Date,
  key: string,
): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType,
    deduplicationKey: `weekly:${collectionId}:${key}`,
    payload: { collectionId },
    runAt,
  }).onConflictDoNothing();
}

async function queueWeeklyRefresh(tx: Transaction, guildId: string, collectionId: string, runAt: Date): Promise<void> {
  await queueWeeklyJob(tx, guildId, 'WEEKLY_REFRESH', collectionId, runAt, `refresh:${randomUUID()}`);
}

async function writeAudit(
  tx: Transaction,
  guildId: string,
  actorDiscordUserId: string,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason?: string,
): Promise<void> {
  await persistAudit(tx, {
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
