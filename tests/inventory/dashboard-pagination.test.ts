import {
  paginateStockDashboardItems,
  stockDashboardLine,
  type InventoryItem,
} from '../../src/modules/inventory/service.js';

const now = new Date('2026-09-01T04:00:00.000Z');

function item(index: number, itemName = `Item ${String(index)}`): InventoryItem {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    guildId: 'guild',
    itemCode: `MR-${String(index).padStart(3, '0')}`,
    itemName,
    quantity: index,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
}

describe('stock dashboard pagination', () => {
  it('keeps all 72 normal stock items in one long dashboard page', () => {
    const pages = paginateStockDashboardItems(Array.from({ length: 72 }, (_, index) => item(index + 1, `Stock Item ${String(index + 1)}`)));

    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(72);
  });

  it('creates a new page before an embed description reaches Discord limits', () => {
    const pages = paginateStockDashboardItems(Array.from(
      { length: 72 },
      (_, index) => item(index + 1, `รายการ Stock ที่มีชื่อยาวเพื่อทดสอบขีดจำกัดของ Discord ${String(index + 1)}`.repeat(2)),
    ));

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.map(stockDashboardLine).join('\n').length).toBeLessThanOrEqual(3_900);
    }
  });
});
