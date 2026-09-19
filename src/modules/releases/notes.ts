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
  id: '2026-09-20.1',
  title: 'จัดการผู้ส่งและค่าปรับรายคนหลังปิดรอบ',
  added: [
    'เพิ่มเมนูเลื่อนเวลาเริ่มค่าปรับและกำหนดค่าปรับครั้งแรกกับค่าปรับเพิ่มทุก 24 ชั่วโมงแยกรายคน',
  ],
  improved: [
    'รอบที่ปิดแล้วสามารถเปลี่ยนผู้ที่ต้องส่งหรือยกเว้นสมาชิกได้ โดยรายการที่ชำระแล้วและหลักฐานรอตรวจยังถูกป้องกัน',
    'รายการรอบจะแสดงเงื่อนไขค่าปรับรายคนเมื่อแตกต่างจากค่ามาตรฐานของรอบ',
  ],
  fixed: [
    'แก้ปุ่มจัดการผู้ส่งและยกเว้นถูกปิดทันทีเมื่อรอบส่งเงินครบกำหนด',
  ],
};
