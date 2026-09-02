import { buildWeeklyAnnouncement } from '../../src/infrastructure/discord/weekly-dues-components.js';
import type { WeeklyCollectionView } from '../../src/modules/weekly-dues/service.js';

const now = new Date('2026-08-31T04:00:00.000Z');

describe('weekly dues Discord components', () => {
  it('keeps the member channel announcement limited to submitting proof', () => {
    const payload = buildWeeklyAnnouncement({
      collection: {
        id: '11111111-1111-4111-8111-111111111111',
        guildId: 'guild',
        requestId: 'request',
        title: 'ส่งเงินประจำสัปดาห์',
        startsOn: '2026-08-31',
        endsOn: '2026-09-06',
        standardAmount: 100_000,
        overdueFineAmount: 50_000,
        recurringFineAmount: 50_000,
        conversionAt: now,
        isClosed: false,
        publicChannelId: null,
        publicMessageId: null,
        createdByDiscordUserId: '700000000000000001',
        createdAt: now,
        updatedAt: now,
      },
      obligations: [],
    } satisfies WeeklyCollectionView);
    const customIds = payload.components[0]?.toJSON().components.map((button) => (
      'custom_id' in button ? button.custom_id : null
    ));

    expect(customIds).toEqual(['weekly:pay:11111111-1111-4111-8111-111111111111']);
  });

  it('shows every member status in one continuous announcement instead of fixed-size fields', () => {
    const obligations = Array.from({ length: 13 }, (_, index) => ({
      obligation: {
        id: `obligation-${String(index + 1)}`,
        guildId: 'guild',
        collectionId: '11111111-1111-4111-8111-111111111111',
        memberId: `member-${String(index + 1)}`,
        amount: 100_000,
        status: 'UNPAID' as const,
        attachmentId: null,
        submittedAt: null,
        decidedAt: null,
        decidedByDiscordUserId: null,
        rejectionReason: null,
        convertedFineId: null,
        createdAt: now,
        updatedAt: now,
      },
      member: {
        id: `member-${String(index + 1)}`,
        discordUserId: `7000000000000000${String(index + 1).padStart(2, '0')}`,
        inGameName: `Member ${String(index + 1)}`,
      },
    }));
    const payload = buildWeeklyAnnouncement({
      collection: {
        id: '11111111-1111-4111-8111-111111111111', guildId: 'guild', requestId: 'request', title: 'ส่งเงินประจำสัปดาห์',
        startsOn: '2026-08-31', endsOn: '2026-09-06', standardAmount: 100_000, overdueFineAmount: 50_000,
        recurringFineAmount: 50_000, conversionAt: now, isClosed: false, publicChannelId: null, publicMessageId: null,
        createdByDiscordUserId: '700000000000000001', createdAt: now, updatedAt: now,
      },
      obligations,
    } satisfies WeeklyCollectionView);
    const embed = payload.embeds[0]?.toJSON();

    expect(embed?.description).toContain('สถานะสมาชิก (13 คน)');
    expect(embed?.description).toContain('<@700000000000000001>');
    expect(embed?.description).toContain('<@700000000000000013>');
    expect(embed?.fields).toBeUndefined();
  });
});
