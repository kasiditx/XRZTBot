import type { FightPosition, Member } from '../../src/infrastructure/db/schema.js';
import {
  buildFightPositionAdminPanel,
  buildFightPositionAssignedMemberSelector,
  buildFightPositionAssignmentSelector,
  buildFightPositionMemberSelector,
  buildFightPositionSummary,
} from '../../src/infrastructure/discord/fight-position-components.js';
import { buildControlPanel } from '../../src/infrastructure/discord/components.js';

const now = new Date('2026-08-28T06:00:00.000Z');

describe('fight position Discord components', () => {
  it('adds the Fight position workflow to the main Control Panel', () => {
    const buttons = buildControlPanel().components.flatMap((row) => row.toJSON().components);
    expect(buttons).toEqual(expect.arrayContaining([
      expect.objectContaining({ custom_id: 'control:fight_positions', label: 'ตำแหน่ง Fight' }),
    ]));
  });

  it('provides add, assign, publish, rename and delete controls', () => {
    const panel = buildFightPositionAdminPanel([position(1, 'Main Fight')]);
    const buttons = panel.components[0]?.toJSON().components;
    const selector = panel.components[1]?.toJSON().components[0];

    expect(buttons).toEqual(expect.arrayContaining([
      expect.objectContaining({ custom_id: 'fight:add' }),
      expect.objectContaining({ custom_id: 'fight:assign' }),
      expect.objectContaining({ custom_id: 'fight:edit_assignment' }),
      expect.objectContaining({ custom_id: 'fight:publish' }),
    ]));
    expect(selector).toMatchObject({
      custom_id: 'fight:manage_select:1',
      options: [expect.objectContaining({ label: 'Main Fight', value: position(1).id })],
    });
  });

  it('uses only the supplied active registry members in assignment controls', () => {
    const activeMembers = [member(1, 'Zixx Quint'), member(2, 'Lily Miru')];
    const memberSelector = buildFightPositionMemberSelector(activeMembers).components[0]?.toJSON().components[0];
    const assignmentSelector = buildFightPositionAssignmentSelector(
      activeMembers[0]!,
      [position(1, 'Support')],
    ).components[0]?.toJSON().components[0];

    expect(memberSelector).toMatchObject({
      custom_id: 'fight:assign_member:1',
      options: [
        expect.objectContaining({ label: 'Zixx Quint', value: activeMembers[0]?.id }),
        expect.objectContaining({ label: 'Lily Miru', value: activeMembers[1]?.id }),
      ],
    });
    expect(assignmentSelector).toMatchObject({
      custom_id: `fight:assign_position:${activeMembers[0]!.id}:1`,
      options: [expect.objectContaining({ label: 'Support', value: position(1).id })],
    });
  });

  it('uses a separate selector for members who already have a position', () => {
    const assignedMembers = [member(1, 'Zixx Quint')];
    const selector = buildFightPositionAssignedMemberSelector(assignedMembers)
      .components[0]?.toJSON().components[0];

    expect(selector).toMatchObject({
      custom_id: 'fight:edit_member:1',
      options: [expect.objectContaining({ label: 'Zixx Quint', value: assignedMembers[0]?.id })],
    });
  });

  it('shows assigned and unassigned active members in the public summary', () => {
    const summary = buildFightPositionSummary([
      {
        memberId: member(1).id,
        discordUserId: member(1).discordUserId,
        inGameName: 'Zixx Quint',
        positionId: position(1).id,
        positionName: 'Main Fight',
        positionSortOrder: 0,
      },
      {
        memberId: member(2).id,
        discordUserId: member(2).discordUserId,
        inGameName: 'Lily Miru',
        positionId: null,
        positionName: null,
        positionSortOrder: null,
      },
    ]);
    const embed = summary.embeds[0]?.toJSON();

    expect(embed?.description).toContain('กำหนดตำแหน่งแล้ว **1 คน**');
    expect(embed?.description).toContain('⚔️・Main Fight 〔1 คน〕');
    expect(embed?.description).toContain('Zixx Quint');
    expect(embed?.description).toContain('➖・ยังไม่กำหนดตำแหน่ง 〔1 คน〕');
    expect(embed?.description).toContain('Lily Miru');
  });
});

function position(index: number, name = `Position ${index.toString()}`): FightPosition {
  return {
    id: `10000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    guildId: 'guild',
    name,
    isActive: true,
    sortOrder: index - 1,
    createdAt: now,
    updatedAt: now,
  };
}

function member(index: number, inGameName = `Member ${index.toString()}`): Member {
  return {
    id: `20000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
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
