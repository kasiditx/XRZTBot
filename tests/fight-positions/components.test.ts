import type { FightPosition, FightPositionSet, Member } from '../../src/infrastructure/db/schema.js';
import {
  buildFightPositionAdminPanel,
  buildFightPositionAssignedMemberSelector,
  buildFightPositionAssignmentSelector,
  buildFightPositionMemberSelector,
  buildFightPositionNameModal,
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
    const activeSet = fightSet(1, 'Set 1', true);
    const panel = buildFightPositionAdminPanel([activeSet], activeSet, [position(1, 'Main Fight', '🔫')]);
    const buttons = panel.components[1]?.toJSON().components;
    const selector = panel.components[3]?.toJSON().components[0];

    expect(buttons).toEqual(expect.arrayContaining([
      expect.objectContaining({ custom_id: 'fight:set_add' }),
      expect.objectContaining({ custom_id: 'fight:add' }),
      expect.objectContaining({ custom_id: `fight:assign_set:${activeSet.id}` }),
      expect.objectContaining({ custom_id: `fight:edit_assignment_set:${activeSet.id}` }),
    ]));
    expect(panel.components[2]?.toJSON().components).toEqual(expect.arrayContaining([
      expect.objectContaining({ custom_id: 'fight:publish' }),
    ]));
    expect(selector).toMatchObject({
      custom_id: 'fight:manage_select:1',
    });
    if (selector === undefined || !('options' in selector)) throw new Error('Expected a position selector');
    expect(selector.options[0]).toMatchObject({ label: 'Main Fight', value: position(1).id, emoji: { name: '🔫' } });
    expect(panel.embeds[0]?.toJSON().fields?.[0]?.value).toContain('🔫 Main Fight');
  });

  it('asks for a custom emoji when adding a position', () => {
    const modal = buildFightPositionNameModal().toJSON();

    expect(modal.components).toEqual(expect.arrayContaining([
      expect.objectContaining({
        components: [expect.objectContaining({ custom_id: 'fight:emoji', required: true })],
      }),
    ]));
  });

  it('uses only the supplied active registry members in assignment controls', () => {
    const activeSet = fightSet(1);
    const activeMembers = [member(1, 'Zixx Quint'), member(2, 'Lily Miru')];
    const memberSelector = buildFightPositionMemberSelector(activeSet, activeMembers).components[0]?.toJSON().components[0];
    const assignmentSelector = buildFightPositionAssignmentSelector(
      activeSet,
      activeMembers[0]!,
      [position(1, 'Support', '🩹')],
    ).components[0]?.toJSON().components[0];

    expect(memberSelector).toMatchObject({
      custom_id: `fight:assign_member:${activeSet.id}:1`,
      options: [
        expect.objectContaining({ label: 'Zixx Quint', value: activeMembers[0]?.id }),
        expect.objectContaining({ label: 'Lily Miru', value: activeMembers[1]?.id }),
      ],
    });
    expect(assignmentSelector).toMatchObject({
      custom_id: `fight:assign_position:${activeSet.id}:${activeMembers[0]!.id}:1`,
    });
    if (assignmentSelector === undefined || !('options' in assignmentSelector)) {
      throw new Error('Expected an assignment selector');
    }
    expect(assignmentSelector.options[0]).toMatchObject({ label: 'Support', value: position(1).id, emoji: { name: '🩹' } });
  });

  it('uses a separate selector for members who already have a position', () => {
    const activeSet = fightSet(1);
    const assignedMembers = [member(1, 'Zixx Quint')];
    const selector = buildFightPositionAssignedMemberSelector(activeSet, assignedMembers)
      .components[0]?.toJSON().components[0];

    expect(selector).toMatchObject({
      custom_id: `fight:edit_member:${activeSet.id}:1`,
      options: [expect.objectContaining({ label: 'Zixx Quint', value: assignedMembers[0]?.id })],
    });
  });

  it('shows assigned and unassigned active members in the public summary', () => {
    const summary = buildFightPositionSummary([
      {
        set: fightSet(1, 'Set 1', true),
        roster: [
          {
            memberId: member(1).id,
            discordUserId: member(1).discordUserId,
            inGameName: 'Zixx Quint',
            positionId: position(1).id,
            positionName: 'Main Fight',
            positionEmoji: '🔫',
            positionSortOrder: 0,
          },
          {
            memberId: member(2).id,
            discordUserId: member(2).discordUserId,
            inGameName: 'Lily Miru',
            positionId: null,
            positionName: null,
            positionEmoji: null,
            positionSortOrder: null,
          },
        ],
      },
      {
        set: fightSet(2, 'Set 2', false),
        roster: [
          {
            memberId: member(1).id,
            discordUserId: member(1).discordUserId,
            inGameName: 'Zixx Quint',
            positionId: position(2).id,
            positionName: 'Support',
            positionEmoji: '🩹',
            positionSortOrder: 1,
          },
        ],
      },
    ]);
    const embed = summary.embeds[0]?.toJSON();

    expect(embed?.description).toContain('Set ปัจจุบันกำหนดแล้ว **1/2 คน**');
    expect(embed?.description).toContain('Set 1 • ใช้งานอยู่');
    expect(embed?.description).toContain('🔫・Main Fight 〔1 คน〕');
    expect(embed?.description).toContain('Zixx Quint');
    expect(embed?.description).toContain('➖・ยังไม่กำหนดตำแหน่ง 〔1 คน〕');
    expect(embed?.description).toContain('Lily Miru');
    expect(summary.embeds.map((item) => item.toJSON().description).join('\n')).toContain('Set 2');
    expect(summary.embeds.map((item) => item.toJSON().description).join('\n')).toContain('Support');
  });
});

function position(index: number, name = `Position ${index.toString()}`, emoji = '⚔️'): FightPosition {
  return {
    id: `10000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    guildId: 'guild',
    name,
    emoji,
    isActive: true,
    sortOrder: index - 1,
    createdAt: now,
    updatedAt: now,
  };
}

function fightSet(index: number, name = `Set ${index.toString()}`, isActive = index === 1): FightPositionSet {
  return {
    id: `30000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    guildId: 'guild',
    name,
    isActive,
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
