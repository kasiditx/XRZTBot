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
  id: '2026-09-18.4',
  title: 'ระบบส่งของประจำสัปดาห์',
  added: [
    'เพิ่มรอบส่งของประจำสัปดาห์ กำหนดของหลายชนิด จำนวน และค่าปรับสินค้าได้',
    'สมาชิกส่งหลักฐานครบตามยอดครั้งเดียว และของจะเข้า Stock หลังหัวแก๊งหรือรองแก๊งอนุมัติ',
    'เพิ่มเมนูยกเว้นสมาชิกเป็นรายคน โดยตำแหน่งสำรองได้รับการยกเว้นอัตโนมัติ',
  ],
  improved: [
    'ช่องรายการส่งของประจำสัปดาห์จะแสดงเส้นคั่นวันที่ก่อนรายการแรกของแต่ละวัน',
    'รอบส่งเงินประจำสัปดาห์ที่เปิดอยู่สามารถกำหนดผู้ที่ต้องส่งหรือได้รับยกเว้นเป็นรายคนได้',
  ],
  fixed: [],
};
