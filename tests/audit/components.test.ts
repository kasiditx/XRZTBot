import { buildAuditLogMessage } from '../../src/infrastructure/discord/audit-components.js';
import type { AuditLog } from '../../src/modules/audit/service.js';

describe('Audit Discord component', () => {
  it('shows actor, action, reason and changed fields without pinging anyone', () => {
    const message = buildAuditLogMessage({
      id: '00000000-0000-4000-8000-000000000001',
      guildId: 'guild-1',
      actorDiscordUserId: '123456789012345678',
      action: 'MEMBER_REJECTED',
      entityType: 'MEMBER',
      entityId: '00000000-0000-4000-8000-000000000002',
      reason: 'ข้อมูลไม่ครบ',
      before: { status: 'PENDING', updatedAt: 'old', token: 'must-not-appear' },
      after: { status: 'REJECTED', updatedAt: 'new', token: 'changed-secret' },
      publicChannelId: null,
      publicMessageId: null,
      createdAt: new Date('2026-08-27T10:00:00.000Z'),
    } satisfies AuditLog);

    const embed = message.embeds[0]?.toJSON();
    expect(embed?.title).toBe('╭─・✦ 🛡️ MEMBER_REJECTED ✦');
    expect(embed?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '⌗・ผู้ดำเนินการ', value: '> <@123456789012345678>' }),
      expect.objectContaining({ name: '⌗・ข้อมูลที่เปลี่ยน', value: '> `status`' }),
      expect.objectContaining({ name: '⌗・เหตุผล', value: '> ข้อมูลไม่ครบ' }),
    ]));
    expect(JSON.stringify(embed)).not.toContain('must-not-appear');
    expect(JSON.stringify(embed)).not.toContain('changed-secret');
    expect(message.allowedMentions.parse).toEqual([]);
  });
});
