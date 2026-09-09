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
  id: '2026-09-09.1',
  title: 'ปรับกฎเช็กชื่อและแจ้งลา',
  added: [],
  improved: [
    'จัดรายชื่อสมาชิกเป็นหมวดพร้อมเส้นคั่นให้อ่านง่ายขึ้น และย้ายกลุ่มสำรองไว้ล่างสุด',
  ],
  fixed: [
    'ผู้ที่แจ้งลาแล้วจะไม่สามารถเช็กชื่อทับได้ และถ้าเช็กชื่อก่อนแล้วค่อยแจ้งลา ระบบจะเปลี่ยนผลจากมาเป็นลาให้ทันที',
  ],
};
