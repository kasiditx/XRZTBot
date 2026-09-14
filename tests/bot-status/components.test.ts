import {
  buildBotStatusAlert,
  buildBotStatusPanel,
} from '../../src/infrastructure/discord/bot-status-components.js';

const updatedAt = new Date('2026-09-14T05:00:00.000Z');

describe('bot status Discord components', () => {
  it('shows an operational status with the actor and update time', () => {
    const message = buildBotStatusPanel({
      status: 'OPERATIONAL',
      detail: 'อัปเดตระบบเสร็จแล้ว',
      actorDiscordUserId: '700000000000000001',
      updatedAt,
    });
    const embed = message.embeds[0]?.toJSON();

    expect(embed?.color).toBe(0x57f287);
    expect(embed?.description).toContain('🟢 ใช้งานได้ปกติ');
    expect(embed?.description).toContain('อัปเดตระบบเสร็จแล้ว');
    expect(embed?.description).toContain('<@700000000000000001>');
    expect(embed?.description).toContain('<t:1789362000:F>');
    expect(message.allowedMentions).toEqual({ parse: [] });
  });

  it('warns members to stop using commands while updating', () => {
    const message = buildBotStatusPanel({
      status: 'UPDATING',
      detail: null,
      actorDiscordUserId: '700000000000000001',
      updatedAt,
    });
    const embed = message.embeds[0]?.toJSON();

    expect(embed?.color).toBe(0xfee75c);
    expect(embed?.description).toContain('🟠 กำลังอัปเดต');
    expect(embed?.description).toContain('งดใช้งานคำสั่งของ Bot ชั่วคราว');
  });

  it('mentions only the configured leader, deputy and member roles in notifications', () => {
    const message = buildBotStatusAlert({
      status: 'UPDATING',
      detail: 'ใช้เวลาประมาณ 10 นาที',
      actorDiscordUserId: '700000000000000001',
      updatedAt,
    }, ['800000000000000001', '800000000000000002', '800000000000000003']);

    expect(message.content).toBe('<@&800000000000000001> <@&800000000000000002> <@&800000000000000003>');
    expect(message.allowedMentions).toEqual({
      parse: [],
      roles: ['800000000000000001', '800000000000000002', '800000000000000003'],
    });
    expect(message.embeds[0]?.toJSON().description).toContain('ใช้เวลาประมาณ 10 นาที');
  });
});
