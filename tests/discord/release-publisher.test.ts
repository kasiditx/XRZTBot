import { jest } from '@jest/globals';
import { ChannelType, Collection, type Client, type Message, type MessageCreateOptions } from 'discord.js';
import { buildReleaseAnnouncement, createReleaseAnnouncementHandler } from '../../src/infrastructure/discord/release-publisher.js';
import { currentRelease, type ReleaseNotes } from '../../src/modules/releases/notes.js';
import type { ScheduledJob } from '../../src/modules/scheduler/service.js';

const notes: ReleaseNotes = { id: '2026-09-08.1', title: 'อัปเดตแล้วนะ', added: ['เพิ่มช่องข่าว'], improved: [], fixed: ['แก้ปุ่มกด'] };
const job: ScheduledJob = {
  guildId: '100', payload: { channelId: '200', notes }, createdAt: new Date('2026-09-08T00:00:00Z'),
  updatedAt: new Date('2026-09-08T00:00:00Z'), id: '00000000-0000-4000-8000-000000000001',
  status: 'RUNNING', jobType: 'RELEASE_ANNOUNCEMENT', deduplicationKey: `release:${notes.id}`,
  runAt: new Date('2026-09-08T00:00:00Z'), attempts: 1, maxAttempts: 5,
  lockedAt: new Date('2026-09-08T00:00:00Z'), lockedBy: 'test-worker', completedAt: null, lastError: null,
};

function message(id: string, authorId: string, footer: string, createdTimestamp = Date.now()): Message {
  return { id, author: { id: authorId }, embeds: [{ footer: { text: footer } }], createdTimestamp } as Message;
}

function setup() {
  const fetchHistory = jest.fn<() => Promise<Collection<string, Message>>>().mockResolvedValue(new Collection());
  const send = jest.fn<(options: MessageCreateOptions) => Promise<unknown>>().mockResolvedValue({ id: '300' });
  const channel = { type: ChannelType.GuildText, guildId: '100', messages: { fetch: fetchHistory }, send };
  const fetchChannel = jest.fn<() => Promise<typeof channel | null>>().mockResolvedValue(channel);
  const client = { user: { id: '999' }, channels: { fetch: fetchChannel } } as unknown as Client;
  return { fetchHistory, send, channel, fetchChannel, handler: createReleaseAnnouncementHandler(client) };
}

describe('release announcements', () => {
  it('formats prepared notes and hides empty sections without mentions', () => {
    const result = buildReleaseAnnouncement({ ...notes, improved: ['ปรับการแสดงผล'] });
    const serialized = JSON.stringify(result);
    const embed = JSON.parse(JSON.stringify(result.embeds?.[0])) as { description: string };
    expect(embed.description).toBe('**✨ อัปเดตอะไร**\n・เพิ่มช่องข่าว\n・ปรับการแสดงผล\n\n**🛠️ แก้ไขอะไร**\n・แก้ปุ่มกด');
    expect(serialized).not.toContain(notes.title);
    expect(serialized).not.toContain('แจ้งแอดมิน');
    expect(JSON.stringify(buildReleaseAnnouncement({ ...notes, fixed: [] }))).not.toContain('แก้ไขอะไร');
    expect(result.allowedMentions).toEqual({ parse: [] });
    expect(() => buildReleaseAnnouncement(currentRelease!)).not.toThrow();
  });

  it('rejects empty notes, unsafe release identifiers and excessive content', () => {
    expect(() => buildReleaseAnnouncement({ ...notes, added: [], fixed: [] })).toThrow();
    expect(() => buildReleaseAnnouncement({ ...notes, id: '@everyone' })).toThrow();
    expect(() => buildReleaseAnnouncement({ ...notes, added: ['a'.repeat(251)] })).toThrow();
    expect(() => buildReleaseAnnouncement({ ...notes, fixed: Array<string>(6).fill('แก้แล้ว') })).toThrow();
  });

  it('keeps maximum allowed notes within the Discord embed limit', () => {
    const items = Array<string>(5).fill('ก'.repeat(250));
    const result = buildReleaseAnnouncement({ ...notes, title: 'ก'.repeat(120), added: items, improved: items, fixed: items });
    const embed = JSON.parse(JSON.stringify(result.embeds?.[0])) as { description: string };
    expect(embed.description.length).toBeLessThanOrEqual(4096);
  });

  it('sends new releases with a stable nonce across retries', async () => {
    const { handler, send } = setup();
    await handler(job);
    await handler(job);
    expect(send.mock.calls[0]?.[0].nonce).toBe(send.mock.calls[1]?.[0].nonce);
    expect(send.mock.calls[0]?.[0].enforceNonce).toBe(true);
  });

  it('recovers a delivery before scheduler completion without sending again', async () => {
    const { handler, send, fetchHistory } = setup();
    fetchHistory.mockResolvedValue(new Collection([['300', message('300', '999', '╰・MiruBot • อัปเดต 2026-09-08.1')]]));
    await handler(job);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not trust another user posting the same release footer', async () => {
    const { handler, send, fetchHistory } = setup();
    fetchHistory.mockResolvedValue(new Collection([['300', message('300', '888', '╰・MiruBot • อัปเดต 2026-09-08.1')]]));
    await handler(job);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('paginates past recent messages to recover an older delivery', async () => {
    const { handler, send, fetchHistory } = setup();
    fetchHistory.mockResolvedValueOnce(new Collection(Array.from({ length: 100 }, (_, i) => {
      const id = String(1000 - i);
      return [id, message(id, '999', 'other release')] as [string, Message];
    }))).mockResolvedValueOnce(new Collection([['300', message('300', '999', '╰・MiruBot • อัปเดต 2026-09-08.1')]]));
    await handler(job);
    expect(fetchHistory).toHaveBeenNthCalledWith(2, { limit: 100, before: '901' });
    expect(send).not.toHaveBeenCalled();
  });

  it('fails safely when history cannot be checked', async () => {
    const { handler, send, fetchHistory } = setup();
    fetchHistory.mockRejectedValue(new Error('Missing permissions'));
    await expect(handler(job)).rejects.toThrow('Missing permissions');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send when the history scan limit is reached', async () => {
    const { handler, send, fetchHistory } = setup();
    fetchHistory.mockResolvedValue(new Collection(Array.from({ length: 100 }, (_, i) => {
      const id = String(1000 - i);
      return [id, message(id, '999', 'other release')] as [string, Message];
    })));
    await expect(handler(job)).rejects.toThrow('Release history scan limit reached');
    expect(fetchHistory).toHaveBeenCalledTimes(50);
    expect(send).not.toHaveBeenCalled();
  });

  it('propagates send errors to the durable scheduler for retry', async () => {
    const { handler, send } = setup();
    send.mockRejectedValueOnce(new Error('Discord unavailable'));
    await expect(handler(job)).rejects.toThrow('Discord unavailable');
    await handler(job);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects missing channels and destinations in another guild', async () => {
    const { handler, send, channel, fetchChannel } = setup();
    fetchChannel.mockResolvedValueOnce(null);
    await expect(handler(job)).rejects.toThrow('Release destination');
    channel.guildId = 'different-guild';
    await expect(handler(job)).rejects.toThrow('Release destination');
    expect(send).not.toHaveBeenCalled();
  });
});
