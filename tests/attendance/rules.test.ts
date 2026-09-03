import { ValidationError } from '../../src/domain/errors.js';
import {
  buildAirdropRoundTimes,
  buildAttendanceRoundTimes,
  buildDailyAttendanceTitle,
  buildGeneralRoundTimes,
  classifyAttendance,
  currentAttendanceDate,
  parseAttendanceDate,
  validateAttendanceProof,
  validateWeekdays,
  type AttendanceEvidence,
} from '../../src/modules/attendance/rules.js';

const opensAt = new Date('2026-08-26T12:00:00.000Z');
const closesAt = new Date('2026-08-26T14:30:00.000Z');
const emergencyLeaveCutoff = new Date('2026-08-26T16:59:59.999Z');

function evidence(overrides: Partial<AttendanceEvidence> = {}): AttendanceEvidence {
  return { opensAt, closesAt, emergencyLeaveCutoff, checkedInAt: null, leaves: [], ...overrides };
}

describe('attendance classification', () => {
  it('marks an on-time check-in as present', () => {
    expect(classifyAttendance(evidence({ checkedInAt: new Date('2026-08-26T13:00:00.000Z') }))).toBe('PRESENT');
  });

  it('marks pre-submitted leave without check-in as leave', () => {
    expect(classifyAttendance(evidence({
      leaves: [{ submittedAt: new Date('2026-08-25T12:00:00.000Z'), coversAttendanceDate: true }],
    }))).toBe('LEAVE');
  });

  it('treats check-in after an existing leave as present', () => {
    expect(classifyAttendance(evidence({
      checkedInAt: new Date('2026-08-26T13:00:00.000Z'),
      leaves: [{ submittedAt: new Date('2026-08-25T12:00:00.000Z'), coversAttendanceDate: true }],
    }))).toBe('PRESENT');
  });

  it('marks leave after check-in and before midnight cutoff as emergency leave', () => {
    expect(classifyAttendance(evidence({
      checkedInAt: new Date('2026-08-26T13:00:00.000Z'),
      leaves: [{ submittedAt: new Date('2026-08-26T15:30:00.000Z'), coversAttendanceDate: true }],
    }))).toBe('EMERGENCY_LEAVE');
  });

  it('marks no check-in and leave after close as absent', () => {
    expect(classifyAttendance(evidence({
      leaves: [{ submittedAt: new Date('2026-08-26T15:00:00.000Z'), coversAttendanceDate: true }],
    }))).toBe('ABSENT');
  });

  it('ignores leave outside the attendance date', () => {
    expect(classifyAttendance(evidence({
      leaves: [{ submittedAt: new Date('2026-08-25T12:00:00.000Z'), coversAttendanceDate: false }],
    }))).toBe('ABSENT');
  });

  it('rejects invalid windows and check-ins outside the window', () => {
    expect(() => classifyAttendance(evidence({ closesAt: opensAt }))).toThrow(ValidationError);
    expect(() => classifyAttendance(evidence({ emergencyLeaveCutoff: new Date('2026-08-26T14:00:00.000Z') }))).toThrow(ValidationError);
    expect(() => classifyAttendance(evidence({ checkedInAt: new Date('2026-08-26T11:00:00.000Z') }))).toThrow(ValidationError);
  });
});

describe('attendance input parsing', () => {
  it('uses the current Bangkok date and generates a Buddhist-year daily title', () => {
    const now = new Date('2026-08-26T18:30:00.000Z');

    const attendanceDate = currentAttendanceDate(now, 'Asia/Bangkok');

    expect(attendanceDate).toBe('2026-08-27');
    expect(buildDailyAttendanceTitle(attendanceDate)).toBe('เช็กชื่อวันที่ 27/08/2569');
  });

  it('accepts Thai short Buddhist year and full Buddhist year', () => {
    expect(parseAttendanceDate('27/08/69')).toBe('2026-08-27');
    expect(parseAttendanceDate('27/08/2569')).toBe('2026-08-27');
    expect(parseAttendanceDate('27/08/2026')).toBe('2026-08-27');
  });

  it('builds Bangkok timestamps and an end-of-day emergency cutoff', () => {
    const times = buildAttendanceRoundTimes('2026-08-27', '19:00', '21:30', 'Asia/Bangkok');
    expect(times.opensAt.toISOString()).toBe('2026-08-27T12:00:00.000Z');
    expect(times.closesAt.toISOString()).toBe('2026-08-27T14:30:00.000Z');
    expect(times.emergencyLeaveCutoff.toISOString()).toBe('2026-08-27T16:59:59.999Z');
  });

  it('builds a lenient Airdrop proof window ten minutes around the event', () => {
    const times = buildAirdropRoundTimes(
      new Date('2026-08-27T14:00:00.000Z'),
      'Asia/Bangkok',
      10,
      10,
    );

    expect(times.attendanceDate).toBe('2026-08-27');
    expect(times.opensAt.toISOString()).toBe('2026-08-27T13:50:00.000Z');
    expect(times.closesAt.toISOString()).toBe('2026-08-27T14:10:00.000Z');
    expect(times.emergencyLeaveCutoff.toISOString()).toBe('2026-08-27T16:59:59.999Z');
  });

  it('keeps a midnight Airdrop in one round that crosses calendar dates', () => {
    const times = buildAirdropRoundTimes(
      new Date('2026-08-27T17:00:00.000Z'),
      'Asia/Bangkok',
      10,
      10,
    );

    expect(times.attendanceDate).toBe('2026-08-28');
    expect(times.opensAt.toISOString()).toBe('2026-08-27T16:50:00.000Z');
    expect(times.closesAt.toISOString()).toBe('2026-08-27T17:10:00.000Z');
    expect(times.emergencyLeaveCutoff.toISOString()).toBe('2026-08-28T16:59:59.999Z');
  });

  it('supports recurring attendance windows that close after midnight', () => {
    const times = buildAttendanceRoundTimes('2026-08-27', '23:50', '00:10', 'Asia/Bangkok');

    expect(times.opensAt.toISOString()).toBe('2026-08-27T16:50:00.000Z');
    expect(times.closesAt.toISOString()).toBe('2026-08-27T17:10:00.000Z');
    expect(times.emergencyLeaveCutoff.toISOString()).toBe('2026-08-28T16:59:59.999Z');
  });

  it('builds a Manual general session from explicit datetimes', () => {
    const times = buildGeneralRoundTimes(
      new Date('2026-08-27T12:00:00.000Z'),
      new Date('2026-08-27T15:00:00.000Z'),
      'Asia/Bangkok',
    );

    expect(times.attendanceDate).toBe('2026-08-27');
    expect(times.emergencyLeaveCutoff.toISOString()).toBe('2026-08-27T16:59:59.999Z');
  });

  it('rejects impossible dates, invalid Airdrop margins, and invalid weekdays', () => {
    expect(() => parseAttendanceDate('31/02/69')).toThrow(ValidationError);
    expect(() => buildAirdropRoundTimes(new Date('2026-08-27T14:00:00.000Z'), 'Asia/Bangkok', -1, 10)).toThrow(ValidationError);
    expect(() => validateWeekdays([])).toThrow(ValidationError);
    expect(() => validateWeekdays([0, 8])).toThrow(ValidationError);
    expect(validateWeekdays([7, 1, 1])).toEqual([1, 7]);
  });

  it('accepts one image proof up to 10 MB and rejects other uploads', () => {
    expect(() => validateAttendanceProof({ contentType: 'image/png', size: 1_024 })).not.toThrow();
    expect(() => validateAttendanceProof({ contentType: 'application/pdf', size: 1_024 })).toThrow(ValidationError);
    expect(() => validateAttendanceProof({ contentType: 'image/jpeg', size: 10 * 1_024 * 1_024 + 1 })).toThrow(ValidationError);
  });
});
