import { ValidationError } from '../../src/domain/errors.js';
import type { InventoryItem } from '../../src/modules/inventory/service.js';
import { buildWeeklyItemRequirementTemplate, parseWeeklyItemRequirements } from '../../src/modules/weekly-items/rules.js';

const now = new Date('2026-09-18T00:00:00.000Z');
const items: InventoryItem[] = [
  { id: '11111111-1111-4111-8111-111111111111', guildId: 'guild', itemCode: 'MR-001', itemName: 'เหล็ก', quantity: 0, isActive: true, createdAt: now, updatedAt: now },
  { id: '22222222-2222-4222-8222-222222222222', guildId: 'guild', itemCode: 'MR-002', itemName: 'ปูน', quantity: 0, isActive: true, createdAt: now, updatedAt: now },
];

describe('weekly item rules', () => {
  it('builds and parses required, initial penalty, and recurring penalty quantities', () => {
    expect(buildWeeklyItemRequirementTemplate(items)).toContain('MR-001 เหล็ก = 1 | 0 | 0');
    expect(parseWeeklyItemRequirements('MR-001 เหล็ก = 100 | 20 | 10\nMR-002 ปูน = 50 | 10 | 5', items)).toEqual([
      { itemId: items[0]!.id, requiredQuantity: 100, initialPenaltyQuantity: 20, recurringPenaltyQuantity: 10 },
      { itemId: items[1]!.id, requiredQuantity: 50, initialPenaltyQuantity: 10, recurringPenaltyQuantity: 5 },
    ]);
  });

  it('rejects zero required quantity and unknown stock codes', () => {
    expect(() => parseWeeklyItemRequirements('MR-001 เหล็ก = 0 | 0 | 0', items)).toThrow(ValidationError);
    expect(() => parseWeeklyItemRequirements('UNKNOWN = 1 | 0 | 0', items)).toThrow(ValidationError);
  });
});
