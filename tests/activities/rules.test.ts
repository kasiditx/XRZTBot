import { ValidationError } from '../../src/domain/errors.js';
import {
  parseActivityDateTime,
  parseScoreDefinitions,
  requireShortText,
  validateActivityWindow,
  validateSubmissionImages,
} from '../../src/modules/activities/rules.js';

describe('activity rules', () => {
  it('parses Thai short year, Buddhist year, and Gregorian year in Bangkok time', () => {
    expect(parseActivityDateTime('26/8/69 19:00', 'Asia/Bangkok').toISOString()).toBe('2026-08-26T12:00:00.000Z');
    expect(parseActivityDateTime('26/08/2569 19:00', 'Asia/Bangkok').toISOString()).toBe('2026-08-26T12:00:00.000Z');
    expect(parseActivityDateTime('26/08/2026 19:00', 'Asia/Bangkok').toISOString()).toBe('2026-08-26T12:00:00.000Z');
  });

  it('rejects malformed and impossible activity dates', () => {
    expect(() => parseActivityDateTime('2026-08-26 19:00', 'Asia/Bangkok')).toThrow(ValidationError);
    expect(() => parseActivityDateTime('31/02/69 19:00', 'Asia/Bangkok')).toThrow(ValidationError);
  });

  it('parses unique score definitions', () => {
    expect(parseScoreDefinitions('Loop A=50\nLoop B = 100')).toEqual([
      { name: 'Loop A', points: 50 },
      { name: 'Loop B', points: 100 },
    ]);
  });

  it('rejects malformed, duplicate, empty, and excessive score definitions', () => {
    expect(() => parseScoreDefinitions('Loop A')).toThrow(ValidationError);
    expect(() => parseScoreDefinitions('Loop A=50\nloop a=100')).toThrow(ValidationError);
    expect(() => parseScoreDefinitions('')).toThrow(ValidationError);
    expect(() => parseScoreDefinitions(Array.from({ length: 26 }, (_, index) => `L${String(index)}=1`).join('\n'))).toThrow(ValidationError);
    expect(() => parseScoreDefinitions(`A=${String(Number.MAX_SAFE_INTEGER)}`)).toThrow(ValidationError);
  });

  it('validates scheduled and currently open windows', () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    expect(validateActivityWindow(new Date('2026-08-26T13:00:00.000Z'), new Date('2026-08-26T14:00:00.000Z'), now)).toBe('SCHEDULED');
    expect(validateActivityWindow(new Date('2026-08-26T11:00:00.000Z'), new Date('2026-08-26T14:00:00.000Z'), now)).toBe('OPEN');
    expect(() => validateActivityWindow(now, now, now)).toThrow(ValidationError);
    expect(() => validateActivityWindow(new Date('invalid'), new Date('invalid'), now)).toThrow(ValidationError);
    expect(() => validateActivityWindow(new Date('2026-08-26T10:00:00.000Z'), new Date('2026-08-26T11:00:00.000Z'), now)).toThrow(ValidationError);
  });

  it('requires one to five non-empty images', () => {
    expect(() => validateSubmissionImages([{ contentType: 'image/png', size: 1 }])).not.toThrow();
    expect(() => validateSubmissionImages([])).toThrow(ValidationError);
    expect(() => validateSubmissionImages(Array.from({ length: 6 }, () => ({ contentType: 'image/png', size: 1 })))).toThrow(ValidationError);
    expect(() => validateSubmissionImages([{ contentType: 'application/pdf', size: 1 }])).toThrow(ValidationError);
    expect(() => validateSubmissionImages([{ contentType: null, size: 1 }])).toThrow(ValidationError);
    expect(() => validateSubmissionImages([{ contentType: 'image/png', size: 0 }])).toThrow(ValidationError);
  });

  it('normalizes and bounds user text', () => {
    expect(requireShortText('  hello  ', 'field', 1, 10)).toBe('hello');
    expect(() => requireShortText('', 'field', 1, 10)).toThrow(ValidationError);
    expect(() => requireShortText('too long', 'field', 1, 3)).toThrow(ValidationError);
  });
});
