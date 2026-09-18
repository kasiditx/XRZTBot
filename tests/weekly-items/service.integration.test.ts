import { eq } from 'drizzle-orm';
import { ConflictError } from '../../src/domain/errors.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { guildSettings, inventoryItems, members, weeklyItemCollections } from '../../src/infrastructure/db/schema.js';
import { WeeklyItemsService } from '../../src/modules/weekly-items/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('WeeklyItemsService PostgreSQL integration', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let service: WeeklyItemsService;
  const guildId = 'weekly-items-integration-guild';
  const actor = '800000000000000001';
  const memberId = '800000000000000002';
  const reserveId = '800000000000000003';
  let stockItemId: string;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required');
    const connection = createDatabase(testDatabaseUrl);
    db = connection.db;
    pool = connection.pool;
    service = new WeeklyItemsService(db);
    await db.delete(weeklyItemCollections).where(eq(weeklyItemCollections.guildId, guildId));
    await db.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    await db.insert(guildSettings).values({ guildId, timezone: 'Asia/Bangkok' });
    await db.insert(members).values([
      { guildId, discordUserId: memberId, inGameName: 'Member', status: 'ACTIVE' },
      { guildId, discordUserId: reserveId, inGameName: 'Reserve', status: 'ACTIVE', rosterTitle: 'RESERVE' },
    ]);
    const [stockItem] = await db.insert(inventoryItems).values({ guildId, itemCode: 'WI-001', itemName: 'เหล็ก', quantity: 10 }).returning();
    if (stockItem === undefined) throw new Error('Failed to create stock item');
    stockItemId = stockItem.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('requires the full current quantity, applies item penalties, and exempts reserves', async () => {
    const created = await service.create({
      guildId,
      requestId: 'weekly-items-create-1',
      title: 'ส่งของสัปดาห์ 18–24 ก.ย.',
      startsOn: '2026-09-18',
      endsOn: '2026-09-24',
      requirements: [{ itemId: stockItemId, requiredQuantity: 100, initialPenaltyQuantity: 20, recurringPenaltyQuantity: 10 }],
      timezone: 'Asia/Bangkok',
      actorDiscordUserId: actor,
      now: new Date('2026-09-18T00:00:00.000Z'),
    });
    expect(created.obligations.find(({ member }) => member.discordUserId === memberId)?.items[0]?.quantity).toBe(100);
    expect(created.obligations.find(({ member }) => member.discordUserId === reserveId)?.obligation).toMatchObject({
      status: 'EXEMPT', exemptionReason: 'ยกเว้นเนื่องจากเป็นตำแหน่งสำรอง',
    });
    await service.processPenalty(guildId, created.collection.id, new Date('2026-09-24T17:00:00.000Z'));
    const penalized = await service.processPenalty(guildId, created.collection.id, new Date('2026-09-25T17:00:00.000Z'));
    expect(penalized.obligations.find(({ member }) => member.discordUserId === memberId)?.items[0]?.quantity).toBe(130);
    const requiredReserve = await service.setMemberRule(guildId, created.collection.id, reserveId, 'REQUIRED', null, actor, new Date('2026-09-25T18:00:00.000Z'));
    expect(requiredReserve.obligations.find(({ member }) => member.discordUserId === reserveId)?.items[0]?.quantity).toBe(130);
  });

  it('adds the entire proof snapshot to Stock once after approval', async () => {
    const collection = (await service.list(guildId))[0];
    if (collection === undefined) throw new Error('Missing collection');
    const obligation = await service.prepareSubmission(guildId, collection.collection.id, memberId);
    expect(obligation.items[0]?.quantity).toBe(130);
    const proof = await service.persistProof({
      proofId: '55555555-5555-4555-8555-555555555555',
      guildId,
      collectionId: collection.collection.id,
      requestId: 'weekly-items-proof-1',
      submittedByDiscordUserId: memberId,
      attachmentId: 'attachment',
      logChannelId: 'log-channel',
      logMessageId: 'log-message',
      now: new Date('2026-09-25T19:00:00.000Z'),
    });
    const approved = await service.approveProof(guildId, proof.proof.id, actor, new Date('2026-09-25T20:00:00.000Z'));
    expect(approved.proof.status).toBe('APPROVED');
    expect(approved.obligation.status).toBe('FULFILLED');
    expect((await db.select().from(inventoryItems).where(eq(inventoryItems.id, stockItemId)))[0]?.quantity).toBe(140);
    await service.approveProof(guildId, proof.proof.id, actor, new Date('2026-09-25T21:00:00.000Z'));
    expect((await db.select().from(inventoryItems).where(eq(inventoryItems.id, stockItemId)))[0]?.quantity).toBe(140);
    await expect(service.setMemberRule(guildId, collection.collection.id, memberId, 'EXEMPT', null, actor, new Date()))
      .rejects.toBeInstanceOf(ConflictError);
  });
});
