import {
  buildActivityAnnouncement,
  buildActivitySubmissionModal,
  buildCreateActivityModal,
  buildLeaderboardEmbed,
  buildParticipationSummaryEmbeds,
  buildParticipantEditModal,
  buildPreparedSubmissionLog,
} from '../../src/infrastructure/discord/activity-components.js';
import type { ActivityWithScores, PreparedSubmission } from '../../src/modules/activities/service.js';

const now = new Date('2026-08-27T12:00:00.000Z');

describe('activity Discord components', () => {
  it('asks for score definitions only in score mode', () => {
    expect(buildCreateActivityModal('SCORE', '27/08/2569 19:00', '27/08/2569 23:00').toJSON().components).toHaveLength(5);
    expect(buildCreateActivityModal('EVIDENCE', '27/08/2569 19:00', '27/08/2569 23:00').toJSON().components).toHaveLength(4);
    expect(buildCreateActivityModal('ANNOUNCEMENT', '27/08/2569 19:00', '27/08/2569 23:00').toJSON().components).toHaveLength(4);
  });

  it('hides submission actions for announcement-only activities', () => {
    const announcement = buildActivityAnnouncement(activity('ANNOUNCEMENT'));
    expect(announcement.components).toEqual([]);
  });

  it('keeps additional participants optional because the submitter is included automatically', () => {
    const modal = buildActivitySubmissionModal(activity('EVIDENCE'), activeMembers(), 'FILE').toJSON();

    expect(modal.components[0]).toMatchObject({
      component: {
        type: 3,
        min_values: 0,
        required: false,
        options: [
          expect.objectContaining({ label: 'Alpha', value: '100000000000000001' }),
          expect.objectContaining({ label: 'Beta', value: '100000000000000002' }),
        ],
      },
    });
  });

  it('uses only registered active members in the participant edit modal', () => {
    const modal = buildParticipantEditModal(
      '11111111-1111-4111-8111-111111111111',
      activeMembers(),
    ).toJSON();

    expect(modal.components[1]).toMatchObject({
      component: {
        type: 3,
        options: [
          expect.objectContaining({ label: 'Alpha', value: '100000000000000001' }),
          expect.objectContaining({ label: 'Beta', value: '100000000000000002' }),
        ],
      },
    });
  });

  it('splits registered participants into Discord-safe groups of 25', () => {
    const members = Array.from({ length: 26 }, (_, index) => ({
      discordUserId: String(100000000000000000n + BigInt(index)),
      inGameName: `Member ${String(index + 1)}`,
    }));
    const modal = buildActivitySubmissionModal(activity('SCORE'), members, 'LINK').toJSON();

    expect(modal.components).toHaveLength(5);
    expect(modal.custom_id).toBe('activity:submit_modal:LINK:11111111-1111-4111-8111-111111111111');
    expect(modal.components[3]).toMatchObject({
      component: { type: 4, custom_id: 'activity:submit_media_links', required: true },
    });
    expect('component' in modal.components[1]! && 'options' in modal.components[1].component
      ? modal.components[1].component.options
      : []).toHaveLength(25);
    expect('component' in modal.components[2]! && 'options' in modal.components[2].component
      ? modal.components[2].component.options
      : []).toHaveLength(1);
  });

  it('keeps evidence submissions editable without showing a change-score button', () => {
    const prepared = {
      submissionId: '11111111-1111-4111-8111-111111111111',
      activity: activity('EVIDENCE').activity,
      scoreItem: null,
      submitter: { id: 'member-1', discordUserId: '100000000000000001', inGameName: 'Alpha' },
      participants: [{ id: 'member-1', discordUserId: '100000000000000001', inGameName: 'Alpha' }],
      note: null,
    } satisfies PreparedSubmission;
    const payload = buildPreparedSubmissionLog(prepared);
    const buttons = payload.components[0]!.toJSON().components;
    expect(buttons.map((button) => 'custom_id' in button ? button.custom_id : null)).toEqual([
      'activity:cancel:11111111-1111-4111-8111-111111111111',
      'activity:participants:11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('marks the top three leaderboard ranks with crowns', () => {
    const embed = buildLeaderboardEmbed(activity('SCORE').activity, [
      { rank: 1, memberId: 'member-1', displayName: 'Alpha', points: 50 },
      { rank: 2, memberId: 'member-2', displayName: 'Beta', points: 40 },
      { rank: 3, memberId: 'member-3', displayName: 'Gamma', points: 30 },
      { rank: 4, memberId: 'member-4', displayName: 'Delta', points: 20 },
    ]).toJSON();

    expect(embed.description).toContain('👑 1. Alpha');
    expect(embed.description).toContain('👑 2. Beta');
    expect(embed.description).toContain('👑 3. Gamma');
    expect(embed.description).toContain('4. Delta');
  });

  it('shows every participation summary row without a fixed top-20 cutoff', () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      memberId: `member-${String(index + 1)}`,
      displayName: `Member ${String(index + 1)}`,
      submissions: index + 1,
    }));
    const embed = buildParticipationSummaryEmbeds(activity('EVIDENCE').activity, {
      totalSubmissions: 325,
      rows,
    })[0]?.toJSON();

    expect(embed?.description).toContain('1. Member 1');
    expect(embed?.description).toContain('25. Member 25');
    expect(embed?.footer?.text).not.toContain('20');
  });
});

function activity(mode: 'SCORE' | 'EVIDENCE' | 'ANNOUNCEMENT'): ActivityWithScores {
  return {
    activity: {
      id: '11111111-1111-4111-8111-111111111111',
      guildId: 'guild',
      requestId: 'request',
      title: 'กิจกรรมทดสอบ',
      details: 'รายละเอียด',
      mode,
      startsAt: new Date(now.getTime() - 1_000),
      endsAt: new Date(now.getTime() + 60_000),
      status: 'OPEN',
      createdByDiscordUserId: '100000000000000001',
      announcementChannelId: null,
      announcementMessageId: null,
      leaderboardChannelId: null,
      leaderboardMessageId: null,
      createdAt: now,
      updatedAt: now,
    },
    scoreItems: mode === 'SCORE' ? [{
      id: '22222222-2222-4222-8222-222222222222',
      activityId: '11111111-1111-4111-8111-111111111111',
      name: 'Loop A',
      points: 50,
      isActive: true,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    }] : [],
  };
}

function activeMembers() {
  return [
    { discordUserId: '100000000000000001', inGameName: 'Alpha' },
    { discordUserId: '100000000000000002', inGameName: 'Beta' },
  ];
}
