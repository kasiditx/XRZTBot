import { eq } from 'drizzle-orm';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { guildSettings, inventoryItems, scheduledJobs } from '../../src/infrastructure/db/schema.js';
import { InventoryService } from '../../src/modules/inventory/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('InventoryService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: InventoryService;
  const guildId = 'inventory-integration-guild';
  const actor = '600000000000000001';
  const openingCsv = Buffer.from('item_name,opening_quantity\nRepair Kit,100\nArmor,50\nRadio,0');

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new InventoryService(db);
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('imports opening stock once with generated stable item codes', async () => {
    const opening = await service.applyOpeningCsv(csvInput(guildId, openingCsv, actor, 'opening'));
    expect(opening.movements).toHaveLength(2);
    const dashboard = await service.getDashboard(guildId, 1, 2);
    expect(dashboard.totalItems).toBe(3);
    expect(dashboard.totalPages).toBe(2);
    expect(dashboard.items.map((item) => item.itemCode)).toEqual(['MR-001', 'MR-002']);
    expect((await service.getDashboard(guildId, 2, 2)).items[0]?.itemCode).toBe('MR-003');

    const duplicate = await service.applyOpeningCsv(csvInput(guildId, openingCsv, actor, 'opening-duplicate'));
    expect(duplicate.batch.id).toBe(opening.batch.id);
    await expect(service.applyOpeningCsv(csvInput(
      guildId,
      Buffer.from('item_name,opening_quantity\nOther,1'),
      actor,
      'opening-other',
    ))).rejects.toBeInstanceOf(ConflictError);
  });

  it('applies a whole optimistic CSV batch atomically', async () => {
    const content = Buffer.from([
      'batch_ref,item_code,item_name,expected_quantity,action,change_quantity,reason',
      'BATCH-001,MR-001,Repair Kit,100,ADD,20,รับของเพิ่ม',
      'BATCH-001,MR-002,Armor,50,REMOVE,5,ปรับยอดตรวจนับ',
    ].join('\n'));
    const batch = await service.applyMovementCsv(csvInput(guildId, content, actor, 'movement-1'));
    expect(batch.movements.map(({ movement }) => movement.quantityAfter)).toEqual([120, 45]);
    const duplicate = await service.applyMovementCsv(csvInput(guildId, content, actor, 'movement-duplicate'));
    expect(duplicate.batch.id).toBe(batch.batch.id);

    const stale = Buffer.from([
      'batch_ref,item_code,item_name,expected_quantity,action,change_quantity,reason',
      'BATCH-STALE,MR-001,Repair Kit,100,REMOVE,1,ยอดเก่า',
      'BATCH-STALE,MR-002,Armor,45,ADD,1,ไม่ควรถูกบันทึก',
    ].join('\n'));
    await expect(service.applyMovementCsv(csvInput(guildId, stale, actor, 'movement-stale'))).rejects.toBeInstanceOf(ValidationError);
    const items = await db.select().from(inventoryItems).where(eq(inventoryItems.guildId, guildId));
    expect(items.find((item) => item.itemCode === 'MR-001')?.quantity).toBe(120);
    expect(items.find((item) => item.itemCode === 'MR-002')?.quantity).toBe(45);
  });

  it('reverses only manual CSV batches and prevents a second reversal', async () => {
    const target = (await service.listRecentBatches(guildId)).find(({ batch }) => batch.batchRef === 'BATCH-001');
    expect(target).toBeDefined();
    const reversal = await service.reverseBatch(guildId, 'reverse-1', target!.batch.id, 'นำเข้า batch ผิด', actor, new Date('2026-08-27T10:00:00.000Z'));
    expect(reversal.movements.map(({ movement }) => movement.quantityChange)).toEqual([-20, 5]);
    const dashboard = await service.getDashboard(guildId, 1, 20);
    expect(dashboard.items.find((item) => item.itemCode === 'MR-001')?.quantity).toBe(100);
    expect(dashboard.items.find((item) => item.itemCode === 'MR-002')?.quantity).toBe(50);
    const duplicate = await service.reverseBatch(guildId, 'reverse-1', target!.batch.id, 'retry', actor, new Date('2026-08-27T10:01:00.000Z'));
    expect(duplicate.batch.id).toBe(reversal.batch.id);
    await expect(service.reverseBatch(guildId, 'reverse-2', target!.batch.id, 'ย้อนซ้ำ', actor, new Date())).rejects.toBeInstanceOf(ConflictError);
  });

  it('queues durable dashboard, batch publish, and batch refresh jobs', async () => {
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.guildId, guildId));
    expect(jobs.some((job) => job.jobType === 'STOCK_REFRESH')).toBe(true);
    expect(jobs.some((job) => job.jobType === 'STOCK_BATCH_PUBLISH')).toBe(true);
    expect(jobs.some((job) => job.jobType === 'STOCK_BATCH_REFRESH')).toBe(true);
  });
});

function csvInput(guildId: string, content: Buffer, actor: string, suffix: string) {
  return {
    guildId,
    content,
    originalAttachmentId: `attachment-${suffix}`,
    publicChannelId: 'stock-channel',
    publicMessageId: `stock-message-${suffix}`,
    actorDiscordUserId: actor,
    now: new Date('2026-08-27T09:00:00.000Z'),
  };
}
