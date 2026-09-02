import type { Guild } from 'discord.js';
import { hasCapability, resolveAuthority } from '../../modules/authorization/permissions.js';
import type { GuildSettings } from '../db/schema.js';

export interface MemberSelectionOption {
  readonly discordUserId: string;
  readonly inGameName: string;
}

/**
 * Database status can be stale when a Discord role sync fails or a role is removed manually.
 * Member selectors therefore require both an ACTIVE record and a current Miru member role.
 */
export async function filterRoleVerifiedActiveMembers<T extends MemberSelectionOption>(
  guild: Guild,
  settings: GuildSettings,
  candidates: readonly T[],
): Promise<T[]> {
  const verified: readonly (T | null)[] = await Promise.all(candidates.map(async (candidate): Promise<T | null> => {
    const discordMember = await guild.members.fetch(candidate.discordUserId).catch(() => null);
    if (discordMember === null) return null;
    const authority = resolveAuthority(new Set(discordMember.roles.cache.keys()), settings);
    return authority !== null && hasCapability(authority, 'MEMBER_USE') ? candidate : null;
  }));
  return verified.filter((candidate): candidate is T => candidate !== null);
}
