import { ValidationError } from '../../src/domain/errors.js';
import {
  hashCsv,
  parseInitialStockCsv,
  parseStockMovementCsv,
  planStockMovements,
} from '../../src/modules/inventory/csv.js';

const validMovementCsv = [
  'batch_ref,item_code,item_name,expected_quantity,action,change_quantity,reason',
  'BATCH-001,MR-001,Repair Kit,10,ADD,5,Loop reward',
  'BATCH-001,MR-002,Armor,20,REMOVE,3,Withdraw correction',
].join('\n');

describe('stock CSV', () => {
  it('parses initial stock and rejects duplicate names', () => {
    expect(parseInitialStockCsv('item_name,opening_quantity\nRepair Kit,10\nArmor,0')).toEqual([
      { itemName: 'Repair Kit', openingQuantity: 10 },
      { itemName: 'Armor', openingQuantity: 0 },
    ]);
    expect(() => parseInitialStockCsv('item_name,opening_quantity\nArmor,1\narmor,2')).toThrow(ValidationError);
  });

  it('requires exact headers and valid integer quantities', () => {
    expect(() => parseInitialStockCsv('opening_quantity,item_name\n1,Armor')).toThrow(ValidationError);
    expect(() => parseInitialStockCsv('item_name,opening_quantity\nArmor,-1')).toThrow(ValidationError);
    expect(() => parseInitialStockCsv('item_name,opening_quantity\n,1')).toThrow(ValidationError);
    expect(() => parseInitialStockCsv('item_name,opening_quantity')).toThrow(ValidationError);
  });

  it('parses movement rows and enforces one batch with unique items', () => {
    const rows = parseStockMovementCsv(validMovementCsv);
    expect(rows[0]).toMatchObject({ batchRef: 'BATCH-001', action: 'ADD', changeQuantity: 5 });
    expect(rows[1]).toMatchObject({ itemCode: 'MR-002', action: 'REMOVE' });

    expect(() => parseStockMovementCsv(validMovementCsv.replace('BATCH-001,MR-002', 'BATCH-002,MR-002'))).toThrow(ValidationError);
    expect(() => parseStockMovementCsv(validMovementCsv.replace('MR-002,Armor', 'MR-001,Armor'))).toThrow(ValidationError);
  });

  it('rejects invalid actions, blank reasons, and malformed rows', () => {
    expect(() => parseStockMovementCsv(validMovementCsv.replace(',ADD,', ',SET,'))).toThrow(ValidationError);
    expect(() => parseStockMovementCsv(validMovementCsv.replace('Loop reward', ''))).toThrow(ValidationError);
    expect(() => parseStockMovementCsv(`${validMovementCsv},unexpected`)).toThrow(ValidationError);
  });

  it('plans a complete batch using optimistic quantities', () => {
    const rows = parseStockMovementCsv(validMovementCsv);
    const current = new Map([
      ['MR-001', { itemCode: 'MR-001', itemName: 'Repair Kit', quantity: 10 }],
      ['MR-002', { itemCode: 'MR-002', itemName: 'Armor', quantity: 20 }],
    ]);
    expect(planStockMovements(rows, current)).toEqual([
      expect.objectContaining({ itemCode: 'MR-001', quantityBefore: 10, quantityChange: 5, quantityAfter: 15 }),
      expect.objectContaining({ itemCode: 'MR-002', quantityBefore: 20, quantityChange: -3, quantityAfter: 17 }),
    ]);
  });

  it('rejects missing, stale, mismatched, and negative stock', () => {
    const [row] = parseStockMovementCsv(validMovementCsv);
    expect(row).toBeDefined();
    expect(() => planStockMovements([row!], new Map())).toThrow(ValidationError);
    expect(() => planStockMovements([row!], new Map([['MR-001', { itemCode: 'MR-001', itemName: 'Other', quantity: 10 }]]))).toThrow(ValidationError);
    expect(() => planStockMovements([row!], new Map([['MR-001', { itemCode: 'MR-001', itemName: 'Repair Kit', quantity: 9 }]]))).toThrow(ValidationError);

    const removeTooMuch = parseStockMovementCsv(validMovementCsv.replace('ADD,5', 'REMOVE,50'))[0];
    expect(() => planStockMovements([removeTooMuch!], new Map([['MR-001', { itemCode: 'MR-001', itemName: 'Repair Kit', quantity: 10 }]]))).toThrow(ValidationError);
  });

  it('produces stable SHA-256 hashes for duplicate-file detection', () => {
    expect(hashCsv('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashCsv(Buffer.from('abc'))).toBe(hashCsv('abc'));
  });

  it('limits CSV row and text sizes before database work', () => {
    const tooManyRows = ['item_name,opening_quantity', ...Array.from({ length: 1_001 }, (_, index) => `Item ${String(index)},1`)].join('\n');
    expect(() => parseInitialStockCsv(tooManyRows)).toThrow(ValidationError);
    expect(() => parseInitialStockCsv(`item_name,opening_quantity\n${'A'.repeat(101)},1`)).toThrow(ValidationError);
  });
});
