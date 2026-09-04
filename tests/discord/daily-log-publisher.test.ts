import type { MessageCreateOptions, SendableChannels } from 'discord.js';
import { jest } from '@jest/globals';
import {
  buildDailyLogSeparator,
  DailyLogPublisher,
  type DailyLogMarkerRepository,
} from '../../src/infrastructure/discord/daily-log-publisher.js';

class InMemoryMarkerRepository implements DailyLogMarkerRepository {
  public readonly published = new Map<string, string>();
  private readonly claimed = new Set<string>();

  public claim(guildId: string, channelId: string, localDate: string): Promise<boolean> {
    const key = this.key(guildId, channelId, localDate);
    if (this.claimed.has(key)) return Promise.resolve(false);
    this.claimed.add(key);
    return Promise.resolve(true);
  }

  public markPublished(
    guildId: string,
    channelId: string,
    localDate: string,
    messageId: string,
  ): Promise<void> {
    this.published.set(this.key(guildId, channelId, localDate), messageId);
    return Promise.resolve();
  }

  public release(guildId: string, channelId: string, localDate: string): Promise<void> {
    this.claimed.delete(this.key(guildId, channelId, localDate));
    return Promise.resolve();
  }

  private key(guildId: string, channelId: string, localDate: string): string {
    return `${guildId}:${channelId}:${localDate}`;
  }
}

function createSendableChannel(channelId = 'channel-1') {
  let nextMessageId = 1;
  const send = jest.fn((message: MessageCreateOptions) => {
    void message;
    return Promise.resolve({ id: `message-${nextMessageId++}` });
  });
  return {
    channel: { id: channelId, send } as unknown as SendableChannels,
    send,
  };
}

describe('DailyLogPublisher', () => {
  const firstDay = new Date('2026-09-04T04:35:00.000Z');
  const secondDay = new Date('2026-09-05T04:35:00.000Z');

  it('builds a long cute separator with the Thai Buddhist date', () => {
    expect(buildDailyLogSeparator(firstDay, 'Asia/Bangkok')).toBe(
      '━━━━━━━━━━ ୨୧ ✦ วันศุกร์ที่ 4 กันยายน 2569 ✦ ୨୧ ━━━━━━━━━━',
    );
  });

  it('sends one separator before the first log in each local day', async () => {
    const markers = new InMemoryMarkerRepository();
    const publisher = new DailyLogPublisher(markers);
    const { channel, send } = createSendableChannel();

    await publisher.send(channel, {
      guildId: 'guild-1',
      timezone: 'Asia/Bangkok',
      now: firstDay,
      message: { content: 'log 1' },
    });
    const restartedPublisher = new DailyLogPublisher(markers);
    await restartedPublisher.send(channel, {
      guildId: 'guild-1',
      timezone: 'Asia/Bangkok',
      now: firstDay,
      message: { content: 'log 2' },
    });
    await publisher.send(channel, {
      guildId: 'guild-1',
      timezone: 'Asia/Bangkok',
      now: secondDay,
      message: { content: 'log 3' },
    });

    expect(send.mock.calls.map(([message]) => message.content)).toEqual([
      buildDailyLogSeparator(firstDay, 'Asia/Bangkok'),
      'log 1',
      'log 2',
      buildDailyLogSeparator(secondDay, 'Asia/Bangkok'),
      'log 3',
    ]);
  });

  it('serializes concurrent logs so their shared channel gets only one separator', async () => {
    const publisher = new DailyLogPublisher(new InMemoryMarkerRepository());
    const { channel, send } = createSendableChannel();

    await Promise.all([
      publisher.send(channel, {
        guildId: 'guild-1',
        timezone: 'Asia/Bangkok',
        now: firstDay,
        message: { content: 'log 1' },
      }),
      publisher.send(channel, {
        guildId: 'guild-1',
        timezone: 'Asia/Bangkok',
        now: firstDay,
        message: { content: 'log 2' },
      }),
    ]);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]?.[0].content).toBe(buildDailyLogSeparator(firstDay, 'Asia/Bangkok'));
  });

  it('releases the date claim when Discord cannot send the separator', async () => {
    const markers = new InMemoryMarkerRepository();
    const publisher = new DailyLogPublisher(markers);
    const { channel, send } = createSendableChannel();
    send.mockRejectedValueOnce(new Error('Discord unavailable'));

    await expect(publisher.send(channel, {
      guildId: 'guild-1',
      timezone: 'Asia/Bangkok',
      now: firstDay,
      message: { content: 'log 1' },
    })).rejects.toThrow('Discord unavailable');

    await publisher.send(channel, {
      guildId: 'guild-1',
      timezone: 'Asia/Bangkok',
      now: firstDay,
      message: { content: 'log 2' },
    });

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1]?.[0].content).toBe(buildDailyLogSeparator(firstDay, 'Asia/Bangkok'));
  });
});
