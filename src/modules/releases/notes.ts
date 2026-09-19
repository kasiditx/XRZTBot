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
  id: '2026-09-19.3',
  title: 'กู้คืนระบบและแก้การแจ้งสถานะหลังอัปเดต',
  added: [
    'ย้ายฐานข้อมูลหลักไป Railway PostgreSQL พร้อมกู้คืนข้อมูลสมาชิก เงินกองกลาง Stock ค่าปรับ ใบลา และรอบส่งเงินเดิม',
  ],
  improved: [
    'เมื่อบอทเริ่มทำงานสำเร็จ ระบบจะรีเฟรชแผงสถานะและส่งประกาศพร้อมใช้งานล่าสุดลงท้าย Channel สถานะบอท',
    'ระบบจะปลุก Scheduler ทันทีหลังสร้างงานประกาศอัปเดต เพื่อให้ข่าวอัปเดตถูกส่งโดยไม่ต้องรอรอบตรวจถัดไป',
  ],
  fixed: [
    'แก้กรณีฐานข้อมูลระบุว่า Bot ใช้งานได้ปกติอยู่แล้ว ทำให้ไม่มีข้อความสถานะใหม่หลัง Deploy',
    'แก้ประกาศอัปเดตไม่ถูกส่งเมื่อ Scheduler เข้าสู่ช่วงพักรอระยะยาว',
  ],
};
