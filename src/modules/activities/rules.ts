import { DateTime } from 'luxon';
import { ValidationError } from '../../domain/errors.js';

export interface ActivityScoreDefinition {
  readonly name: string;
  readonly points: number;
}

export type EffectiveActivityStatus = 'SCHEDULED' | 'OPEN' | 'CLOSED';

export function parseActivityDateTime(value: string, timezone: string): Date {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (match === null) {
    throw new ValidationError('วันเวลาต้องเป็น DD/MM/YY HH:mm เช่น 26/08/69 19:00');
  }
  const rawYear = Number(match[3]);
  const gregorianYear = rawYear < 100 ? rawYear + 1_957 : rawYear >= 2_400 ? rawYear - 543 : rawYear;
  const parsed = DateTime.fromObject({
    year: gregorianYear,
    month: Number(match[2]),
    day: Number(match[1]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  }, { zone: timezone, locale: 'th' });
  if (!parsed.isValid) {
    throw new ValidationError('วันเวลาต้องเป็นวันที่จริง เช่น 26/08/69 19:00');
  }
  return parsed.toJSDate();
}

export function parseScoreDefinitions(value: string): ActivityScoreDefinition[] {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0 || lines.length > 25) {
    throw new ValidationError('ต้องกำหนดรายการคะแนน 1–25 รายการ');
  }

  const names = new Set<string>();
  return lines.map((line, index) => {
    const match = /^(.*?)\s*=\s*(\d+)$/u.exec(line);
    if (match === null) {
      throw new ValidationError(`คะแนนบรรทัด ${String(index + 1)} ต้องเป็น ชื่อ=คะแนน เช่น Loop A=50`);
    }

    const name = match[1]?.trim() ?? '';
    const points = Number(match[2]);
    if (name.length < 1 || name.length > 80) {
      throw new ValidationError(`ชื่อรายการคะแนนบรรทัด ${String(index + 1)} ต้องมี 1–80 ตัวอักษร`);
    }
    if (!Number.isSafeInteger(points) || points < 0 || points > 1_000_000_000) {
      throw new ValidationError(`คะแนนบรรทัด ${String(index + 1)} ต้องเป็นจำนวนเต็ม 0–1,000,000,000`);
    }

    const normalizedName = name.toLocaleLowerCase('th');
    if (names.has(normalizedName)) {
      throw new ValidationError(`รายการคะแนนชื่อ ${name} ซ้ำกัน`);
    }
    names.add(normalizedName);
    return { name, points };
  });
}

export function validateActivityWindow(startsAt: Date, endsAt: Date, now: Date): EffectiveActivityStatus {
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
    throw new ValidationError('วันเวลากิจกรรมไม่ถูกต้อง');
  }
  if (endsAt <= startsAt) {
    throw new ValidationError('เวลาปิดกิจกรรมต้องอยู่หลังเวลาเริ่ม');
  }
  if (endsAt <= now) {
    throw new ValidationError('เวลาปิดกิจกรรมต้องอยู่ในอนาคต');
  }
  return startsAt <= now ? 'OPEN' : 'SCHEDULED';
}

export function validateSubmissionImages(
  attachments: readonly { readonly contentType: string | null; readonly size: number }[],
): void {
  if (attachments.length < 1 || attachments.length > 5) {
    throw new ValidationError('ต้องแนบรูป 1–5 รูป');
  }
  if (attachments.some((attachment) => !(attachment.contentType?.startsWith('image/') ?? false))) {
    throw new ValidationError('หลักฐานกิจกรรมต้องเป็นไฟล์รูปภาพเท่านั้น');
  }
  if (attachments.some((attachment) => attachment.size <= 0)) {
    throw new ValidationError('ไฟล์รูปภาพว่างหรือไม่ถูกต้อง');
  }
}

export function requireShortText(value: string, label: string, minimum: number, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ValidationError(`${label} ต้องมี ${String(minimum)}–${String(maximum)} ตัวอักษร`);
  }
  return normalized;
}
