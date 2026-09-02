import { ValidationError } from '../../src/domain/errors.js';
import {
  calculateFineAccrual,
  validateFinePaymentImage,
  validateFullFinePayment,
} from '../../src/modules/fines/rules.js';

const nextSurchargeAt = new Date('2026-08-27T16:00:00.000Z');

describe('fine rules', () => {
  it('adds one surcharge at the exact due time', () => {
    expect(calculateFineAccrual({
      principalAmount: 100_000,
      accruedSurchargeAmount: 0,
      surchargeAmount: 50_000,
      nextSurchargeAt,
      now: nextSurchargeAt,
      status: 'UNPAID',
    })).toEqual({
      intervals: 1,
      surchargeToAdd: 50_000,
      totalDue: 150_000,
      nextSurchargeAt: new Date('2026-08-28T16:00:00.000Z'),
    });
  });

  it('catches up every elapsed 24-hour interval after rejected proof', () => {
    const result = calculateFineAccrual({
      principalAmount: 100_000,
      accruedSurchargeAmount: 50_000,
      surchargeAmount: 50_000,
      nextSurchargeAt,
      now: new Date('2026-08-29T16:00:01.000Z'),
      status: 'UNPAID',
    });
    expect(result.intervals).toBe(3);
    expect(result.totalDue).toBe(300_000);
  });

  it('pauses accrual while a proof is pending', () => {
    const result = calculateFineAccrual({
      principalAmount: 100_000,
      accruedSurchargeAmount: 0,
      surchargeAmount: 50_000,
      nextSurchargeAt,
      now: new Date('2026-09-01T16:00:00.000Z'),
      status: 'PENDING_VERIFICATION',
    });
    expect(result.intervals).toBe(0);
    expect(result.totalDue).toBe(100_000);
  });

  it('does not accrue before due or when surcharge is zero', () => {
    expect(calculateFineAccrual({
      principalAmount: 1,
      accruedSurchargeAmount: 0,
      surchargeAmount: 1,
      nextSurchargeAt,
      now: new Date('2026-08-27T15:59:59.000Z'),
      status: 'UNPAID',
    }).intervals).toBe(0);
    expect(calculateFineAccrual({
      principalAmount: 1,
      accruedSurchargeAmount: 0,
      surchargeAmount: 0,
      nextSurchargeAt,
      now: nextSurchargeAt,
      status: 'UNPAID',
    }).intervals).toBe(0);
  });

  it('requires full payment', () => {
    expect(() => validateFullFinePayment(150_000, 150_000)).not.toThrow();
    expect(() => validateFullFinePayment(100_000, 150_000)).toThrow(ValidationError);
  });

  it('rejects unsafe money values', () => {
    expect(() => calculateFineAccrual({
      principalAmount: 0,
      accruedSurchargeAmount: 0,
      surchargeAmount: 1,
      nextSurchargeAt,
      now: nextSurchargeAt,
      status: 'UNPAID',
    })).toThrow(ValidationError);
    expect(() => validateFullFinePayment(0, 1)).toThrow(ValidationError);
  });

  it('accepts one image up to 10 MB and rejects other evidence', () => {
    expect(() => validateFinePaymentImage({ contentType: 'image/png', size: 1024 })).not.toThrow();
    expect(() => validateFinePaymentImage({ contentType: 'application/pdf', size: 1024 })).toThrow(ValidationError);
    expect(() => validateFinePaymentImage({ contentType: 'image/png', size: 10 * 1_024 * 1_024 + 1 })).toThrow(ValidationError);
  });
});
