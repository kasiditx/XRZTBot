import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { ValidationError } from '../../domain/errors.js';

const initialHeaders = ['item_name', 'opening_quantity'] as const;
const movementHeaders = [
  'batch_ref',
  'item_code',
  'item_name',
  'expected_quantity',
  'action',
  'change_quantity',
  'reason',
] as const;
const maximumDataRows = 1_000;

export interface InitialStockRow {
  readonly itemName: string;
  readonly openingQuantity: number;
}

export interface StockMovementCsvRow {
  readonly rowNumber: number;
  readonly batchRef: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly expectedQuantity: number;
  readonly action: 'ADD' | 'REMOVE';
  readonly changeQuantity: number;
  readonly reason: string;
}

export interface InventoryState {
  readonly itemCode: string;
  readonly itemName: string;
  readonly quantity: number;
}

export interface PlannedStockMovement extends StockMovementCsvRow {
  readonly quantityBefore: number;
  readonly quantityChange: number;
  readonly quantityAfter: number;
}

export function hashCsv(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function parseInitialStockCsv(content: Buffer | string): InitialStockRow[] {
  const rows = parseRows(content);
  assertExactHeaders(rows, initialHeaders);
  const seenNames = new Set<string>();

  return rows.slice(1).map((row, index) => {
    const rowNumber = index + 2;
    const itemName = requireText(row[0], 'item_name', rowNumber);
    const normalizedName = itemName.toLocaleLowerCase('th');
    if (seenNames.has(normalizedName)) {
      throw new ValidationError(`แถว ${rowNumber}: item_name ซ้ำในไฟล์`);
    }
    seenNames.add(normalizedName);

    return {
      itemName,
      openingQuantity: parseInteger(row[1], 'opening_quantity', rowNumber, true),
    };
  });
}

export function parseStockMovementCsv(content: Buffer | string): StockMovementCsvRow[] {
  const rows = parseRows(content);
  assertExactHeaders(rows, movementHeaders);
  const parsed = rows.slice(1).map((row, index) => parseMovementRow(row, index + 2));

  if (parsed.length === 0) {
    throw new ValidationError('ไฟล์ CSV ต้องมีข้อมูลอย่างน้อย 1 แถว');
  }

  const batchRefs = new Set(parsed.map((row) => row.batchRef));
  if (batchRefs.size !== 1) {
    throw new ValidationError('ทุกแถวในไฟล์ต้องใช้ batch_ref เดียวกัน');
  }

  const itemCodes = new Set<string>();
  for (const row of parsed) {
    if (itemCodes.has(row.itemCode)) {
      throw new ValidationError(`แถว ${row.rowNumber}: item_code ซ้ำใน batch เดียวกัน`);
    }
    itemCodes.add(row.itemCode);
  }

  return parsed;
}

export function planStockMovements(
  rows: readonly StockMovementCsvRow[],
  currentStock: ReadonlyMap<string, InventoryState>,
): PlannedStockMovement[] {
  return rows.map((row) => {
    const current = currentStock.get(row.itemCode);
    if (current === undefined) {
      throw new ValidationError(`แถว ${row.rowNumber}: ไม่พบ item_code ${row.itemCode}`);
    }

    if (current.itemName !== row.itemName) {
      throw new ValidationError(`แถว ${row.rowNumber}: item_name ไม่ตรงกับ item_code ${row.itemCode}`);
    }

    if (current.quantity !== row.expectedQuantity) {
      throw new ValidationError(
        `แถว ${row.rowNumber}: expected_quantity เป็น ${row.expectedQuantity.toString()} แต่ stock ปัจจุบันเป็น ${current.quantity.toString()}`,
      );
    }

    const quantityChange = row.action === 'ADD' ? row.changeQuantity : -row.changeQuantity;
    const quantityAfter = current.quantity + quantityChange;
    if (!Number.isSafeInteger(quantityAfter) || quantityAfter < 0) {
      throw new ValidationError(`แถว ${row.rowNumber}: รายการนี้จะทำให้ stock ติดลบหรือเกินขอบเขต`);
    }

    return {
      ...row,
      quantityBefore: current.quantity,
      quantityChange,
      quantityAfter,
    };
  });
}

function parseMovementRow(row: readonly string[], rowNumber: number): StockMovementCsvRow {
  const action = requireText(row[4], 'action', rowNumber).toUpperCase();
  if (action !== 'ADD' && action !== 'REMOVE') {
    throw new ValidationError(`แถว ${rowNumber}: action ต้องเป็น ADD หรือ REMOVE`);
  }

  return {
    rowNumber,
    batchRef: requireText(row[0], 'batch_ref', rowNumber),
    itemCode: requireText(row[1], 'item_code', rowNumber).toUpperCase(),
    itemName: requireText(row[2], 'item_name', rowNumber),
    expectedQuantity: parseInteger(row[3], 'expected_quantity', rowNumber, true),
    action,
    changeQuantity: parseInteger(row[5], 'change_quantity', rowNumber, false),
    reason: requireText(row[6], 'reason', rowNumber),
  };
}

function parseRows(content: Buffer | string): string[][] {
  try {
    const rows = parse(content, {
      bom: true,
      columns: false,
      delimiter: ',',
      relaxColumnCount: false,
      skipEmptyLines: true,
      trim: true,
    }) as unknown;

    if (!Array.isArray(rows) || rows.length < 2 || !rows.every(isStringArray)) {
      throw new ValidationError('ไฟล์ CSV ต้องมี header และข้อมูลอย่างน้อย 1 แถว');
    }
    if (rows.length - 1 > maximumDataRows) {
      throw new ValidationError(`ไฟล์ CSV มีข้อมูลได้ไม่เกิน ${maximumDataRows.toString()} แถว`);
    }

    return rows;
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError('รูปแบบ CSV ไม่ถูกต้องหรือจำนวน column ไม่เท่ากัน');
  }
}

function assertExactHeaders(rows: readonly string[][], expected: readonly string[]): void {
  const headers = rows[0];
  if (headers === undefined || headers.length !== expected.length || headers.some((value, index) => value !== expected[index])) {
    throw new ValidationError(`header ต้องเรียงตามนี้เท่านั้น: ${expected.join(',')}`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((cell) => typeof cell === 'string');
}

function requireText(value: string | undefined, field: string, rowNumber: number): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) {
    throw new ValidationError(`แถว ${rowNumber}: ${field} ห้ามว่าง`);
  }
  if (trimmed.length > 100) {
    throw new ValidationError(`แถว ${rowNumber}: ${field} ยาวเกิน 100 ตัวอักษร`);
  }
  return trimmed;
}

function parseInteger(value: string | undefined, field: string, rowNumber: number, allowZero: boolean): number {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || value?.trim() === '') {
    throw new ValidationError(`แถว ${rowNumber}: ${field} ต้องเป็นจำนวนเต็มตั้งแต่ ${minimum.toString()} ขึ้นไป`);
  }
  return parsed;
}
