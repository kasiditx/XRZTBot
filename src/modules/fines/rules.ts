import { ValidationError } from '../../domain/errors.js';

const SURCHARGE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type FineAccrualStatus = 'UNPAID' | 'PENDING_VERIFICATION' | 'PAID' | 'CANCELLED';

export interface FineAccrualInput {
  readonly principalAmount: number;
  readonly accruedSurchargeAmount: number;
  readonly surchargeAmount: number;
  readonly nextSurchargeAt: Date;
  readonly now: Date;
  readonly status: FineAccrualStatus;
}

export interface FineAccrualResult {
  readonly intervals: number;
  readonly surchargeToAdd: number;
  readonly totalDue: number;
  readonly nextSurchargeAt: Date;
}

export interface FinePaymentImage {
  readonly contentType: string | null;
  readonly size: number;
}

export function calculateFineAccrual(input: FineAccrualInput): FineAccrualResult {
  validateMoney(input.principalAmount, 'principalAmount', false);
  validateMoney(input.accruedSurchargeAmount, 'accruedSurchargeAmount', true);
  validateMoney(input.surchargeAmount, 'surchargeAmount', true);

  const currentTotal = input.principalAmount + input.accruedSurchargeAmount;
  if (input.status !== 'UNPAID' || input.surchargeAmount === 0 || input.now < input.nextSurchargeAt) {
    return {
      intervals: 0,
      surchargeToAdd: 0,
      totalDue: currentTotal,
      nextSurchargeAt: input.nextSurchargeAt,
    };
  }

  const elapsed = input.now.getTime() - input.nextSurchargeAt.getTime();
  const intervals = Math.floor(elapsed / SURCHARGE_INTERVAL_MS) + 1;
  const surchargeToAdd = intervals * input.surchargeAmount;

  if (!Number.isSafeInteger(surchargeToAdd) || !Number.isSafeInteger(currentTotal + surchargeToAdd)) {
    throw new ValidationError('ยอดค่าปรับสูงเกินขอบเขตที่ระบบรองรับ');
  }

  return {
    intervals,
    surchargeToAdd,
    totalDue: currentTotal + surchargeToAdd,
    nextSurchargeAt: new Date(input.nextSurchargeAt.getTime() + intervals * SURCHARGE_INTERVAL_MS),
  };
}

export function validateFullFinePayment(submittedAmount: number, totalDue: number): void {
  validateMoney(submittedAmount, 'submittedAmount', false);
  validateMoney(totalDue, 'totalDue', false);

  if (submittedAmount !== totalDue) {
    throw new ValidationError(`ค่าปรับต้องชำระเต็มจำนวน ${totalDue.toLocaleString('th-TH')} เท่านั้น`);
  }
}

export function validateFinePaymentImage(image: FinePaymentImage): void {
  if (image.contentType === null || !image.contentType.startsWith('image/')) {
    throw new ValidationError('หลักฐานชำระค่าปรับต้องเป็นไฟล์รูปภาพ');
  }
  if (!Number.isSafeInteger(image.size) || image.size < 1 || image.size > 10 * 1_024 * 1_024) {
    throw new ValidationError('รูปหลักฐานต้องมีขนาดไม่เกิน 10 MB');
  }
}

function validateMoney(value: number, field: string, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ValidationError(`${field} must be a safe integer greater than or equal to ${minimum}`);
  }
}
