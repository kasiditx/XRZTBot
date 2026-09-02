import { ValidationError } from '../../src/domain/errors.js';
import { calculateNextBalance, validateTreasuryEvidence } from '../../src/modules/treasury/rules.js';

describe('treasury balance', () => {
  it('applies income and expense without allowing negative balance', () => {
    expect(calculateNextBalance(100_000, 50_000)).toBe(150_000);
    expect(calculateNextBalance(100_000, -100_000)).toBe(0);
    expect(() => calculateNextBalance(100_000, -100_001)).toThrow(ValidationError);
  });

  it('rejects invalid or unsafe inputs', () => {
    expect(() => calculateNextBalance(-1, 1)).toThrow(ValidationError);
    expect(() => calculateNextBalance(0, 0)).toThrow(ValidationError);
    expect(() => calculateNextBalance(Number.MAX_SAFE_INTEGER, 1)).toThrow(ValidationError);
  });
});

describe('treasury evidence', () => {
  it('accepts an image up to 10 MB', () => {
    expect(() => validateTreasuryEvidence({ contentType: 'image/jpeg', size: 1024 })).not.toThrow();
  });

  it('rejects non-images and oversized files', () => {
    expect(() => validateTreasuryEvidence({ contentType: 'application/pdf', size: 1024 })).toThrow(ValidationError);
    expect(() => validateTreasuryEvidence({ contentType: 'image/png', size: 10 * 1_024 * 1_024 + 1 })).toThrow(ValidationError);
  });
});
