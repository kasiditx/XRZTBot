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
  id: '2026-09-15.3',
  title: 'ปรับการตอบสนองของปุ่มและแบบฟอร์มทุกระบบ',
  added: [],
  improved: [
    'ปุ่มอนุมัติและแบบฟอร์มที่บันทึกข้อมูลในระบบสมาชิก กิจกรรม เช็กชื่อ ใบลา ค่าปรับ เงินกองกลาง ส่งเงิน Stock และตำแหน่ง Fight ตอบรับ Discord ก่อนเริ่มงานที่อาจใช้เวลานาน',
  ],
  fixed: [
    'แก้อาการรายการบันทึกสำเร็จแล้วแต่ Discord แจ้งว่า Bot ไม่ตอบสนอง และลดกรณีปุ่มเก่าค้างให้กดซ้ำหลังดำเนินการแล้ว',
  ],
};
