import { DateTime } from 'luxon';
import { ValidationError } from './errors.js';

const DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/u;
const DATE_TIME_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})$/u;

export function parseDateInput(value: string, label: string): string {
  const match = DATE_PATTERN.exec(value.trim());
  if (match === null) {
    throw new ValidationError(`${label}ต้องเป็น DD/MM/YYYY เช่น 27/08/2569`);
  }
  const date = DateTime.fromObject({
    year: normalizeYear(Number(match[3])),
    month: Number(match[2]),
    day: Number(match[1]),
  }, { zone: 'UTC' });
  const isoDate = date.toISODate();
  if (!date.isValid || isoDate === null) {
    throw new ValidationError(`${label}ไม่ถูกต้อง`);
  }
  return isoDate;
}

export function parseDateTimeInput(value: string, timezone: string, label: string): Date {
  const match = DATE_TIME_PATTERN.exec(value.trim());
  if (match === null) {
    throw new ValidationError(`${label}ต้องเป็น DD/MM/YYYY HH:mm เช่น 27/08/2569 19:00`);
  }
  const date = DateTime.fromObject({
    year: normalizeYear(Number(match[3])),
    month: Number(match[2]),
    day: Number(match[1]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  }, { zone: timezone });
  if (!date.isValid) {
    throw new ValidationError(`${label}ไม่ถูกต้อง`);
  }
  return date.toJSDate();
}

export function formatDateInput(isoDate: string): string {
  const date = DateTime.fromISO(isoDate, { zone: 'UTC' });
  if (!date.isValid || date.toISODate() !== isoDate) {
    throw new ValidationError('วันที่ไม่ถูกต้อง');
  }
  return formatBuddhistDate(date);
}

export function formatDateTimeInput(value: Date, timezone: string): string {
  const date = DateTime.fromJSDate(value, { zone: timezone });
  if (!date.isValid) {
    throw new ValidationError('Timezone ของ Server ไม่ถูกต้อง');
  }
  return `${formatBuddhistDate(date)} ${date.toFormat('HH:mm')}`;
}

export function formatLocalDateInput(value: Date, timezone: string): string {
  const date = DateTime.fromJSDate(value, { zone: timezone });
  if (!date.isValid) {
    throw new ValidationError('Timezone ของ Server ไม่ถูกต้อง');
  }
  return formatBuddhistDate(date);
}

function formatBuddhistDate(date: DateTime): string {
  return `${date.toFormat('dd/MM')}/${String(date.year + 543)}`;
}

function normalizeYear(rawYear: number): number {
  if (rawYear < 100) return rawYear + 1_957;
  if (rawYear >= 2_400) return rawYear - 543;
  return rawYear;
}
