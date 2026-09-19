import { z } from 'zod';

const items = z.array(z.string().trim().min(1).max(250)).max(5).default([]);

export const releaseNotesSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  title: z.string().trim().min(1).max(120),
  added: items,
  improved: items,
  fixed: items,
}).refine((notes) => notes.added.length + notes.improved.length + notes.fixed.length > 0, {
  message: 'Release notes must contain at least one change',
});

export type ReleaseNotes = z.infer<typeof releaseNotesSchema>;

// Change the ID only for a new announcement; keep summaries about member-visible changes.
// Set to null for a deployment that should not announce anything.
export const currentRelease: ReleaseNotes | null = {
  id: '2026-09-20.2',
  title: 'ส่งเงินต่อหลังหมดเวลาและรวมค่าปรับในรอบเดิม',
  added: [
    'ยอดส่งเงินหลังหมดเวลาจะแสดงยอดเดิมรวมค่าปรับ และยังส่งหลักฐานผ่านรอบส่งเงินประจำสัปดาห์เดิมได้',
    'ระบบเพิ่มค่าปรับในยอดของสมาชิกทุก 24 ชั่วโมงตามเงื่อนไขของรอบหรือค่าที่กำหนดรายคน',
  ],
  improved: [
    'รอบส่งเงินจะปิดและปิดปุ่มส่งหลักฐานเมื่อสมาชิกที่ต้องส่งชำระครบหรือได้รับการยกเว้นครบแล้วเท่านั้น',
    'ค่าปรับรายสัปดาห์ที่ยังไม่ชำระในระบบเดิมจะถูกย้ายกลับเข้ารอบส่งเงินเดิมโดยอัตโนมัติ',
  ],
  fixed: [
    'แก้รอบส่งเงินถูกปิดทันทีเมื่อหมดเวลา ทำให้สมาชิกส่งยอดรวมค่าปรับผ่านรอบเดิมไม่ได้',
  ],
};
