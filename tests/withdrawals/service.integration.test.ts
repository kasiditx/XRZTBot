import { and, eq } from 'drizzle-orm';
import { AuthorizationError, ConflictError, ValidationError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { guildSettings, inventoryItems, members, scheduledJobs } from '../../src/infrastructure/db/schema.js';
import { InventoryService } from '../../src/modules/inventory/service.js';
import { WithdrawalService } from '../../src/modules/withdrawals/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('WithdrawalService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: WithdrawalService;
  const guildId = `withdrawal-integration-guild-${process.pid.toString()}`;
  const memberUserId = '700000000000000001';
  const formerUserId = '700000000000000002';
  const admin = '700000000000000003';

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new WithdrawalService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId });
    await db.insert(members).values([
      { guildId, discordUserId: memberUserId, inGameName: 'Requester', status: 'ACTIVE' },
      { guildId, discordUserId: formerUserId, inGameName: 'Former', status: 'FORMER' },
    ]);
    const inventory = new InventoryService(db);
    await inventory.applyOpeningCsv({
      guildId,
      content: Buffer.from('item_name,opening_quantity\nRepair Kit,10\nArmor,5'),
      originalAttachmentId: 'opening-attachment',
      publicChannelId: 'stock-channel',
      publicMessageId: 'opening-message',
      actorDiscordUserId: admin,
      now: new Date('2026-08-27T09:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates one idempotent multi-item request for an active member', async () => {
    const input = {
      guildId,
      clientRequestId: 'withdraw-create-1',
      requesterDiscordUserId: memberUserId,
      reason: 'เอาไปใช้ลงไฟต์',
      items: [
        { itemCode: 'MR-001', quantity: 2 },
        { itemCode: 'MR-002', quantity: 3 },
      ],
      now: new Date('2026-08-27T10:00:00.000Z'),
    } as const;
    const created = await service.create(input);
    const duplicate = await service.create(input);
    expect(duplicate.request.id).toBe(created.request.id);
    expect(created.items).toHaveLength(2);
    expect(created.request.status).toBe('PENDING');

    await expect(service.create({ ...input, clientRequestId: 'former-request', requesterDiscordUserId: formerUserId }))
      .rejects.toBeInstanceOf(AuthorizationError);
  });

  it('requires a reason for partial fulfillment and changes nothing on failure', async () => {
    const request = (await service.list(guildId))[0];
    expect(request).toBeDefined();
    await expect(service.fulfill({
      guildId,
      clientRequestId: 'fulfill-no-reason',
      withdrawalRequestId: request!.request.id,
      items: [{ itemCode: 'MR-001', quantity: 1 }],
      partialReason: '',
      actorDiscordUserId: admin,
      now: new Date('2026-08-27T11:00:00.000Z'),
    })).rejects.toBeInstanceOf(ValidationError);
    const stock = await db.select().from(inventoryItems).where(eq(inventoryItems.guildId, guildId));
    expect(stock.find((item) => item.itemCode === 'MR-001')?.quantity).toBe(10);
  });

  it('supports multiple partial payments and finishes the request atomically', async () => {
    const request = (await service.list(guildId))[0];
    expect(request).toBeDefined();
    const partial = await service.fulfill({
      guildId,
      clientRequestId: 'fulfill-partial',
      withdrawalRequestId: request!.request.id,
      items: [{ itemCode: 'MR-001', quantity: 1 }],
      partialReason: 'Armor ยังจัดไม่ครบ',
      actorDiscordUserId: admin,
      now: new Date('2026-08-27T11:10:00.000Z'),
    });
    expect(partial.request.status).toBe('PARTIALLY_FULFILLED');
    expect(partial.items.find(({ item }) => item.itemCode === 'MR-001')?.fulfilledQuantity).toBe(1);
    expect(partial.fulfillments[0]?.fulfilledByDiscordUserId).toBe(admin);

    const completed = await service.fulfill({
      guildId,
      clientRequestId: 'fulfill-complete',
      withdrawalRequestId: request!.request.id,
      items: [
        { itemCode: 'MR-001', quantity: 1 },
        { itemCode: 'MR-002', quantity: 3 },
      ],
      partialReason: '',
      actorDiscordUserId: admin,
      now: new Date('2026-08-27T11:20:00.000Z'),
    });
    expect(completed.request.status).toBe('FULFILLED');
    expect(completed.fulfillments).toHaveLength(2);
    const stock = await db.select().from(inventoryItems).where(eq(inventoryItems.guildId, guildId));
    expect(stock.find((item) => item.itemCode === 'MR-001')?.quantity).toBe(8);
    expect(stock.find((item) => item.itemCode === 'MR-002')?.quantity).toBe(2);

    const duplicate = await service.fulfill({
      guildId,
      clientRequestId: 'fulfill-complete',
      withdrawalRequestId: request!.request.id,
      items: [{ itemCode: 'MR-001', quantity: 1 }],
      partialReason: 'retry',
      actorDiscordUserId: admin,
      now: new Date('2026-08-27T11:21:00.000Z'),
    });
    expect(duplicate.fulfillments).toHaveLength(2);
  });

  it('rejects only a pending request, records the decision, and leaves Stock unchanged', async () => {
    const request = await service.create({
      guildId,
      clientRequestId: 'withdraw-reject-1',
      requesterDiscordUserId: memberUserId,
      reason: 'ขอใช้ทดสอบระบบ',
      items: [{ itemCode: 'MR-001', quantity: 1 }],
      now: new Date('2026-08-27T12:00:00.000Z'),
    });
    const [before] = await db.select().from(inventoryItems).where(and(
      eq(inventoryItems.guildId, guildId),
      eq(inventoryItems.itemCode, 'MR-001'),
    ));
    const rejected = await service.reject({
      guildId,
      withdrawalRequestId: request.request.id,
      actorDiscordUserId: admin,
      reason: 'รายการไม่ตรงกับวัตถุประสงค์',
      now: new Date('2026-08-27T12:05:00.000Z'),
    });

    expect(rejected.request).toMatchObject({
      status: 'CANCELLED',
      decidedByDiscordUserId: admin,
      rejectionReason: 'รายการไม่ตรงกับวัตถุประสงค์',
    });
    expect(rejected.request.decidedAt).toEqual(new Date('2026-08-27T12:05:00.000Z'));
    const [after] = await db.select().from(inventoryItems).where(and(
      eq(inventoryItems.guildId, guildId),
      eq(inventoryItems.itemCode, 'MR-001'),
    ));
    expect(after?.quantity).toBe(before?.quantity);
    await expect(service.fulfill({
      guildId,
      clientRequestId: 'fulfill-rejected',
      withdrawalRequestId: request.request.id,
      items: [{ itemCode: 'MR-001', quantity: 1 }],
      partialReason: '',
      actorDiscordUserId: admin,
      now: new Date('2026-08-27T12:10:00.000Z'),
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it('queues public request and stock refresh jobs', async () => {
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(jobs.some((job) => job.jobType === 'WITHDRAWAL_PUBLISH')).toBe(true);
    expect(jobs.some((job) => job.jobType === 'WITHDRAWAL_REFRESH')).toBe(true);
    expect(jobs.some((job) => job.jobType === 'STOCK_REFRESH')).toBe(true);
    expect(jobs.some((job) => job.jobType === 'STOCK_BATCH_PUBLISH')).toBe(true);
  });
});
