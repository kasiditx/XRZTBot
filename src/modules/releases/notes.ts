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
  id: '2026-09-18.2',
  title: 'แจ้งเตือนค่าปรับและคั่นวันเช็กชื่อ',
  added: [
    'เพิ่มการแจ้งเตือนรายวันพร้อมแท็กสมาชิกสำหรับค่าปรับที่ยังไม่ได้ชำระ',
    'เพิ่มเส้นคั่นวันที่ในช่องเช็กชื่อประจำวันก่อนรายการแรกของแต่ละวัน',
  ],
  improved: [
    'รายการค่าปรับค้างชำระจะกลับมาอยู่ด้านล่างของช่องพร้อมคั่นวันที่และปุ่มส่งหลักฐาน โดยลบข้อความเก่าเมื่อย้ายสำเร็จ',
  ],
  fixed: [],
};
