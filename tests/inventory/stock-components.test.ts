import {
  buildDepositModal,
  buildPreparedDepositLog,
  buildStockDashboard,
  buildStockItemPicker,
  buildFulfillmentModal,
  buildWithdrawalLog,
  buildWithdrawalModal,
  buildWithdrawalRejectionModal,
} from '../../src/infrastructure/discord/stock-components.js';
import type { InventoryItem } from '../../src/modules/inventory/service.js';
import type { PreparedDeposit } from '../../src/modules/deposits/service.js';
import type { WithdrawalRequestView } from '../../src/modules/withdrawals/service.js';

const now = new Date('2026-08-27T12:00:00.000Z');
const sessionToken = '22222222-2222-4222-8222-222222222222';
const stockItem: InventoryItem = {
  id: '11111111-1111-4111-8111-111111111111',
  guildId: 'guild',
  itemCode: 'MR-001',
  itemName: 'Repair Kit',
  quantity: 12,
  isActive: true,
  createdAt: now,
  updatedAt: now,
};
const withdrawalView: WithdrawalRequestView = {
  request: {
    id: sessionToken,
    guildId: 'guild',
    clientRequestId: 'client-request',
    requesterMemberId: sessionToken,
    reason: 'ใช้ทำกิจกรรม',
    status: 'PENDING',
    publicChannelId: null,
    publicMessageId: null,
    decidedAt: null,
    decidedByDiscordUserId: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  },
  requester: { discordUserId: '700000000000000001', inGameName: 'Requester' },
  items: [{ item: stockItem, requestedQuantity: 5, fulfilledQuantity: 2 }],
  fulfillments: [],
};

describe('stock Discord components', () => {
  it('serializes the stock dashboard with withdrawal and deposit actions', () => {
    const payload = buildStockDashboard({
      items: [],
      page: 1,
      pageSize: 20,
      totalItems: 0,
      totalPages: 1,
    });
    const row = payload.components[0]?.toJSON();
    const customIds = row?.components.map((component) => ('custom_id' in component ? component.custom_id : null)) ?? [];
    expect(customIds).toEqual(['stock:withdraw', 'stock:deposit']);
    expect(new Set(customIds).size).toBe(customIds.length);
  });

  it('omits stock dashboard navigation when all items fit in one display', () => {
    const payload = buildStockDashboard({
      items: [stockItem],
      page: 1,
      pageSize: 72,
      totalItems: 72,
      totalPages: 1,
    }, 'LOG');

    expect(payload.components).toEqual([]);
  });

  it('keeps the stock log dashboard read-only except for pagination', () => {
    const payload = buildStockDashboard({
      items: [],
      page: 1,
      pageSize: 20,
      totalItems: 72,
      totalPages: 4,
    }, 'LOG');
    const row = payload.components[0]?.toJSON();
    const customIds = row?.components.map((component) => ('custom_id' in component ? component.custom_id : null)) ?? [];
    expect(customIds).toEqual([
      'stock:log_view:previous:1',
      'stock:log_view:next:2',
    ]);
  });

  it('builds a member item picker from real stock without requiring a typed item code', () => {
    const payload = buildStockItemPicker('WITHDRAWAL', {
      items: [stockItem],
      page: 2,
      pageSize: 25,
      totalItems: 72,
      totalPages: 3,
    }, sessionToken, new Set([stockItem.id]));
    const select = payload.components[0]?.toJSON().components[0];
    expect(select).toMatchObject({
      custom_id: `stock:member_select:WITHDRAWAL:${sessionToken}:2`,
      options: [{ label: 'Repair Kit', description: 'คงเหลือ 12 ชิ้น', value: stockItem.id, default: true }],
    });
    const navigationIds = payload.components[1]?.toJSON().components.map((component) => (
      'custom_id' in component ? component.custom_id : null
    ));
    expect(navigationIds).toEqual([
      `stock:member_page:WITHDRAWAL:${sessionToken}:1`,
      `stock:member_page:WITHDRAWAL:${sessionToken}:3`,
      `stock:member_review:WITHDRAWAL:${sessionToken}`,
      `stock:member_clear:WITHDRAWAL:${sessionToken}:2`,
    ]);
  });

  it('serializes selected-item modals with quantity fields instead of item-name/code fields', () => {
    const depositModal = buildDepositModal(sessionToken, [stockItem], 'FILE').toJSON();
    const depositLinkModal = buildDepositModal(sessionToken, [stockItem], 'LINK').toJSON();
    expect(depositModal.custom_id).toBe(`stock:deposit_modal:FILE:${sessionToken}`);
    expect(depositModal.components).toHaveLength(3);
    expect(depositLinkModal.custom_id).toBe(`stock:deposit_modal:LINK:${sessionToken}`);
    expect(depositLinkModal.components[2]).toMatchObject({
      component: { type: 4, custom_id: 'stock:deposit_media_link', required: true },
    });

    const withdrawalModal = buildWithdrawalModal(sessionToken, [stockItem]).toJSON();
    expect(withdrawalModal.custom_id).toBe(`stock:withdrawal_modal:${sessionToken}`);
    expect(withdrawalModal.components).toHaveLength(2);
    expect(JSON.stringify([depositModal, withdrawalModal])).not.toContain('stock:deposit_items');
    expect(JSON.stringify([depositModal, withdrawalModal])).not.toContain('stock:withdrawal_items');
    expect(JSON.stringify(depositModal)).not.toContain('MR-001');
    expect(JSON.stringify(withdrawalModal)).not.toContain('MR-001');
    expect(JSON.stringify(withdrawalModal)).toContain('คงเหลือ 12 ชิ้น');
  });

  it('shows item names and current stock in the fulfillment modal without item codes', () => {
    const modal = buildFulfillmentModal(withdrawalView).toJSON();
    const serialized = JSON.stringify(modal);
    expect(serialized).toContain('Repair Kit');
    expect(serialized).toContain('Stock เหลือ 12');
    expect(serialized).not.toContain('MR-001');
  });

  it('separates withdrawal items into clear approval fields', () => {
    const payload = buildWithdrawalLog(withdrawalView);
    expect(payload.embeds).toHaveLength(2);
    const itemEmbed = payload.embeds[1]?.toJSON();
    expect(itemEmbed?.title).toContain('⌗・รายการขอเบิก (1)');
    expect(itemEmbed?.fields?.[0]?.name).toContain('01・Repair Kit');
    expect(itemEmbed?.fields?.[0]?.value).toContain('จำนวนที่ขอ: **5 ชิ้น**');
    expect(itemEmbed?.fields?.[0]?.value).toContain('จ่ายแล้ว: **2 ชิ้น**');
    expect(itemEmbed?.fields?.[0]?.value).toContain('Stock คงเหลือ: **12 ชิ้น**');
    const actions = payload.components[0]?.toJSON().components;
    expect(actions?.map((component) => ('custom_id' in component ? component.custom_id : null))).toEqual([
      `stock:fulfill:${sessionToken}`,
      `stock:withdrawal_reject:${sessionToken}`,
    ]);
  });

  it('builds a required-reason modal and renders rejected withdrawal metadata', () => {
    const modal = buildWithdrawalRejectionModal(sessionToken).toJSON();
    expect(modal.custom_id).toBe(`stock:withdrawal_reject_modal:${sessionToken}`);
    expect(JSON.stringify(modal)).toContain('เหตุผลที่ปฏิเสธ');

    const payload = buildWithdrawalLog({
      ...withdrawalView,
      request: {
        ...withdrawalView.request,
        status: 'CANCELLED',
        decidedAt: now,
        decidedByDiscordUserId: '700000000000000003',
        rejectionReason: 'รายการไม่ตรงกับวัตถุประสงค์',
      },
    });
    const summary = payload.embeds[0]?.toJSON();
    const serializedSummary = JSON.stringify(summary);
    expect(serializedSummary).toContain('สถานะ');
    expect(serializedSummary).toContain('ปฏิเสธ');
    expect(serializedSummary).toContain('ผู้ดำเนินการ');
    expect(serializedSummary).toContain('<@700000000000000003>');
    expect(serializedSummary).toContain('เหตุผลที่ปฏิเสธ');
    expect(serializedSummary).toContain('รายการไม่ตรงกับวัตถุประสงค์');
    const actions = payload.components[0]?.toJSON().components;
    expect(actions?.every((component) => 'disabled' in component && component.disabled === true)).toBe(true);
  });

  it('keeps a 50-item public deposit log within Discord embed limits', () => {
    const prepared: PreparedDeposit = {
      requestId: '11111111-1111-4111-8111-111111111111',
      guildId: 'guild',
      sender: { discordUserId: '700000000000000001', inGameName: 'Depositor' },
      source: 'Loop ขนของจำนวนมาก',
      items: Array.from({ length: 50 }, (_, index) => ({
        item: {
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          guildId: 'guild',
          itemCode: `MR-${String(index + 1).padStart(44, '0')}`,
          itemName: 'ชื่อของที่ยาวมากสำหรับทดสอบขีดจำกัด Discord Embed'.repeat(2),
          quantity: 0,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        quantity: Number.MAX_SAFE_INTEGER,
      })),
    };
    const payload = buildPreparedDepositLog(prepared, 'attachment://deposit-proof.png');
    const embed = payload.embeds[0]?.toJSON();
    const fieldLength = embed?.fields?.reduce((total, field) => total + field.name.length + field.value.length, 0) ?? 0;
    expect(fieldLength).toBeLessThan(5_500);
    expect(embed?.image?.url).toBe('attachment://deposit-proof.png');
    expect(() => payload.components[0]?.toJSON()).not.toThrow();
  });
});
