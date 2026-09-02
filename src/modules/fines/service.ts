import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  finePaymentProofs,
  fines,
  members,
  scheduledJobs,
} from '../../infrastructure/db/schema.js';
import { writeAudit } from '../audit/service.js';
import { appendTreasuryEntryWithTransaction } from '../treasury/service.js';
import { calculateFineAccrual, validateFullFinePayment } from './rules.js';

export type Fine = typeof fines.$inferSelect;
export type FinePaymentProof = typeof finePaymentProofs.$inferSelect;

export interface FineView {
  readonly fine: Fine;
  readonly member: {
    readonly id: string;
    readonly discordUserId: string;
    readonly inGameName: string;
  };
  readonly pendingProof: FinePaymentProof | null;
}

export interface FinePaymentProofView {
  readonly proof: FinePaymentProof;
  readonly fine: Fine;
  readonly member: FineView['member'];
}

export interface CreateFineInput {
  readonly guildId: string;
  readonly requestId: string;
  readonly memberDiscordUserId: string;
  readonly reason: string;
  readonly principalAmount: number;
  readonly surchargeAmount: number;
  readonly dueAt: Date;
  readonly actorDiscordUserId: string;
  readonly now: Date;
}

export interface CreateSourcedFineInput {
  readonly guildId: string;
  readonly requestId: string;
  readonly memberId: string;
  readonly reason: string;
  readonly principalAmount: number;
  readonly surchargeAmount: number;
  readonly dueAt: Date;
  readonly nextSurchargeAt: Date;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly actorDiscordUserId: string;
  readonly now: Date;
}

export interface PreparedFinePayment {
  readonly proofId: string;
  readonly fine: Fine;
  readonly member: FineView['member'];
  readonly amount: number;
}

export interface PersistFinePaymentInput {
  readonly prepared: PreparedFinePayment;
  readonly requestId: string;
  readonly submittedByDiscordUserId: string;
  readonly attachmentId: string;
  readonly logChannelId: string;
  readonly logMessageId: string;
  readonly now: Date;
}

export class FineService {
  public constructor(private readonly db: Database) {}

  public async create(input: CreateFineInput): Promise<FineView> {
    validateAmount(input.principalAmount, 'จำนวนค่าปรับ', false);
    validateAmount(input.surchargeAmount, 'ค่าปรับเพิ่มต่อ 24 ชั่วโมง', true);
    const reason = requireText(input.reason, 'เหตุผลค่าปรับ', 2, 500);
    if (input.dueAt <= input.now) {
      throw new ValidationError('กำหนดชำระต้องอยู่ในอนาคต');
    }

    const fine = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(fines)
        .where(and(eq(fines.guildId, input.guildId), eq(fines.requestId, input.requestId)))
        .limit(1);
      if (existing !== undefined) return existing;
      const member = await findActiveMember(tx, input.guildId, input.memberDiscordUserId);
      return createSourcedFineWithTransaction(tx, {
        guildId: input.guildId,
        requestId: input.requestId,
        memberId: member.id,
        reason,
        principalAmount: input.principalAmount,
        surchargeAmount: input.surchargeAmount,
        dueAt: input.dueAt,
        nextSurchargeAt: input.dueAt,
        sourceType: 'MANUAL',
        sourceId: input.requestId,
        actorDiscordUserId: input.actorDiscordUserId,
        now: input.now,
      });
    });
    return this.get(input.guildId, fine.id);
  }

  public async list(guildId: string, limit = 25): Promise<FineView[]> {
    const rows = await this.db
      .select({ fine: fines, member: members })
      .from(fines)
      .innerJoin(members, eq(fines.memberId, members.id))
      .where(eq(fines.guildId, guildId))
      .orderBy(desc(fines.createdAt))
      .limit(limit);
    const pending = await this.db
      .select()
      .from(finePaymentProofs)
      .where(and(eq(finePaymentProofs.guildId, guildId), eq(finePaymentProofs.status, 'PENDING')));
    const pendingByFine = new Map(pending.map((proof) => [proof.fineId, proof]));
    return rows.map((row) => ({
      fine: row.fine,
      member: toMemberIdentity(row.member),
      pendingProof: pendingByFine.get(row.fine.id) ?? null,
    }));
  }

  public async get(guildId: string, fineId: string): Promise<FineView> {
    const [row] = await this.db
      .select({ fine: fines, member: members })
      .from(fines)
      .innerJoin(members, eq(fines.memberId, members.id))
      .where(and(eq(fines.guildId, guildId), eq(fines.id, fineId)))
      .limit(1);
    if (row === undefined) throw new NotFoundError('ไม่พบค่าปรับ');
    const [pendingProof] = await this.db
      .select()
      .from(finePaymentProofs)
      .where(and(eq(finePaymentProofs.fineId, fineId), eq(finePaymentProofs.status, 'PENDING')))
      .limit(1);
    return { fine: row.fine, member: toMemberIdentity(row.member), pendingProof: pendingProof ?? null };
  }

  /** Locks and accrues the fine before Discord uploads the member's evidence image. */
  public async preparePayment(
    guildId: string,
    fineId: string,
    submittedByDiscordUserId: string,
    amount: number,
    now: Date,
  ): Promise<PreparedFinePayment> {
    return this.db.transaction(async (tx) => {
      const fine = await lockFine(tx, guildId, fineId);
      const member = await findFineMember(tx, fine.memberId);
      if (member.discordUserId !== submittedByDiscordUserId) {
        throw new AuthorizationError('ส่งหลักฐานได้เฉพาะสมาชิกที่ถูกปรับ');
      }
      const accrued = await accrueFineWithTransaction(tx, fine, now, submittedByDiscordUserId);
      if (accrued.accruedSurchargeAmount !== fine.accruedSurchargeAmount) {
        await queueFineRefresh(tx, guildId, fineId, now);
      }
      requireFinePayable(accrued);
      validateFullFinePayment(amount, totalDue(accrued));
      return { proofId: randomUUID(), fine: accrued, member: toMemberIdentity(member), amount };
    });
  }

  /** Persists payment only after Discord has durably re-uploaded its single evidence image. */
  public async persistPayment(input: PersistFinePaymentInput): Promise<FinePaymentProofView> {
    const proofId = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(finePaymentProofs)
        .where(and(
          eq(finePaymentProofs.guildId, input.prepared.fine.guildId),
          eq(finePaymentProofs.requestId, input.requestId),
        ))
        .limit(1);
      if (existing !== undefined) return existing.id;

      const fine = await lockFine(tx, input.prepared.fine.guildId, input.prepared.fine.id);
      const member = await findFineMember(tx, fine.memberId);
      if (member.discordUserId !== input.submittedByDiscordUserId) {
        throw new AuthorizationError('ส่งหลักฐานได้เฉพาะสมาชิกที่ถูกปรับ');
      }
      const accrued = await accrueFineWithTransaction(tx, fine, input.now, input.submittedByDiscordUserId);
      requireFinePayable(accrued);
      validateFullFinePayment(input.prepared.amount, totalDue(accrued));

      const [proof] = await tx
        .insert(finePaymentProofs)
        .values({
          id: input.prepared.proofId,
          guildId: fine.guildId,
          requestId: input.requestId,
          fineId: fine.id,
          submittedByDiscordUserId: input.submittedByDiscordUserId,
          amount: input.prepared.amount,
          attachmentId: input.attachmentId,
          logChannelId: input.logChannelId,
          logMessageId: input.logMessageId,
          submittedAt: input.now,
        })
        .returning();
      if (proof === undefined) throw new Error('Fine payment proof creation did not return a row');
      await tx
        .update(fines)
        .set({ status: 'PENDING_VERIFICATION', updatedAt: input.now })
        .where(eq(fines.id, fine.id));
      await queueFineRefresh(tx, fine.guildId, fine.id, input.now);
      await writeFineAudit(tx, fine.guildId, input.submittedByDiscordUserId, 'FINE_PAYMENT_SUBMITTED', 'FINE_PAYMENT_PROOF', proof.id, null, proof);
      return proof.id;
    });
    return this.getProof(input.prepared.fine.guildId, proofId);
  }

  public async approvePayment(
    guildId: string,
    proofId: string,
    actorDiscordUserId: string,
    now: Date,
  ): Promise<FinePaymentProofView> {
    await this.db.transaction(async (tx) => {
      const context = await lockProofContext(tx, guildId, proofId);
      if (context.proof.status === 'APPROVED') return;
      if (context.proof.status !== 'PENDING' || context.fine.status !== 'PENDING_VERIFICATION') {
        throw new ConflictError('หลักฐานนี้ถูกดำเนินการแล้ว');
      }

      await appendTreasuryEntryWithTransaction(tx, {
        guildId,
        entryType: 'INCOME',
        amount: context.proof.amount,
        description: `ชำระค่าปรับ: ${context.fine.reason}`,
        attachmentId: context.proof.attachmentId,
        sourceType: 'FINE_PAYMENT',
        sourceId: context.proof.id,
        createdByDiscordUserId: actorDiscordUserId,
        now,
      });
      await tx
        .update(finePaymentProofs)
        .set({ status: 'APPROVED', decidedAt: now, decidedByDiscordUserId: actorDiscordUserId, updatedAt: now })
        .where(eq(finePaymentProofs.id, proofId));
      await tx
        .update(fines)
        .set({ status: 'PAID', paidAt: now, updatedAt: now })
        .where(eq(fines.id, context.fine.id));
      await queueFineRefresh(tx, guildId, context.fine.id, now);
      await writeFineAudit(tx, guildId, actorDiscordUserId, 'FINE_PAYMENT_APPROVED', 'FINE_PAYMENT_PROOF', proofId, context, { status: 'APPROVED', paidAt: now });
    });
    return this.getProof(guildId, proofId);
  }

  public async rejectPayment(
    guildId: string,
    proofId: string,
    actorDiscordUserId: string,
    reason: string,
    now: Date,
  ): Promise<FinePaymentProofView> {
    const rejectionReason = requireText(reason, 'เหตุผลที่ปฏิเสธ', 2, 500);
    await this.db.transaction(async (tx) => {
      const context = await lockProofContext(tx, guildId, proofId);
      if (context.proof.status !== 'PENDING' || context.fine.status !== 'PENDING_VERIFICATION') {
        throw new ConflictError('หลักฐานนี้ถูกดำเนินการแล้ว');
      }
      await tx
        .update(finePaymentProofs)
        .set({
          status: 'REJECTED',
          decidedAt: now,
          decidedByDiscordUserId: actorDiscordUserId,
          rejectionReason,
          updatedAt: now,
        })
        .where(eq(finePaymentProofs.id, proofId));
      const [unpaid] = await tx
        .update(fines)
        .set({ status: 'UNPAID', updatedAt: now })
        .where(eq(fines.id, context.fine.id))
        .returning();
      if (unpaid === undefined) throw new Error('Fine rejection did not return a row');
      await accrueFineWithTransaction(tx, unpaid, now, actorDiscordUserId);
      await queueFineRefresh(tx, guildId, context.fine.id, now);
      await writeFineAudit(tx, guildId, actorDiscordUserId, 'FINE_PAYMENT_REJECTED', 'FINE_PAYMENT_PROOF', proofId, context.proof, { status: 'REJECTED', rejectionReason }, rejectionReason);
    });
    return this.getProof(guildId, proofId);
  }

  public async processSurcharge(guildId: string, fineId: string, now: Date): Promise<FineView> {
    await this.db.transaction(async (tx) => {
      const fine = await lockFine(tx, guildId, fineId);
      const updated = await accrueFineWithTransaction(tx, fine, now, 'SYSTEM');
      if (updated.status === 'UNPAID') await queueFineSurcharge(tx, updated);
      if (updated.accruedSurchargeAmount !== fine.accruedSurchargeAmount) {
        await queueFineRefresh(tx, guildId, fineId, now);
      }
    });
    return this.get(guildId, fineId);
  }

  public async cancelFine(
    guildId: string,
    fineId: string,
    actorDiscordUserId: string,
    reason: string,
    now: Date,
  ): Promise<FineView> {
    const cancellationReason = requireText(reason, 'เหตุผลที่ยกเลิก', 2, 500);
    await this.db.transaction(async (tx) => {
      const fine = await lockFine(tx, guildId, fineId);
      if (fine.status === 'CANCELLED') return;
      if (fine.status !== 'UNPAID') {
        throw new ConflictError('ยกเลิกได้เฉพาะค่าปรับที่ยังไม่มีหลักฐานรอตรวจและยังไม่ชำระ');
      }
      const [cancelled] = await tx
        .update(fines)
        .set({ status: 'CANCELLED', updatedAt: now })
        .where(eq(fines.id, fineId))
        .returning();
      await queueFineRefresh(tx, guildId, fineId, now);
      await writeFineAudit(tx, guildId, actorDiscordUserId, 'FINE_CANCELLED', 'FINE', fineId, fine, cancelled ?? null, cancellationReason);
    });
    return this.get(guildId, fineId);
  }

  public async getProof(guildId: string, proofId: string): Promise<FinePaymentProofView> {
    const [row] = await this.db
      .select({ proof: finePaymentProofs, fine: fines, member: members })
      .from(finePaymentProofs)
      .innerJoin(fines, eq(finePaymentProofs.fineId, fines.id))
      .innerJoin(members, eq(fines.memberId, members.id))
      .where(and(eq(finePaymentProofs.guildId, guildId), eq(finePaymentProofs.id, proofId)))
      .limit(1);
    if (row === undefined) throw new NotFoundError('ไม่พบหลักฐานชำระค่าปรับ');
    return { proof: row.proof, fine: row.fine, member: toMemberIdentity(row.member) };
  }

  public async markPublished(guildId: string, fineId: string, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(fines)
      .set({ publicChannelId: channelId, publicMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(fines.guildId, guildId), eq(fines.id, fineId)));
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Creates an idempotent fine inside a caller-owned transaction. */
export async function createSourcedFineWithTransaction(
  tx: Transaction,
  input: CreateSourcedFineInput,
): Promise<Fine> {
  validateAmount(input.principalAmount, 'จำนวนค่าปรับ', false);
  validateAmount(input.surchargeAmount, 'ค่าปรับเพิ่มต่อ 24 ชั่วโมง', true);
  const reason = requireText(input.reason, 'เหตุผลค่าปรับ', 2, 500);
  if (input.dueAt > input.nextSurchargeAt) {
    throw new ValidationError('เวลาทบค่าปรับครั้งแรกต้องไม่อยู่ก่อนกำหนดชำระ');
  }

  const [existing] = await tx
    .select()
    .from(fines)
    .where(and(eq(fines.guildId, input.guildId), eq(fines.requestId, input.requestId)))
    .limit(1);
  if (existing !== undefined) return existing;

  const [created] = await tx
    .insert(fines)
    .values({
      guildId: input.guildId,
      requestId: input.requestId,
      memberId: input.memberId,
      reason,
      principalAmount: input.principalAmount,
      surchargeAmount: input.surchargeAmount,
      dueAt: input.dueAt,
      nextSurchargeAt: input.nextSurchargeAt,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      createdByDiscordUserId: input.actorDiscordUserId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (created === undefined) throw new Error('Fine creation did not return a row');

  await queueFinePublish(tx, input.guildId, created.id, input.now);
  await queueFineSurcharge(tx, created);
  await writeFineAudit(tx, input.guildId, input.actorDiscordUserId, 'FINE_CREATED', 'FINE', created.id, null, created);
  return created;
}

async function accrueFineWithTransaction(
  tx: Transaction,
  fine: Fine,
  now: Date,
  actorDiscordUserId: string,
): Promise<Fine> {
  const accrual = calculateFineAccrual({
    principalAmount: fine.principalAmount,
    accruedSurchargeAmount: fine.accruedSurchargeAmount,
    surchargeAmount: fine.surchargeAmount,
    nextSurchargeAt: fine.nextSurchargeAt,
    now,
    status: fine.status,
  });
  if (accrual.intervals === 0) return fine;

  const [updated] = await tx
    .update(fines)
    .set({
      accruedSurchargeAmount: fine.accruedSurchargeAmount + accrual.surchargeToAdd,
      nextSurchargeAt: accrual.nextSurchargeAt,
      updatedAt: now,
    })
    .where(eq(fines.id, fine.id))
    .returning();
  if (updated === undefined) throw new Error('Fine accrual did not return a row');
  await queueFineSurcharge(tx, updated);
  await writeFineAudit(tx, fine.guildId, actorDiscordUserId, 'FINE_SURCHARGE_ACCRUED', 'FINE', fine.id, fine, updated);
  return updated;
}

async function lockFine(tx: Transaction, guildId: string, fineId: string): Promise<Fine> {
  const [fine] = await tx
    .select()
    .from(fines)
    .where(and(eq(fines.guildId, guildId), eq(fines.id, fineId)))
    .limit(1)
    .for('update');
  if (fine === undefined) throw new NotFoundError('ไม่พบค่าปรับ');
  return fine;
}

async function lockProofContext(tx: Transaction, guildId: string, proofId: string) {
  const [proof] = await tx
    .select()
    .from(finePaymentProofs)
    .where(and(eq(finePaymentProofs.guildId, guildId), eq(finePaymentProofs.id, proofId)))
    .limit(1)
    .for('update');
  if (proof === undefined) throw new NotFoundError('ไม่พบหลักฐานชำระค่าปรับ');
  const fine = await lockFine(tx, guildId, proof.fineId);
  return { proof, fine };
}

async function findActiveMember(tx: Transaction, guildId: string, discordUserId: string) {
  const [member] = await tx
    .select()
    .from(members)
    .where(and(eq(members.guildId, guildId), eq(members.discordUserId, discordUserId), eq(members.status, 'ACTIVE')))
    .limit(1);
  if (member === undefined) throw new ValidationError('ผู้ถูกปรับต้องเป็นสมาชิกที่มีสถานะใช้งาน');
  return member;
}

async function findFineMember(tx: Transaction, memberId: string) {
  const [member] = await tx.select().from(members).where(eq(members.id, memberId)).limit(1);
  if (member === undefined) throw new NotFoundError('ไม่พบสมาชิกของค่าปรับ');
  return member;
}

function toMemberIdentity(member: typeof members.$inferSelect): FineView['member'] {
  return { id: member.id, discordUserId: member.discordUserId, inGameName: member.inGameName };
}

function requireFinePayable(fine: Fine): void {
  if (fine.status === 'PENDING_VERIFICATION') throw new ConflictError('มีหลักฐานรอตรวจอยู่แล้ว');
  if (fine.status === 'PAID') throw new ConflictError('ค่าปรับนี้ชำระแล้ว');
  if (fine.status === 'CANCELLED') throw new ConflictError('ค่าปรับนี้ถูกยกเลิกแล้ว');
}

function totalDue(fine: Fine): number {
  return fine.principalAmount + fine.accruedSurchargeAmount;
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

async function queueFinePublish(tx: Transaction, guildId: string, fineId: string, runAt: Date): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'FINE_PUBLISH',
    deduplicationKey: `fine:${fineId}:publish`,
    payload: { fineId },
    runAt,
  }).onConflictDoNothing();
}

async function queueFineRefresh(tx: Transaction, guildId: string, fineId: string, runAt: Date): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'FINE_REFRESH',
    deduplicationKey: `fine:${fineId}:refresh:${randomUUID()}`,
    payload: { fineId },
    runAt,
  });
}

async function queueFineSurcharge(tx: Transaction, fine: Fine): Promise<void> {
  if (fine.surchargeAmount === 0 || fine.status !== 'UNPAID') return;
  await tx.insert(scheduledJobs).values({
    guildId: fine.guildId,
    jobType: 'FINE_SURCHARGE',
    deduplicationKey: `fine:${fine.id}:surcharge:${String(fine.nextSurchargeAt.getTime())}`,
    payload: { fineId: fine.id },
    runAt: fine.nextSurchargeAt,
  }).onConflictDoNothing();
}

async function writeFineAudit(
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
