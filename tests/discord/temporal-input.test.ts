import { ValidationError } from '../../src/domain/errors.js';
import {
  formatDateInput,
  formatDateTimeInput,
  formatLocalDateInput,
  parseDateInput,
  parseDateTimeInput,
} from '../../src/domain/temporal-input.js';

describe('single-page temporal input', () => {
  it('accepts short Buddhist, full Buddhist, and Gregorian dates', () => {
    expect(parseDateInput('27/08/69', 'วันที่')).toBe('2026-08-27');
    expect(parseDateInput('27/08/2569', 'วันที่')).toBe('2026-08-27');
    expect(parseDateInput('27/08/2026', 'วันที่')).toBe('2026-08-27');
  });

  it('parses a Bangkok date and time into the correct instant', () => {
    expect(parseDateTimeInput('27/08/2569 19:30', 'Asia/Bangkok', 'เวลา').toISOString())
      .toBe('2026-08-27T12:30:00.000Z');
  });

  it('formats values for editing in one modal', () => {
    expect(formatDateInput('2026-08-27')).toBe('27/08/2569');
    expect(formatDateTimeInput(new Date('2026-08-27T12:30:00.000Z'), 'Asia/Bangkok'))
      .toBe('27/08/2569 19:30');
    expect(formatLocalDateInput(new Date('2026-08-26T18:30:00.000Z'), 'Asia/Bangkok'))
      .toBe('27/08/2569');
  });

  it('rejects impossible or malformed input', () => {
    expect(() => parseDateInput('31/02/2569', 'วันที่')).toThrow(ValidationError);
    expect(() => parseDateTimeInput('27/08/2569', 'Asia/Bangkok', 'เวลา')).toThrow(ValidationError);
  });
});
