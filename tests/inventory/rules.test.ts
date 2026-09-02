import { ValidationError } from '../../src/domain/errors.js';
import {
  formatInventoryItemCode,
  parseInventoryNameQuantityLines,
  parseInventoryQuantity,
  parseInventoryQuantityLines,
  parseSelectedInventoryQuantities,
  requirePartialFulfillmentReason,
  validateDepositImage,
  validateStockCsvAttachment,
} from '../../src/modules/inventory/rules.js';

describe('inventory Discord rules', () => {
  it('generates stable MR item codes with a three-digit minimum', () => {
    expect(formatInventoryItemCode(1)).toBe('MR-001');
    expect(formatInventoryItemCode(72)).toBe('MR-072');
    expect(formatInventoryItemCode(1_000)).toBe('MR-1000');
    expect(() => formatInventoryItemCode(0)).toThrow(ValidationError);
  });

  it('parses multiple item quantities and normalizes item codes', () => {
    expect(parseInventoryQuantityLines('mr-001=2\nMR_002 = 5')).toEqual([
      { itemCode: 'MR-001', quantity: 2 },
      { itemCode: 'MR_002', quantity: 5 },
    ]);
  });

  it('parses a selected item quantity without requiring an item code', () => {
    expect(parseInventoryQuantity(' 12 ')).toBe(12);
    expect(() => parseInventoryQuantity('0')).toThrow(ValidationError);
    expect(() => parseInventoryQuantity('1.5')).toThrow(ValidationError);
    expect(() => parseInventoryQuantity('MR-001=2')).toThrow(ValidationError);
  });

  it('parses multi-item quantities by fixed row order without trusting item names', () => {
    expect(parseSelectedInventoryQuantities('01 · Repair Kit · คงเหลือ 12 ชิ้น = 2\n02 · เกราะหนัก · คงเหลือ 8 ชิ้น = 5', 2)).toEqual([2, 5]);
    expect(() => parseSelectedInventoryQuantities('01 · Repair Kit = 2', 2)).toThrow(ValidationError);
    expect(() => parseSelectedInventoryQuantities('02 · Repair Kit = 2\n01 · เกราะหนัก = 5', 2)).toThrow(ValidationError);
    expect(() => parseSelectedInventoryQuantities('01 · Repair Kit = 0', 1)).toThrow(ValidationError);
  });

  it('rejects malformed, duplicate, zero, and excessive item lines', () => {
    expect(() => parseInventoryQuantityLines('MR-001:2')).toThrow(ValidationError);
    expect(() => parseInventoryQuantityLines('MR-001=0')).toThrow(ValidationError);
    expect(() => parseInventoryQuantityLines('mr-001=1\nMR-001=2')).toThrow(ValidationError);
    expect(() => parseInventoryQuantityLines(Array.from({ length: 51 }, (_, index) => `MR-${String(index)}=1`).join('\n'))).toThrow(ValidationError);
  });

  it('parses Deposit quantities by item name and matches duplicate names case-insensitively', () => {
    expect(parseInventoryNameQuantityLines('Repair Kit=2\nเกราะหนัก = 5')).toEqual([
      { itemName: 'Repair Kit', quantity: 2 },
      { itemName: 'เกราะหนัก', quantity: 5 },
    ]);
    expect(() => parseInventoryNameQuantityLines('Repair Kit:2')).toThrow(ValidationError);
    expect(() => parseInventoryNameQuantityLines('Repair Kit=0')).toThrow(ValidationError);
    expect(() => parseInventoryNameQuantityLines('Repair Kit=1\nrepair kit=2')).toThrow(ValidationError);
  });

  it('accepts Discord CSV types and enforces extension and 2 MB limit', () => {
    expect(() => validateStockCsvAttachment({ name: 'stock.csv', contentType: 'text/csv', size: 1_024 })).not.toThrow();
    expect(() => validateStockCsvAttachment({ name: 'stock.csv', contentType: 'text/csv; charset=utf-8', size: 1_024 })).not.toThrow();
    expect(() => validateStockCsvAttachment({ name: 'stock.csv', contentType: 'text/comma-separated-values', size: 1_024 })).not.toThrow();
    expect(() => validateStockCsvAttachment({ name: 'stock.txt', contentType: 'text/csv', size: 1_024 })).toThrow(ValidationError);
    expect(() => validateStockCsvAttachment({ name: 'stock.csv', contentType: 'application/pdf', size: 1_024 })).toThrow(ValidationError);
    expect(() => validateStockCsvAttachment({ name: 'stock.csv', contentType: null, size: 3 * 1_024 * 1_024 })).toThrow(ValidationError);
  });

  it('accepts one image proof up to 10 MB for deposits', () => {
    expect(() => validateDepositImage({ contentType: 'image/png', size: 2 * 1_024 * 1_024 })).not.toThrow();
    expect(() => validateDepositImage({ contentType: 'application/pdf', size: 1_024 })).toThrow(ValidationError);
    expect(() => validateDepositImage({ contentType: null, size: 1_024 })).toThrow(ValidationError);
    expect(() => validateDepositImage({ contentType: 'image/jpeg', size: 10 * 1_024 * 1_024 + 1 })).toThrow(ValidationError);
  });

  it('requires a reason only when fulfillment remains partial', () => {
    expect(requirePartialFulfillmentReason('', true)).toBeNull();
    expect(requirePartialFulfillmentReason('จ่ายครบ', true)).toBe('จ่ายครบ');
    expect(requirePartialFulfillmentReason('ของไม่พอ', false)).toBe('ของไม่พอ');
    expect(() => requirePartialFulfillmentReason('', false)).toThrow(ValidationError);
    expect(() => requirePartialFulfillmentReason('A'.repeat(501), true)).toThrow(ValidationError);
  });
});
