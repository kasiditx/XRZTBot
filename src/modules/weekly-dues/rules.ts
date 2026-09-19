import { ValidationError } from '../../domain/errors.js';
import { DateTime } from 'luxon';

export interface WeeklyFineAmounts {
  readonly principalAmount: number;
  readonly firstPenaltyAmount: number;
  readonly recurringPenaltyAmount: number;
}

export interface WeeklyFineAccrual {
  readonly accruedFineAmount: number;
  readonly nextAccrualAt: Date;
}

const FINE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function calculateWeeklyFineAccrual(
  firstPenaltyAt: Date,
  firstPenaltyAmount: number,
  recurringPenaltyAmount: number,
  now: Date,
): WeeklyFineAccrual {
  for (const amount of [firstPenaltyAmount, recurringPenaltyAmount]) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new ValidationError('ค่าปรับรายสัปดาห์ต้องเป็นจำนวนเต็มที่ไม่ติดลบ');
    }
  }
  const firstAtMs = firstPenaltyAt.getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(firstAtMs) || !Number.isFinite(nowMs)) {
    throw new ValidationError('เวลาคิดค่าปรับรายสัปดาห์ไม่ถูกต้อง');
  }
  if (nowMs < firstAtMs) {
    return { accruedFineAmount: 0, nextAccrualAt: firstPenaltyAt };
  }
  const recurringIntervals = Math.floor((nowMs - firstAtMs) / FINE_INTERVAL_MS);
  const accruedFineAmount = firstPenaltyAmount + recurringPenaltyAmount * recurringIntervals;
  if (!Number.isSafeInteger(accruedFineAmount)) {
    throw new ValidationError('ยอดค่าปรับสะสมสูงเกินขอบเขตที่ระบบรองรับ');
  }
  return {
    accruedFineAmount,
    nextAccrualAt: new Date(firstAtMs + (recurringIntervals + 1) * FINE_INTERVAL_MS),
  };
}

export function buildWeeklyOverdueFine(
  obligationAmount: number,
  firstPenaltyAmount: number,
  recurringPenaltyAmount: number,
): WeeklyFineAmounts {
  for (const amount of [obligationAmount, firstPenaltyAmount, recurringPenaltyAmount]) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new ValidationError('จำนวนเงินรายสัปดาห์และค่าปรับต้องเป็นจำนวนเต็มที่ไม่ติดลบ');
    }
  }

  if (obligationAmount === 0) {
    throw new ValidationError('รายการที่ยอดเป็นศูนย์ไม่ต้องสร้างค่าปรับ');
  }

  const principalAmount = obligationAmount + firstPenaltyAmount;
  if (!Number.isSafeInteger(principalAmount)) {
    throw new ValidationError('ยอดเรียกเก็บสูงเกินขอบเขตที่ระบบรองรับ');
  }

  return {
    principalAmount,
    firstPenaltyAmount,
    recurringPenaltyAmount,
  };
}

export function parseWeeklyDateRange(value: string): { readonly startsOn: string; readonly endsOn: string } {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/u.exec(value.trim());
  if (match === null) throw new ValidationError('ช่วงวันที่ต้องเป็น DD/MM/YY - DD/MM/YY');
  const startsOn = toIsoDate(match[1], match[2], match[3]);
  const endsOn = toIsoDate(match[4], match[5], match[6]);
  if (endsOn < startsOn) throw new ValidationError('วันที่สิ้นสุดต้องไม่อยู่ก่อนวันที่เริ่ม');
  return { startsOn, endsOn };
}

export function validateWeeklyPaymentImage(image: { readonly contentType: string | null; readonly size: number }): void {
  if (image.contentType === null || !image.contentType.startsWith('image/')) {
    throw new ValidationError('หลักฐานส่งเงินต้องเป็นไฟล์รูปภาพ');
  }
  if (!Number.isSafeInteger(image.size) || image.size < 1 || image.size > 10 * 1_024 * 1_024) {
    throw new ValidationError('รูปหลักฐานต้องมีขนาดไม่เกิน 10 MB');
  }
}

function toIsoDate(dayValue: string | undefined, monthValue: string | undefined, yearValue: string | undefined): string {
  const rawYear = Number(yearValue);
  const year = rawYear < 100 ? rawYear + 1_957 : rawYear >= 2_400 ? rawYear - 543 : rawYear;
  const parsed = DateTime.fromObject({ year, month: Number(monthValue), day: Number(dayValue) });
  if (!parsed.isValid) throw new ValidationError('ช่วงวันที่มีวันที่ไม่ถูกต้อง');
  const iso = parsed.toISODate();
  if (iso === null) throw new ValidationError('ช่วงวันที่มีวันที่ไม่ถูกต้อง');
  return iso;
}
