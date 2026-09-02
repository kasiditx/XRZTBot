import { buildLeaderboard } from '../../src/modules/activities/leaderboard.js';

describe('activity leaderboard', () => {
  it('sums contributions and uses competition ranking for ties', () => {
    const result = buildLeaderboard([
      { memberId: 'a', displayName: 'Alpha', points: 20 },
      { memberId: 'a', displayName: 'Alpha', points: 30 },
      { memberId: 'b', displayName: 'Beta', points: 50 },
      { memberId: 'c', displayName: 'Charlie', points: 10 },
    ]);

    expect(result).toEqual([
      { rank: 1, memberId: 'a', displayName: 'Alpha', points: 50 },
      { rank: 1, memberId: 'b', displayName: 'Beta', points: 50 },
      { rank: 3, memberId: 'c', displayName: 'Charlie', points: 10 },
    ]);
  });

  it('sorts equal scores by display name without an arbitrary display limit', () => {
    const contributions = Array.from({ length: 25 }, (_, index) => ({
      memberId: `member-${index.toString()}`,
      displayName: `Name ${index.toString().padStart(2, '0')}`,
      points: 10,
    }));
    expect(buildLeaderboard(contributions)).toHaveLength(25);
  });

  it('rejects invalid limits and points', () => {
    expect(() => buildLeaderboard([], 0)).toThrow(RangeError);
    expect(() => buildLeaderboard([{ memberId: 'a', displayName: 'A', points: -1 }])).toThrow(RangeError);
    expect(() => buildLeaderboard([{ memberId: 'a', displayName: 'A', points: 1.5 }])).toThrow(RangeError);
  });
});
