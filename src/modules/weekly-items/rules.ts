import { ValidationError } from '../../domain/errors.js';
import type { InventoryItem } from '../inventory/service.js';
import type { WeeklyItemRequirementInput } from './service.js';

export function buildWeeklyItemRequirementTemplate(items: readonly InventoryItem[]): string {
  return items.map((item) => `${item.itemCode} ${item.itemName} = 1 | 0 | 0`).join('\n');
}

export function parseWeeklyItemRequirements(
  value: string,
  items: readonly InventoryItem[],
): WeeklyItemRequirementInput[] {
  const byCode = new Map(items.map((item) => [item.itemCode.toLocaleUpperCase('en-US'), item]));
  const parsed: WeeklyItemRequirementInput[] = [];
  const used = new Set<string>();
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 1 || lines.length > 10) throw new ValidationError('ต้องกำหนดสิ่งของ 1–10 รายการ');
  for (const line of lines) {
    const [left, quantitiesText, extra] = line.split('=').map((part) => part.trim());
    if (left === undefined || quantitiesText === undefined || extra !== undefined) {
      throw new ValidationError(`รูปแบบรายการไม่ถูกต้อง: ${line}`);
    }
    const code = left.split(/\s+/u)[0]?.toLocaleUpperCase('en-US');
    const item = code === undefined ? undefined : byCode.get(code);
    if (item === undefined) throw new ValidationError(`ไม่พบรหัสสิ่งของใน Stock: ${code ?? left}`);
    if (used.has(item.id)) throw new ValidationError(`รายการ ${item.itemName} ซ้ำกัน`);
    const quantities = quantitiesText.split('|').map((part) => parseQuantity(part.trim(), item.itemName));
    if (quantities.length !== 3) {
      throw new ValidationError(`กรุณาระบุ จำนวนส่ง | ค่าปรับครั้งแรก | เพิ่มทุก 24 ชม. สำหรับ ${item.itemName}`);
    }
    const [requiredQuantity, initialPenaltyQuantity, recurringPenaltyQuantity] = quantities;
    if (requiredQuantity === undefined || initialPenaltyQuantity === undefined || recurringPenaltyQuantity === undefined) {
      throw new ValidationError(`จำนวนของ ${item.itemName} ไม่ครบ`);
    }
    if (requiredQuantity < 1) throw new ValidationError(`จำนวนที่ต้องส่งของ ${item.itemName} ต้องมากกว่า 0`);
    used.add(item.id);
    parsed.push({ itemId: item.id, requiredQuantity, initialPenaltyQuantity, recurringPenaltyQuantity });
  }
  return parsed;
}

function parseQuantity(value: string, itemName: string): number {
  const normalized = value.replaceAll(',', '');
  if (!/^\d+$/u.test(normalized)) throw new ValidationError(`จำนวนของ ${itemName} ต้องเป็นจำนวนเต็มตั้งแต่ 0`);
  const quantity = Number(normalized);
  if (!Number.isSafeInteger(quantity)) throw new ValidationError(`จำนวนของ ${itemName} มากเกินไป`);
  return quantity;
}
