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
  id: '2026-09-14.2',
  title: 'แจ้งสถานะบอทครบทุกยศสมาชิก',
  added: [],
  improved: [
    'การแจ้งสถานะ MiruBot จะแท็ก Leader, Deputy และ Member พร้อมกัน เพื่อให้สมาชิกทุกยศได้รับแจ้ง',
  ],
  fixed: [],
};
