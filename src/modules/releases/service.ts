import { eq } from 'drizzle-orm';
import type { Database } from '../../infrastructure/db/client.js';
import { guildSettings, scheduledJobs } from '../../infrastructure/db/schema.js';
import { currentRelease, releaseNotesSchema, type ReleaseNotes } from './notes.js';

export const RELEASE_ANNOUNCEMENT_JOB = 'RELEASE_ANNOUNCEMENT';

export async function queueCurrentRelease(
  db: Database,
  guildId: string,
  release: ReleaseNotes | null = currentRelease,
): Promise<void> {
  if (release === null) return;
  const notes = releaseNotesSchema.parse(release);
  const [settings] = await db.select({ channelId: guildSettings.releaseChannelId })
    .from(guildSettings).where(eq(guildSettings.guildId, guildId)).limit(1);
  if (settings?.channelId == null) return;

  await db.insert(scheduledJobs).values({
    guildId,
    jobType: RELEASE_ANNOUNCEMENT_JOB,
    deduplicationKey: `release:${notes.id}`,
    // Snapshot the destination and content so retries cannot announce a different release.
    payload: { channelId: settings.channelId, notes },
    runAt: new Date(),
  }).onConflictDoNothing({ target: [scheduledJobs.guildId, scheduledJobs.deduplicationKey] });
}
