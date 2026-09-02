import { ValidationError } from '../../domain/errors.js';

export interface TreasuryEvidence {
  readonly contentType: string | null;
  readonly size: number;
}

export function calculateNextBalance(currentBalance: number, amountChange: number): number {
  if (!Number.isSafeInteger(currentBalance) || currentBalance < 0) {
    throw new ValidationError('ยอดเงินกองกลางปัจจุบันไม่ถูกต้อง');
  }

  if (!Number.isSafeInteger(amountChange) || amountChange === 0) {
    throw new ValidationError('จำนวนเงินต้องเป็นจำนวนเต็มและห้ามเป็นศูนย์');
  }

  const nextBalance = currentBalance + amountChange;
  if (!Number.isSafeInteger(nextBalance)) {
    throw new ValidationError('ยอดเงินสูงเกินขอบเขตที่ระบบรองรับ');
  }

  if (nextBalance < 0) {
    throw new ValidationError('ยอดเงินกองกลางห้ามติดลบ');
  }

  return nextBalance;
}

export function validateTreasuryEvidence(evidence: TreasuryEvidence): void {
  if (evidence.contentType === null || !evidence.contentType.startsWith('image/')) {
    throw new ValidationError('หลักฐานรายรับ–รายจ่ายต้องเป็นไฟล์รูปภาพ');
  }
  if (!Number.isSafeInteger(evidence.size) || evidence.size < 1 || evidence.size > 10 * 1_024 * 1_024) {
    throw new ValidationError('รูปหลักฐานต้องมีขนาดไม่เกิน 10 MB');
  }
}
