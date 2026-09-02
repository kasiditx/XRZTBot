import { buildFineAnnouncement } from '../../src/infrastructure/discord/fine-components.js';
import type { FineView } from '../../src/modules/fines/service.js';

describe('fine Discord components', () => {
  it('shows who was fined and disables payment after approval', () => {
    const now = new Date('2026-08-27T10:00:00.000Z');
    const payload = buildFineAnnouncement({
      fine: {
        id: '00000000-0000-4000-8000-000000000001',
        guildId: 'guild-1',
        requestId: 'request-1',
        memberId: '00000000-0000-4000-8000-000000000002',
        reason: 'ทดสอบค่าปรับ',
        principalAmount: 100_000,
        surchargeAmount: 50_000,
        accruedSurchargeAmount: 0,
        dueAt: now,
        nextSurchargeAt: now,
        status: 'PAID',
        sourceType: 'MANUAL',
        sourceId: null,
        createdByDiscordUserId: '700000000000000001',
        publicChannelId: 'fine-channel',
        publicMessageId: 'fine-message',
        paidAt: now,
        createdAt: now,
        updatedAt: now,
      },
      member: {
        id: '00000000-0000-4000-8000-000000000002',
        discordUserId: '700000000000000002',
        inGameName: 'สมาชิกทดสอบ',
      },
      pendingProof: null,
    } satisfies FineView);

    const embed = payload.embeds[0]?.toJSON();
    const button = payload.components[0]?.toJSON().components[0];
    expect(embed?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '⌗・สมาชิก', value: '> <@700000000000000002>' }),
      expect.objectContaining({ name: '⌗・สถานะ', value: '> ชำระแล้ว' }),
    ]));
    expect(button).toEqual(expect.objectContaining({ label: 'ชำระแล้ว', disabled: true }));
  });
});
