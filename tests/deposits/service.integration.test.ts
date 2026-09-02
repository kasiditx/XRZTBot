import { and, eq } from 'drizzle-orm';
import { AuthorizationError, ConflictError, ValidationError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import {
  depositRequests,
  guildSettings,
  inventoryBatches,
  inventoryItems,
  inventoryMovements,
  members,
  scheduledJobs,
} from '../../src/infrastructure/db/schema.js';
import { DepositService } from '../../src/modules/deposits/service.js';
import { InventoryService } from '../../src/modules/inventory/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('DepositService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: DepositService;
  const guildId = `deposit-integration-guild-${process.pid.toString()}`;
  const memberUserId = '710000000000000001';
  const formerUserId = '710000000000000002';
  const adminUserId = '710000000000000003';

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new DepositService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId });
    await db.insert(members).values([
      { guildId, discordUserId: memberUserId, inGameName: 'Depositor', status: 'ACTIVE' },
      { guildId, discordUserId: formerUserId, inGameName: 'Former', status: 'FORMER' },
    ]);
    await new InventoryService(db).applyOpeningCsv({
      guildId,
      content: Buffer.from('item_name,opening_quantity\nRepair Kit,10\nArmor,5'),
      originalAttachmentId: 'opening-attachment',
      publicChannelId: 'stock-channel',
      publicMessageId: 'opening-message',
      actorDiscordUserId: adminUserId,
      now: new Date('2026-08-27T09:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('prepares only known stock items for an active member', async () => {
    const prepared = await service.prepare(guildId, memberUserId, 'Loop รถส่งของ', [
      { itemName: 'armor', quantity: 2 },
      { itemName: 'Repair Kit', quantity: 3 },
    ]);
    expect(prepared.sender.inGameName).toBe('Depositor');
    expect(prepared.items.map(({ item }) => item.itemCode)).toEqual(['MR-001', 'MR-002']);
    await expect(service.prepare(guildId, formerUserId, 'Airdrop', [{ itemName: 'Repair Kit', quantity: 1 }]))
      .rejects.toBeInstanceOf(AuthorizationError);
    await expect(service.prepare(guildId, memberUserId, 'Airdrop', [{ itemName: 'ของที่ไม่มีใน Stock', quantity: 1 }]))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('persists idempotently and rejection leaves stock unchanged', async () => {
    const prepared = await service.prepare(guildId, memberUserId, 'Airdrop', [{ itemName: 'Repair Kit', quantity: 4 }]);
    const input = {
      prepared,
      clientRequestId: 'deposit-reject-1',
      senderDiscordUserId: memberUserId,
      attachmentId: 'deposit-proof-reject',
      publicChannelId: 'stock-channel',
      publicMessageId: 'deposit-message-reject',
      now: new Date('2026-08-27T10:00:00.000Z'),
    } as const;
    const created = await service.persist(input);
    const duplicate = await service.persist(input);
    expect(duplicate.request.id).toBe(created.request.id);
    expect(created.request.status).toBe('PENDING');

    const rejected = await service.reject(guildId, created.request.id, adminUserId, 'รูปไม่ตรงกับรายการ', new Date('2026-08-27T10:05:00.000Z'));
    const repeated = await service.reject(guildId, created.request.id, adminUserId, 'retry', new Date('2026-08-27T10:06:00.000Z'));
    expect(rejected.request.status).toBe('REJECTED');
    expect(repeated.request.status).toBe('REJECTED');
    expect((await stockQuantity(db, guildId, 'MR-001'))).toBe(10);
    await expect(service.approve(guildId, created.request.id, adminUserId, new Date()))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it('approves one multi-item deposit atomically and is safe under retry', async () => {
    const prepared = await service.prepare(guildId, memberUserId, 'Loop เหมือง', [
      { itemName: 'Repair Kit', quantity: 2 },
      { itemName: 'Armor', quantity: 1 },
    ]);
    const pending = await service.persist({
      prepared,
      clientRequestId: 'deposit-approve-1',
      senderDiscordUserId: memberUserId,
      attachmentId: 'deposit-proof-approve',
      publicChannelId: 'stock-channel',
      publicMessageId: 'deposit-message-approve',
      now: new Date('2026-08-27T11:00:00.000Z'),
    });
    const approvals = await Promise.all([
      service.approve(guildId, pending.request.id, adminUserId, new Date('2026-08-27T11:05:00.000Z')),
      service.approve(guildId, pending.request.id, adminUserId, new Date('2026-08-27T11:05:01.000Z')),
    ]);
    expect(approvals.every(({ request }) => request.status === 'APPROVED')).toBe(true);
    expect(await stockQuantity(db, guildId, 'MR-001')).toBe(12);
    expect(await stockQuantity(db, guildId, 'MR-002')).toBe(6);

    const batches = await db.select().from(inventoryBatches).where(and(
      eq(inventoryBatches.guildId, guildId),
      eq(inventoryBatches.sourceId, pending.request.id),
    ));
    expect(batches).toHaveLength(1);
    expect(batches[0]?.sourceType).toBe('DEPOSIT');
    const movements = await db.select().from(inventoryMovements).where(eq(inventoryMovements.batchId, batches[0]!.id));
    expect(movements).toHaveLength(2);
    expect(movements.every((movement) => movement.action === 'DEPOSIT' && movement.quantityChange > 0)).toBe(true);
  });

  it('stores durable public references and queues a Stock refresh', async () => {
    const [approved] = await db.select().from(depositRequests).where(and(
      eq(depositRequests.guildId, guildId),
      eq(depositRequests.status, 'APPROVED'),
    ));
    expect(approved?.attachmentId).toBe('deposit-proof-approve');
    expect(approved?.publicChannelId).toBe('stock-channel');
    expect(approved?.publicMessageId).toBe('deposit-message-approve');
    const jobs = await db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.guildId, guildId),
      eq(scheduledJobs.jobType, 'STOCK_REFRESH'),
    ));
    expect(jobs.length).toBeGreaterThanOrEqual(2);
  });
});

async function stockQuantity(db: Database, guildId: string, itemCode: string): Promise<number | undefined> {
  const [item] = await db.select().from(inventoryItems).where(and(
    eq(inventoryItems.guildId, guildId),
    eq(inventoryItems.itemCode, itemCode),
  ));
  return item?.quantity;
}
