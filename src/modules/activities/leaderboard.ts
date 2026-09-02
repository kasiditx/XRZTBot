export interface ScoreContribution {
  readonly memberId: string;
  readonly displayName: string;
  readonly points: number;
}

export interface LeaderboardRow {
  readonly rank: number;
  readonly memberId: string;
  readonly displayName: string;
  readonly points: number;
}

export function buildLeaderboard(
  contributions: readonly ScoreContribution[],
  limit?: number,
): LeaderboardRow[] {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new RangeError('limit must be a positive safe integer');
  }

  const totals = new Map<string, { displayName: string; points: number }>();

  for (const contribution of contributions) {
    if (!Number.isSafeInteger(contribution.points) || contribution.points < 0) {
      throw new RangeError('points must be a non-negative safe integer');
    }

    const current = totals.get(contribution.memberId);
    totals.set(contribution.memberId, {
      displayName: contribution.displayName,
      points: (current?.points ?? 0) + contribution.points,
    });
  }

  const sorted = [...totals.entries()].sort((left, right) => {
    const scoreDifference = right[1].points - left[1].points;
    return scoreDifference !== 0 ? scoreDifference : left[1].displayName.localeCompare(right[1].displayName, 'th');
  });

  let previousPoints: number | null = null;
  let rank = 0;

  const displayedTotals = limit === undefined ? sorted : sorted.slice(0, limit);
  return displayedTotals.map(([memberId, total], index) => {
    if (previousPoints === null || total.points !== previousPoints) {
      rank = index + 1;
      previousPoints = total.points;
    }

    return {
      rank,
      memberId,
      displayName: total.displayName,
      points: total.points,
    };
  });
}
