import { ValidationError } from '../../domain/errors.js';
import { DateTime } from 'luxon';

export type AttendanceResult = 'PRESENT' | 'LEAVE' | 'EMERGENCY_LEAVE' | 'ABSENT';

export interface AttendanceRoundTimes {
  readonly attendanceDate: string;
  readonly opensAt: Date;
  readonly closesAt: Date;
  readonly emergencyLeaveCutoff: Date;
}

export interface LeaveEvidence {
  readonly submittedAt: Date;
  readonly coversAttendanceDate: boolean;
}

export interface AttendanceEvidence {
  readonly opensAt: Date;
  readonly closesAt: Date;
  readonly emergencyLeaveCutoff: Date;
  readonly checkedInAt: Date | null;
  readonly leaves: readonly LeaveEvidence[];
}

export interface AttendanceProofFile {
  readonly contentType: string | null;
  readonly size: number;
}

const MAX_ATTENDANCE_PROOF_BYTES = 10 * 1_024 * 1_024;

export function currentAttendanceDate(now: Date, timezone: string): string {
  const date = DateTime.fromJSDate(now, { zone: timezone });
  const isoDate = date.toISODate();
  if (!date.isValid || isoDate === null) {
    throw new ValidationError('Timezone ของ Server ไม่ถูกต้อง');
  }
  return isoDate;
}

export function buildDailyAttendanceTitle(attendanceDate: string): string {
  const date = DateTime.fromISO(attendanceDate, { zone: 'UTC' });
  if (!date.isValid || date.toFormat('yyyy-MM-dd') !== attendanceDate) {
    throw new ValidationError('วันที่เช็กชื่อไม่ถูกต้อง');
  }
  return `เช็กชื่อวันที่ ${date.toFormat('dd/MM')}/${String(date.year + 543)}`;
}

export function classifyAttendance(evidence: AttendanceEvidence): AttendanceResult {
  validateWindow(evidence);

  const coveringLeaves = evidence.leaves
    .filter((leave) => leave.coversAttendanceDate)
    .sort((left, right) => left.submittedAt.getTime() - right.submittedAt.getTime());

  if (evidence.checkedInAt !== null) {
    if (evidence.checkedInAt < evidence.opensAt || evidence.checkedInAt > evidence.closesAt) {
      throw new ValidationError('เวลาเช็กชื่อต้องอยู่ในช่วงเปิดเช็กชื่อ');
    }

    const emergencyLeave = coveringLeaves.find(
      (leave) => leave.submittedAt > evidence.checkedInAt! && leave.submittedAt <= evidence.emergencyLeaveCutoff,
    );

    return emergencyLeave === undefined ? 'PRESENT' : 'EMERGENCY_LEAVE';
  }

  const onTimeLeave = coveringLeaves.some((leave) => leave.submittedAt <= evidence.closesAt);
  return onTimeLeave ? 'LEAVE' : 'ABSENT';
}

function validateWindow(evidence: AttendanceEvidence): void {
  if (evidence.closesAt <= evidence.opensAt) {
    throw new ValidationError('เวลาปิดเช็กชื่อต้องอยู่หลังเวลาเปิด');
  }

  if (evidence.emergencyLeaveCutoff < evidence.closesAt) {
    throw new ValidationError('เวลาปิดรับลาเหตุฉุกเฉินต้องไม่อยู่ก่อนเวลาปิดเช็กชื่อ');
  }
}

export function parseAttendanceDate(value: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/u.exec(value.trim());
  if (match === null) {
    throw new ValidationError('วันที่ต้องเป็น DD/MM/YY เช่น 27/08/69');
  }
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? rawYear + 1_957 : rawYear >= 2_400 ? rawYear - 543 : rawYear;
  const date = DateTime.fromObject({ year, month: Number(match[2]), day: Number(match[1]) }, { zone: 'UTC' });
  if (!date.isValid) {
    throw new ValidationError('วันที่เช็กชื่อไม่ถูกต้อง');
  }
  return date.toFormat('yyyy-MM-dd');
}

export function buildAttendanceRoundTimes(
  attendanceDate: string,
  opensAtLocalTime: string,
  closesAtLocalTime: string,
  timezone: string,
): AttendanceRoundTimes {
  const openTime = parseLocalTime(opensAtLocalTime, 'เวลาเปิด');
  const closeTime = parseLocalTime(closesAtLocalTime, 'เวลาปิด');
  const date = DateTime.fromISO(attendanceDate, { zone: timezone });
  if (!date.isValid || date.toFormat('yyyy-MM-dd') !== attendanceDate) {
    throw new ValidationError('วันที่เช็กชื่อไม่ถูกต้อง');
  }
  const opensAt = date.set(openTime);
  const closeOnAttendanceDate = date.set(closeTime);
  const closesAt = closeOnAttendanceDate <= opensAt ? closeOnAttendanceDate.plus({ days: 1 }) : closeOnAttendanceDate;
  return {
    attendanceDate,
    opensAt: opensAt.toJSDate(),
    closesAt: closesAt.toJSDate(),
    emergencyLeaveCutoff: closesAt.endOf('day').toJSDate(),
  };
}

export function buildAirdropRoundTimes(
  eventAt: Date,
  timezone: string,
  opensBeforeMinutes = 10,
  closesAfterMinutes = 10,
): AttendanceRoundTimes {
  const event = DateTime.fromJSDate(eventAt, { zone: timezone });
  if (!event.isValid) {
    throw new ValidationError('วันเวลา Airdrop หรือ Timezone ไม่ถูกต้อง');
  }
  validateWindowMargin(opensBeforeMinutes, 'นาทีก่อน Airdrop');
  validateWindowMargin(closesAfterMinutes, 'นาทีหลัง Airdrop');
  if (opensBeforeMinutes + closesAfterMinutes === 0) {
    throw new ValidationError('ช่วงเช็กชื่อ Airdrop ต้องมากกว่า 0 นาที');
  }

  const attendanceDate = event.toISODate();
  if (attendanceDate === null) {
    throw new ValidationError('วันเวลา Airdrop ไม่ถูกต้อง');
  }
  const opensAt = event.minus({ minutes: opensBeforeMinutes });
  const closesAt = event.plus({ minutes: closesAfterMinutes });
  return {
    attendanceDate,
    opensAt: opensAt.toJSDate(),
    closesAt: closesAt.toJSDate(),
    emergencyLeaveCutoff: closesAt.endOf('day').toJSDate(),
  };
}

export function buildGeneralRoundTimes(opensAt: Date, closesAt: Date, timezone: string): AttendanceRoundTimes {
  const opens = DateTime.fromJSDate(opensAt, { zone: timezone });
  const closes = DateTime.fromJSDate(closesAt, { zone: timezone });
  if (!opens.isValid || !closes.isValid) {
    throw new ValidationError('วันเวลาเช็กชื่อหรือ Timezone ไม่ถูกต้อง');
  }
  if (closes <= opens) {
    throw new ValidationError('เวลาปิดเช็กชื่อต้องอยู่หลังเวลาเปิด');
  }
  const attendanceDate = opens.toISODate();
  if (attendanceDate === null) {
    throw new ValidationError('วันที่เช็กชื่อไม่ถูกต้อง');
  }
  return {
    attendanceDate,
    opensAt: opens.toJSDate(),
    closesAt: closes.toJSDate(),
    emergencyLeaveCutoff: closes.endOf('day').toJSDate(),
  };
}

export function parseLocalTime(value: string, label: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (match === null) {
    throw new ValidationError(`${label}ต้องเป็น HH:mm เช่น 19:00`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new ValidationError(`${label}ไม่ถูกต้อง`);
  }
  return { hour, minute };
}

export function validateAttendanceProof(file: AttendanceProofFile): void {
  const supportedContentTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (file.contentType === null || !supportedContentTypes.has(file.contentType)) {
    throw new ValidationError('หลักฐานเช็กชื่อต้องเป็นไฟล์รูปภาพ');
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ATTENDANCE_PROOF_BYTES) {
    throw new ValidationError('รูปหลักฐานต้องมีขนาดไม่เกิน 10 MB');
  }
}

function validateWindowMargin(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_440) {
    throw new ValidationError(`${label}ต้องเป็นจำนวนเต็มระหว่าง 0–1440`);
  }
}

export function validateWeekdays(values: readonly number[]): number[] {
  const weekdays = [...new Set(values)].sort((left, right) => left - right);
  if (weekdays.length === 0 || weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)) {
    throw new ValidationError('ต้องเลือกวันประจำอย่างน้อย 1 วัน ตั้งแต่วันจันทร์ถึงวันอาทิตย์');
  }
  return weekdays;
}
