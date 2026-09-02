import { ValidationError } from '../../domain/errors.js';

const maximumLineItems = 50;

export interface InventoryQuantityInput {
  readonly itemCode: string;
  readonly quantity: number;
}

export interface InventoryNameQuantityInput {
  readonly itemName: string;
  readonly quantity: number;
}

export function formatInventoryItemCode(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new ValidationError('ลำดับรหัสสินค้าต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
  }
  return `MR-${String(sequence).padStart(3, '0')}`;
}

export function parseInventoryQuantityLines(value: string): InventoryQuantityInput[] {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > maximumLineItems) {
    throw new ValidationError(`ต้องระบุรายการ 1–${maximumLineItems.toString()} บรรทัด`);
  }

  const seenCodes = new Set<string>();
  return lines.map((line, index) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,49})\s*=\s*(\d+)$/u.exec(line);
    if (match === null) {
      throw new ValidationError(`บรรทัด ${String(index + 1)} ต้องเป็น รหัสสินค้า=จำนวน เช่น MR-001=2`);
    }
    const itemCode = (match[1] ?? '').toUpperCase();
    const quantity = Number(match[2]);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new ValidationError(`บรรทัด ${String(index + 1)} จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป`);
    }
    if (seenCodes.has(itemCode)) {
      throw new ValidationError(`บรรทัด ${String(index + 1)} item code ${itemCode} ซ้ำกัน`);
    }
    seenCodes.add(itemCode);
    return { itemCode, quantity };
  });
}

export function parseInventoryNameQuantityLines(value: string): InventoryNameQuantityInput[] {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > maximumLineItems) {
    throw new ValidationError(`ต้องระบุรายการ 1–${maximumLineItems.toString()} บรรทัด`);
  }

  const seenNames = new Set<string>();
  return lines.map((line, index) => {
    const separatorIndex = line.lastIndexOf('=');
    const itemName = separatorIndex < 0 ? '' : line.slice(0, separatorIndex).trim();
    const quantityText = separatorIndex < 0 ? '' : line.slice(separatorIndex + 1).trim();
    if (itemName.length < 1 || itemName.length > 100 || !/^\d+$/u.test(quantityText)) {
      throw new ValidationError(`บรรทัด ${String(index + 1)} ต้องเป็น ชื่อสิ่งของ=จำนวน เช่น Repair Kit=2`);
    }
    const quantity = Number(quantityText);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new ValidationError(`บรรทัด ${String(index + 1)} จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป`);
    }
    const normalizedName = normalizeInventoryItemName(itemName);
    if (seenNames.has(normalizedName)) {
      throw new ValidationError(`บรรทัด ${String(index + 1)} ชื่อสิ่งของ ${itemName} ซ้ำกัน`);
    }
    seenNames.add(normalizedName);
    return { itemName, quantity };
  });
}

export function parseInventoryQuantity(value: string): number {
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new ValidationError('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
  }
  const quantity = Number(normalized);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new ValidationError('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
  }
  return quantity;
}

export function parseSelectedInventoryQuantities(value: string, expectedCount: number): number[] {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 25) {
    throw new ValidationError('จำนวนรายการที่เลือกไม่ถูกต้อง');
  }
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== expectedCount) {
    throw new ValidationError(`ต้องมีรายการครบ ${expectedCount.toString()} บรรทัด ห้ามเพิ่ม ลบ หรือสลับบรรทัด`);
  }
  return lines.map((line, index) => {
    const match = /^(\d{2})\s*·\s*.+\s*=\s*(\d+)$/u.exec(line);
    const expectedOrdinal = index + 1;
    if (match === null || Number(match[1]) !== expectedOrdinal) {
      throw new ValidationError(`บรรทัด ${expectedOrdinal.toString()} ไม่ถูกต้อง กรุณาแก้เฉพาะจำนวนหลังเครื่องหมาย =`);
    }
    return parseInventoryQuantity(match[2] ?? '');
  });
}

export function validateStockCsvAttachment(input: {
  readonly name: string | null;
  readonly contentType: string | null;
  readonly size: number;
}): void {
  if (!(input.name?.toLocaleLowerCase('en').endsWith('.csv') ?? false)) {
    throw new ValidationError('ไฟล์ stock ต้องใช้นามสกุล .csv');
  }
  const allowedTypes = new Set([
    'text/csv',
    'text/comma-separated-values',
    'application/csv',
    'application/vnd.ms-excel',
    'application/octet-stream',
  ]);
  const contentType = input.contentType?.split(';', 1)[0]?.trim().toLocaleLowerCase('en') ?? null;
  if (contentType !== null && !allowedTypes.has(contentType)) {
    throw new ValidationError('ไฟล์ stock ต้องเป็น CSV');
  }
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > 2 * 1_024 * 1_024) {
    throw new ValidationError('ไฟล์ CSV ต้องมีขนาดไม่เกิน 2 MB');
  }
}

export function validateDepositImage(image: { readonly contentType: string | null; readonly size: number }): void {
  if (image.contentType === null || !image.contentType.startsWith('image/')) {
    throw new ValidationError('หลักฐานส่งของต้องเป็นไฟล์รูปภาพ');
  }
  if (!Number.isSafeInteger(image.size) || image.size < 1 || image.size > 10 * 1_024 * 1_024) {
    throw new ValidationError('รูปหลักฐานส่งของต้องมีขนาดไม่เกิน 10 MB');
  }
}

export function requirePartialFulfillmentReason(reason: string, isComplete: boolean): string | null {
  const normalized = reason.trim();
  if (!isComplete && (normalized.length < 2 || normalized.length > 500)) {
    throw new ValidationError('การจ่ายบางส่วนต้องระบุเหตุผล 2–500 ตัวอักษร');
  }
  if (isComplete && normalized.length === 0) return null;
  if (normalized.length > 500) throw new ValidationError('เหตุผลต้องไม่เกิน 500 ตัวอักษร');
  return normalized;
}

export function normalizeInventoryItemName(itemName: string): string {
  return itemName.trim().toLocaleLowerCase('th');
}
