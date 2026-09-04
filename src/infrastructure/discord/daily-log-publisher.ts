import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { Message, MessageCreateOptions, SendableChannels } from 'discord.js';
import type { Database } from '../db/client.js';
import { discordLogDayMarkers } from '../db/schema.js';

export interface DailyLogMarkerRepository {
  claim(guildId: string, channelId: string, localDate: string): Promise<boolean>;
  markPublished(guildId: string, channelId: string, localDate: string, messageId: string): Promise<void>;
  release(guildId: string, channelId: string, localDate: string): Promise<void>;
}

export interface DailyLogMessageInput {
  readonly guildId: string;
  readonly timezone: string;
  readonly message: MessageCreateOptions;
  readonly now?: Date;
}

export class DrizzleDailyLogMarkerRepository implements DailyLogMarkerRepository {
  public constructor(private readonly db: Database) {}

  public async claim(guildId: string, channelId: string, localDate: string): Promise<boolean> {
    const inserted = await this.db
      .insert(discordLogDayMarkers)
      .values({ guildId, channelId, localDate })
      .onConflictDoNothing()
      .returning({ localDate: discordLogDayMarkers.localDate });
    return inserted.length === 1;
  }

  public async markPublished(
    guildId: string,
    channelId: string,
    localDate: string,
    messageId: string,
  ): Promise<void> {
    await this.db
      .update(discordLogDayMarkers)
      .set({ separatorMessageId: messageId })
      .where(and(
        eq(discordLogDayMarkers.guildId, guildId),
        eq(discordLogDayMarkers.channelId, channelId),
        eq(discordLogDayMarkers.localDate, localDate),
      ));
  }

  public async release(guildId: string, channelId: string, localDate: string): Promise<void> {
    await this.db
      .delete(discordLogDayMarkers)
      .where(and(
        eq(discordLogDayMarkers.guildId, guildId),
        eq(discordLogDayMarkers.channelId, channelId),
        eq(discordLogDayMarkers.localDate, localDate),
      ));
  }
}

export class DailyLogPublisher {
  private readonly channelTails = new Map<string, Promise<void>>();

  public constructor(private readonly markers: DailyLogMarkerRepository) {}

  public send(channel: SendableChannels, input: DailyLogMessageInput): Promise<Message> {
    return this.runSerially(channel.id, async () => {
      const now = input.now ?? new Date();
      const localDateTime = DateTime.fromJSDate(now).setZone(input.timezone).setLocale('th');
      if (!localDateTime.isValid) {
        throw new Error(`Invalid guild timezone: ${input.timezone}`);
      }
      const localDate = localDateTime.toISODate();
      if (localDate === null) {
        throw new Error(`Unable to resolve local date for timezone: ${input.timezone}`);
      }

      const claimed = await this.markers.claim(input.guildId, channel.id, localDate);
      if (claimed) {
        let separator: Message;
        try {
          separator = await channel.send({ content: buildDailyLogSeparator(now, input.timezone) });
        } catch (error: unknown) {
          await this.markers.release(input.guildId, channel.id, localDate).catch(() => undefined);
          throw error;
        }
        await this.markers.markPublished(input.guildId, channel.id, localDate, separator.id);
      }

      return channel.send(input.message);
    });
  }

  private runSerially<T>(channelId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.channelTails.get(channelId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.channelTails.set(channelId, tail);
    void tail.finally(() => {
      if (this.channelTails.get(channelId) === tail) {
        this.channelTails.delete(channelId);
      }
    });
    return result;
  }
}

export function buildDailyLogSeparator(now: Date, timezone: string): string {
  const localDateTime = DateTime.fromJSDate(now).setZone(timezone).setLocale('th');
  if (!localDateTime.isValid) {
    throw new Error(`Invalid guild timezone: ${timezone}`);
  }
  const dateLabel = localDateTime.toLocaleString({
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return `━━━━━━━━━━ ୨୧ ✦ ${dateLabel} ✦ ୨୧ ━━━━━━━━━━`;
}
