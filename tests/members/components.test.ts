import {
  buildControlPanel,
  buildMemberRegistrationRequest,
  buildMemberRoster,
  buildRosterMemberSelector,
  buildRosterTitleSelector,
} from '../../src/infrastructure/discord/components.js';
import type { Member } from '../../src/infrastructure/db/schema.js';

function member(index: number, inGameName = `Member ${index.toString()}`): Member {
  const now = new Date('2026-08-27T12:00:00.000Z');
  return {
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    guildId: 'guild',
    discordUserId: (700000000000000000n + BigInt(index)).toString(),
    inGameName,
    status: 'ACTIVE',
    rosterTitle: null,
    requestedAt: now,
    decidedAt: now,
    decidedByDiscordUserId: '700000000000000099',
    departureReason: null,
    registrationRequestChannelId: null,
    registrationRequestMessageId: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('member roster Discord component', () => {
  it('shows every active member when the roster has no more than 25 members', () => {
    const members = Array.from({ length: 25 }, (_, index) => member(index + 1));
    const payload = buildMemberRoster(members);
    const embed = payload.embeds[0]?.toJSON();

    expect(embed?.description).toContain('1. 👤 **สมาชิก** — **Member 1**');
    expect(embed?.description).toContain('25. 👤 **สมาชิก** — **Member 25**');
    expect(embed?.footer?.text).toBe('╰─・สมาชิกทั้งหมด 25 คน • รายการ 1/1 • © xᴄʀᴜɪᴢᴛ・✦');
    expect(payload.components).toHaveLength(0);
  });

  it('keeps a longer roster in one display when its text fits and escapes member-supplied Markdown', () => {
    const members = Array.from({ length: 26 }, (_, index) => member(index + 1));
    members[25] = member(26, '**everyone**');
    const payload = buildMemberRoster(members);
    const embed = payload.embeds[0]?.toJSON();

    expect(embed?.description).toContain('26. 👤 **สมาชิก** — **\\*\\*everyone\\*\\***');
    expect(embed?.footer?.text).toBe('╰─・สมาชิกทั้งหมด 26 คน • รายการ 1/1 • © xᴄʀᴜɪᴢᴛ・✦');
    expect(payload.components).toEqual([]);
  });

  it('shows display-only gang titles in roster order', () => {
    const titledMembers = [
      { ...member(1, 'Leader Miru'), rosterTitle: 'HEAD' as const },
      { ...member(2, 'Deputy Miru'), rosterTitle: 'DEPUTY' as const },
      { ...member(3, 'Account Miru'), rosterTitle: 'ACCOUNTANT' as const },
      { ...member(4, 'Reserve Miru'), rosterTitle: 'RESERVE' as const },
      { ...member(5, 'General Miru'), rosterTitle: null },
    ];
    const embed = buildMemberRoster(titledMembers).embeds[0]?.toJSON();

    expect(embed?.description).toContain('1. 👑 **หัวแก๊ง** — **Leader Miru**');
    expect(embed?.description).toContain('2. ⭐ **รองแก๊ง** — **Deputy Miru**');
    expect(embed?.description).toContain('3. 💰 **บัญชีแก๊ง** — **Account Miru**');
    expect(embed?.description).toContain('4. 🛡️ **สำรอง** — **Reserve Miru**');
    expect(embed?.description).toContain('5. 👤 **สมาชิก** — **General Miru**');
  });
});

describe('member registration request Discord component', () => {
  it('gives gang leaders direct approve and reject actions for a pending request', () => {
    const pending = {
      ...member(1, 'Zixx Quint'),
      status: 'PENDING' as const,
      decidedAt: null,
      decidedByDiscordUserId: null,
    };
    const payload = buildMemberRegistrationRequest(pending);
    const embed = payload.embeds[0]?.toJSON();
    const actions = payload.components[0]?.toJSON();

    expect(embed?.title).toBe('╭─・✦ 🆕 คำขอลงทะเบียนสมาชิก ✦');
    expect(embed?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '⌗・ชื่อในเมือง', value: '> Zixx Quint' }),
      expect.objectContaining({ name: '⌗・สถานะ', value: '> ⏳ รอตรวจสอบ' }),
    ]));
    expect(actions?.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ custom_id: 'member:approve:00000000-0000-4000-8000-000000000001' }),
      expect.objectContaining({ custom_id: 'member:reject:00000000-0000-4000-8000-000000000001' }),
    ]));
  });

  it('removes leader actions and displays the final decision after approval', () => {
    const approved = { ...member(1, 'Zixx Quint'), status: 'ACTIVE' as const };
    const payload = buildMemberRegistrationRequest(approved);
    const embed = payload.embeds[0]?.toJSON();

    expect(embed?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '⌗・สถานะ', value: '> ✅ อนุมัติแล้ว' }),
    ]));
    expect(payload.components).toHaveLength(0);
  });
});

describe('member roster title controls', () => {
  it('replaces the old member button with the display-title workflow', () => {
    const panel = buildControlPanel();
    const firstButton = panel.components[0]?.toJSON().components[0];
    const embed = panel.embeds[0]?.toJSON();
    const memberField = embed?.fields?.find(({ name }) => name === '⌗・ระบบสมาชิกและกิจกรรม');
    const financeField = embed?.fields?.find(({ name }) => name === '⌗・การเงินและตู้แก๊ง');

    expect(firstButton).toMatchObject({ custom_id: 'control:members', label: 'จัดตำแหน่งสมาชิก' });
    expect(memberField?.value).toContain('👥 **จัดตำแหน่งสมาชิก** — กำหนดหัวแก๊ง รองแก๊ง บัญชี สำรอง หรือสมาชิกทั่วไป');
    expect(financeField?.value).toContain('🏦 **เงินกองกลาง** — บันทึกรายรับ–รายจ่าย ยอดตั้งต้น ย้อนรายการ และคำขอเบิกเงิน');
  });

  it('lets gang leaders choose a title and then a Discord member', () => {
    const titleSelector = buildRosterTitleSelector().components[0]?.toJSON().components[0];
    const activeMembers = [member(1, 'Bar Miru'), member(2, 'Lily Miru')];
    const memberSelector = buildRosterMemberSelector('HEAD', activeMembers).components[0]?.toJSON().components[0];

    expect(titleSelector).toMatchObject({ custom_id: 'member:roster_title' });
    expect(titleSelector?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'สำรอง', value: 'RESERVE' }),
    ]));
    expect(memberSelector).toMatchObject({
      custom_id: 'member:roster_member:HEAD:1',
      options: [
        expect.objectContaining({ label: 'Bar Miru', value: activeMembers[0]?.id }),
        expect.objectContaining({ label: 'Lily Miru', value: activeMembers[1]?.id }),
      ],
    });
  });
});
