import { and, eq } from 'drizzle-orm';
import { AuthorizationError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import {
  finePaymentProofs,
  guildSettings,
  members,
  scheduledJobs,
  treasuryEntries,
} from '../../src/infrastructure/db/schema.js';
import { FineService, type FinePaymentProofView, type FineView } from '../../src/modules/fines/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('FineService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: FineService;
  let created: FineView;
  let firstProof: FinePaymentProofView;
  const guildId = 'fine-integration-guild';
  const alpha = '300000000000000001';
  const beta = '300000000000000002';
  const dueAt = new Date('2026-08-28T16:00:00.000Z');

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new FineService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId });
    await db.insert(members).values([
      { guildId, discordUserId: alpha, inGameName: 'Alpha', status: 'ACTIVE' },
      { guildId, discordUserId: beta, inGameName: 'Beta', status: 'ACTIVE' },
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates an idempotent fine with durable publish and surcharge jobs', async () => {
    const input = {
      guildId,
      requestId: 'fine-create-1',
      memberDiscordUserId: alpha,
      reason: 'ไม่ทำตามกฎแก๊ง',
      principalAmount: 100_000,
      surchargeAmount: 50_000,
      dueAt,
      actorDiscordUserId: beta,
      now: new Date('2026-08-27T16:00:00.000Z'),
    } as const;
    created = await service.create(input);
    const duplicate = await service.create(input);
    expect(duplicate.fine.id).toBe(created.fine.id);
    expect(created.fine.status).toBe('UNPAID');

    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(jobs.filter((job) => (job.payload as { fineId?: string }).fineId === created.fine.id).map((job) => job.jobType).sort()).toEqual([
      'FINE_PUBLISH',
      'FINE_SURCHARGE',
    ]);
  });

  it('accrues at the due time and blocks another member from paying', async () => {
    created = await service.processSurcharge(guildId, created.fine.id, dueAt);
    expect(created.fine.accruedSurchargeAmount).toBe(50_000);
    expect(created.fine.nextSurchargeAt).toEqual(new Date('2026-08-29T16:00:00.000Z'));
    await expect(service.preparePayment(guildId, created.fine.id, beta, 150_000, dueAt)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('persists one full-payment proof and pauses surcharge while pending', async () => {
    const submittedAt = new Date('2026-08-28T16:01:00.000Z');
    const prepared = await service.preparePayment(guildId, created.fine.id, alpha, 150_000, submittedAt);
    firstProof = await service.persistPayment({
      prepared,
      requestId: 'fine-proof-1',
      submittedByDiscordUserId: alpha,
      attachmentId: 'attachment-1',
      logChannelId: 'fine-channel',
      logMessageId: 'proof-message-1',
      now: submittedAt,
    });
    expect(firstProof.fine.status).toBe('PENDING_VERIFICATION');
    expect(firstProof.proof.status).toBe('PENDING');

    const whilePending = await service.processSurcharge(guildId, created.fine.id, new Date('2026-08-30T16:00:00.000Z'));
    expect(whilePending.fine.accruedSurchargeAmount).toBe(50_000);
  });

  it('catches up elapsed surcharges immediately after proof rejection', async () => {
    firstProof = await service.rejectPayment(
      guildId,
      firstProof.proof.id,
      beta,
      'ยอดในรูปไม่ตรง',
      new Date('2026-08-30T16:01:00.000Z'),
    );
    expect(firstProof.proof.status).toBe('REJECTED');
    expect(firstProof.proof.rejectionReason).toBe('ยอดในรูปไม่ตรง');
    expect(firstProof.fine.status).toBe('UNPAID');
    expect(firstProof.fine.accruedSurchargeAmount).toBe(150_000);
    expect(firstProof.fine.principalAmount + firstProof.fine.accruedSurchargeAmount).toBe(250_000);
  });

  it('approves the replacement proof once and adds the full amount to treasury', async () => {
    const submittedAt = new Date('2026-08-30T16:02:00.000Z');
    const prepared = await service.preparePayment(guildId, created.fine.id, alpha, 250_000, submittedAt);
    const proof = await service.persistPayment({
      prepared,
      requestId: 'fine-proof-2',
      submittedByDiscordUserId: alpha,
      attachmentId: 'attachment-2',
      logChannelId: 'fine-channel',
      logMessageId: 'proof-message-2',
      now: submittedAt,
    });
    const approved = await service.approvePayment(guildId, proof.proof.id, beta, new Date('2026-08-30T16:03:00.000Z'));
    const duplicate = await service.approvePayment(guildId, proof.proof.id, beta, new Date('2026-08-30T16:04:00.000Z'));
    expect(approved.fine.status).toBe('PAID');
    expect(duplicate.proof.status).toBe('APPROVED');

    const entries = await db.select().from(treasuryEntries).where(and(
      eq(treasuryEntries.guildId, guildId),
      eq(treasuryEntries.sourceId, proof.proof.id),
    ));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount).toBe(250_000);
    expect(entries[0]?.entryType).toBe('INCOME');
    const proofs = await db.select().from(finePaymentProofs).where(eq(finePaymentProofs.fineId, created.fine.id));
    expect(proofs.map((item) => item.status).sort()).toEqual(['APPROVED', 'REJECTED']);
  });

  it('cancels only an unpaid fine with an audit reason', async () => {
    const cancellable = await service.create({
      guildId,
      requestId: 'fine-create-cancel',
      memberDiscordUserId: beta,
      reason: 'สร้างผิดคน',
      principalAmount: 10_000,
      surchargeAmount: 0,
      dueAt: new Date('2026-09-01T16:00:00.000Z'),
      actorDiscordUserId: alpha,
      now: new Date('2026-08-27T16:00:00.000Z'),
    });
    const cancelled = await service.cancelFine(guildId, cancellable.fine.id, alpha, 'Admin เลือกสมาชิกผิด', new Date('2026-08-27T16:01:00.000Z'));
    expect(cancelled.fine.status).toBe('CANCELLED');
  });
});
