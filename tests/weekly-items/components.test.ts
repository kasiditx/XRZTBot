import {
  buildCreateWeeklyItemsModal,
  buildWeeklyItemsAnnouncement,
  buildWeeklyItemsManagement,
  buildWeeklyItemsProofModal,
} from '../../src/infrastructure/discord/weekly-items-components.js';
import type { InventoryItem } from '../../src/modules/inventory/service.js';
import type { WeeklyItemCollectionView } from '../../src/modules/weekly-items/service.js';

const now = new Date('2026-09-18T00:00:00.000Z');
const item: InventoryItem = {
  id: '11111111-1111-4111-8111-111111111111', guildId: 'guild', itemCode: 'MR-001', itemName: 'เหล็ก',
  quantity: 50, isActive: true, createdAt: now, updatedAt: now,
};

describe('weekly items Discord components', () => {
  it('builds a complete-item creation modal and one-shot proof modal', () => {
    const create = buildCreateWeeklyItemsModal([item], '18/09/2569', '24/09/2569').toJSON();
    const proof = buildWeeklyItemsProofModal('22222222-2222-4222-8222-222222222222', 'FILE').toJSON();
    expect(create.custom_id).toBe('weekly-items:create_modal');
    expect(JSON.stringify(create.components)).toContain('"value":"ส่งของประจำสัปดาห์"');
    expect(JSON.stringify(create.components)).toContain('MR-001 เหล็ก = 1 | 0 | 0');
    expect(proof.custom_id).toBe('weekly-items:submit_modal:FILE:22222222-2222-4222-8222-222222222222');
    expect(JSON.stringify(proof.components)).not.toContain('quantity');
  });

  it('shows member states and management controls', () => {
    const view = weeklyItemsView();
    const announcement = buildWeeklyItemsAnnouncement(view);
    const management = buildWeeklyItemsManagement(view);
    expect(JSON.stringify(announcement)).toContain('สมาชิกต้องส่งของครบตามยอดทั้งหมดในครั้งเดียว');
    expect(JSON.stringify(announcement)).toContain('weekly-items:submit:');
    expect(JSON.stringify(management)).toContain('weekly-items:member_rule:');
  });
});

function weeklyItemsView(): WeeklyItemCollectionView {
  return {
    collection: {
      id: '22222222-2222-4222-8222-222222222222', guildId: 'guild', requestId: 'request', title: 'ส่งของสัปดาห์นี้',
      startsOn: '2026-09-18', endsOn: '2026-09-24', firstPenaltyAt: new Date('2026-09-24T17:00:00.000Z'),
      penaltyRunCount: 0, isClosed: false, cancelledAt: null, cancelledByDiscordUserId: null, cancellationReason: null,
      createdByDiscordUserId: '700000000000000001', publicChannelId: null, publicMessageId: null, createdAt: now, updatedAt: now,
    },
    requirements: [{ requirement: { collectionId: '22222222-2222-4222-8222-222222222222', itemId: item.id, requiredQuantity: 100, initialPenaltyQuantity: 20, recurringPenaltyQuantity: 10 }, item }],
    obligations: [{
      obligation: {
        id: '33333333-3333-4333-8333-333333333333', guildId: 'guild', collectionId: '22222222-2222-4222-8222-222222222222',
        memberId: '44444444-4444-4444-8444-444444444444', status: 'UNPAID', decidedAt: null,
        decidedByDiscordUserId: null, exemptionReason: null, fulfilledAt: null, createdAt: now, updatedAt: now,
      },
      member: { id: '44444444-4444-4444-8444-444444444444', discordUserId: '700000000000000002', inGameName: 'Member' },
      items: [{ item, quantity: 100 }],
    }],
  };
}
