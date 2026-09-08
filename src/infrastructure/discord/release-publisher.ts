import { createHash } from 'node:crypto';
import { EmbedBuilder, ChannelType, type Client, type MessageCreateOptions, type SendableChannels } from 'discord.js';
import { z } from 'zod';
import { releaseNotesSchema, type ReleaseNotes } from '../../modules/releases/notes.js';
import type { JobHandler } from '../../modules/scheduler/service.js';
import { miruColors } from './theme.js';

const payloadSchema = z.object({
  channelId: z.string().regex(/^\d+$/),
  notes: releaseNotesSchema,
});
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 50;

export function buildReleaseAnnouncement(input: ReleaseNotes): MessageCreateOptions {
  const notes = releaseNotesSchema.parse(input);
  const sections = [
    section('✨ อัปเดตอะไร', [...notes.added, ...notes.improved]),
    section('🛠️ แก้ไขอะไร', notes.fixed),
  ].filter((value) => value.length > 0);
  const description = sections.join('\n\n');
  if (description.length > 4_096) throw new Error('Release announcement exceeds Discord description limit');
  return {
    embeds: [new EmbedBuilder()
      .setColor(miruColors.primary)
      .setTitle('╭・🤖 ข่าวอัปเดตบอท ✦')
      .setDescription(description)
      .setFooter({ text: releaseFooter(notes.id) })],
    allowedMentions: { parse: [] },
  };
}

function section(title: string, items: readonly string[]): string {
  return items.length === 0 ? '' : `**${title}**\n${items.map((item) => `・${item}`).join('\n')}`;
}

function releaseFooter(releaseId: string): string {
  return `╰・MiruBot • อัปเดต ${releaseId}`;
}

export function createReleaseAnnouncementHandler(client: Client): JobHandler {
  return async (job) => {
    const { channelId, notes } = payloadSchema.parse(job.payload);
    const channel = await client.channels.fetch(channelId);
    if (channel === null
      || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
      || channel.guildId !== job.guildId) {
      throw new Error('Release destination must be a text or announcement channel in the configured guild');
    }
    const botUserId = client.user?.id;
    if (botUserId === undefined) throw new Error('Discord client is not ready for release announcements');
    if (await hasAnnouncement(channel, botUserId, notes.id, job.createdAt)) return;

    await channel.send({
      ...buildReleaseAnnouncement(notes),
      nonce: createHash('sha256').update(`${job.guildId}:${notes.id}`).digest('hex').slice(0, 24),
      enforceNonce: true,
    });
  };
}

async function hasAnnouncement(
  channel: SendableChannels,
  botUserId: string,
  releaseId: string,
  queuedAt: Date,
): Promise<boolean> {
  let before: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const messages = await channel.messages.fetch({ limit: HISTORY_PAGE_SIZE, ...(before === undefined ? {} : { before }) });
    for (const message of messages.values()) {
      if (message.author.id === botUserId && message.embeds.some((embed) => embed.footer?.text === releaseFooter(releaseId))) {
        return true;
      }
    }
    const oldest = messages.last();
    if (oldest === undefined || messages.size < HISTORY_PAGE_SIZE || oldest.createdTimestamp < queuedAt.getTime()) return false;
    before = oldest.id;
  }
  // Do not send blindly if an earlier successful delivery cannot be ruled out.
  throw new Error('Release history scan limit reached; check channel history before retrying');
}
