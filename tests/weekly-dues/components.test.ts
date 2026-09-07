import {
  buildWeeklyAnnouncement,
  buildWeeklyCancellationModal,
  buildWeeklyPaymentModal,
} from '../../src/infrastructure/discord/weekly-dues-components.js';
import type { WeeklyCollectionView } from '../../src/modules/weekly-dues/service.js';

const now = new Date('2026-08-31T04:00:00.000Z');

describe('weekly dues Discord components', () => {
  it('builds payment modals for file upload and Discord Media Link', () => {
    const view = weeklyView();
    const fileModal = buildWeeklyPaymentModal(view, 100_000, 'FILE').toJSON();
    const linkModal = buildWeeklyPaymentModal(view, 100_000, 'LINK').toJSON();

    expect(fileModal.custom_id).toContain(':FILE:');
    expect(fileModal.components[1]).toMatchObject({ component: { type: 19, required: true } });
    expect(linkModal.custom_id).toContain(':LINK:');
    expect(linkModal.components[1]).toMatchObject({
      component: { type: 4, custom_id: 'weekly:payment_media_link', required: true },
    });
  });

  it('lets members submit proof and lets authorized staff cancel the collection', () => {
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
        cancelledAt: null,
        cancelledByDiscordUserId: null,
        cancellationReason: null,
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

    expect(customIds).toEqual([
      'weekly:pay:11111111-1111-4111-8111-111111111111',
      'weekly:cancel:11111111-1111-4111-8111-111111111111',
    ]);
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
        cancelledAt: null, cancelledByDiscordUserId: null, cancellationReason: null,
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

  it('shows a cancelled collection and disables every action', () => {
    const view = weeklyView();
    const cancelledAt = new Date('2026-09-01T04:00:00.000Z');
    const payload = buildWeeklyAnnouncement({
      ...view,
      collection: {
        ...view.collection,
        isClosed: true,
        cancelledAt,
        cancelledByDiscordUserId: '700000000000000099',
        cancellationReason: 'สร้างรอบผิดสัปดาห์',
        updatedAt: cancelledAt,
      },
    });
    const buttons = payload.components[0]?.toJSON().components;

    expect(payload.embeds[0]?.toJSON().color).toBe(0xed4245);
    expect(payload.embeds[0]?.toJSON().footer?.text).toContain('ยกเลิกรอบแล้ว');
    expect(payload.embeds[0]?.toJSON().description).toContain('สร้างรอบผิดสัปดาห์');
    expect(buttons).toHaveLength(2);
    expect(buttons?.every((button) => 'disabled' in button && button.disabled === true)).toBe(true);
  });

  it('requires a reason and explicit financial-impact confirmation before cancellation', () => {
    const modal = buildWeeklyCancellationModal('11111111-1111-4111-8111-111111111111').toJSON();

    expect(modal.components).toHaveLength(2);
    expect(modal.components[0]).toMatchObject({
      components: [{ custom_id: 'weekly:cancellation_reason', required: true }],
    });
    expect(modal.components[1]).toMatchObject({
      components: [{ custom_id: 'cancellation:confirm', required: true }],
    });
  });
});

function weeklyView(): WeeklyCollectionView {
  return {
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
      cancelledAt: null,
      cancelledByDiscordUserId: null,
      cancellationReason: null,
      publicChannelId: null,
      publicMessageId: null,
      createdByDiscordUserId: '700000000000000001',
      createdAt: now,
      updatedAt: now,
    },
    obligations: [],
  };
}
