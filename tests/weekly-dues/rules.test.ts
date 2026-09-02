import { ValidationError } from '../../src/domain/errors.js';
import {
  buildWeeklyOverdueFine,
  parseWeeklyDateRange,
  validateWeeklyPaymentImage,
} from '../../src/modules/weekly-dues/rules.js';

describe('weekly dues overdue conversion', () => {
  it('combines unpaid principal with the first penalty and preserves recurring penalty', () => {
    expect(buildWeeklyOverdueFine(100_000, 50_000, 25_000)).toEqual({
      principalAmount: 150_000,
      firstPenaltyAmount: 50_000,
      recurringPenaltyAmount: 25_000,
    });
  });

  it('rejects zero obligations, negatives, fractions, and overflow', () => {
    expect(() => buildWeeklyOverdueFine(0, 0, 0)).toThrow(ValidationError);
    expect(() => buildWeeklyOverdueFine(1, -1, 0)).toThrow(ValidationError);
    expect(() => buildWeeklyOverdueFine(1.5, 0, 0)).toThrow(ValidationError);
    expect(() => buildWeeklyOverdueFine(Number.MAX_SAFE_INTEGER, 1, 0)).toThrow(ValidationError);
  });
});

describe('weekly dues Discord input', () => {
  it('accepts Thai short year and Buddhist full year date ranges', () => {
    expect(parseWeeklyDateRange('24/08/69 - 30/08/69')).toEqual({ startsOn: '2026-08-24', endsOn: '2026-08-30' });
    expect(parseWeeklyDateRange('24/08/2569 - 30/08/2569')).toEqual({ startsOn: '2026-08-24', endsOn: '2026-08-30' });
  });

  it('rejects invalid and reversed date ranges', () => {
    expect(() => parseWeeklyDateRange('31/02/69 - 01/03/69')).toThrow(ValidationError);
    expect(() => parseWeeklyDateRange('30/08/69 - 24/08/69')).toThrow(ValidationError);
    expect(() => parseWeeklyDateRange('2026-08-24')).toThrow(ValidationError);
  });

  it('requires one valid image payload under 10 MB', () => {
    expect(() => validateWeeklyPaymentImage({ contentType: 'image/png', size: 1_024 })).not.toThrow();
    expect(() => validateWeeklyPaymentImage({ contentType: 'application/pdf', size: 1_024 })).toThrow(ValidationError);
    expect(() => validateWeeklyPaymentImage({ contentType: 'image/png', size: 11 * 1_024 * 1_024 })).toThrow(ValidationError);
  });
});
