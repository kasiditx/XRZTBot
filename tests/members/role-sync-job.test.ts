import { jest } from '@jest/globals';
import { ValidationError } from '../../src/domain/errors.js';
import { createDiscordJobHandlers } from '../../src/infrastructure/discord/job-handlers.js';
import type { ScheduledJob } from '../../src/modules/scheduler/service.js';

const guildId = '100000000000000001';
const discordUserId = '100000000000000002';
const memberRoleId = '100000000000000003';
const formerRoleId = '100000000000000004';

function fixture(status: 'ACTIVE' | 'FORMER', holdsRole: boolean, activeMemberRoleId: string | null = memberRoleId) {
  const add = jest.fn<() => Promise<void>>().mockResolvedValue();
  const remove = jest.fn<() => Promise<void>>().mockResolvedValue();
  const fetchMember = jest.fn(() => Promise.resolve({
    roles: { cache: new Map(holdsRole ? [[memberRoleId, {}]] : []), add, remove },
  }));
  const client = { guilds: { fetch: () => Promise.resolve({ members: { fetch: fetchMember } }) } };
  const members = { findByDiscordUserId: jest.fn(() => Promise.resolve({ status })) };
  const guildConfig = { get: jest.fn(() => Promise.resolve({ activeMemberRoleId })) };
  const handlers = createDiscordJobHandlers(...[
    client, members, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, guildConfig, {}, {}, {},
  ] as unknown as Parameters<typeof createDiscordJobHandlers>);
  const sync = handlers.get('MEMBER_ROLE_SYNC');
  if (!sync) throw new Error('MEMBER_ROLE_SYNC is not registered');
  return {
    add, remove, fetchMember, members, guildConfig,
    run: (payload: Record<string, string>) => sync({ guildId, payload } as ScheduledJob),
  };
}

describe('member role synchronization', () => {
  it('adds the configured member role for an active member', async () => {
    const { add, remove, fetchMember, members, guildConfig, run } = fixture('ACTIVE', false);

    await run({ discordUserId });

    expect(members.findByDiscordUserId).toHaveBeenCalledWith(guildId, discordUserId);
    expect(guildConfig.get).toHaveBeenCalledWith(guildId);
    expect(fetchMember).toHaveBeenCalledWith(discordUserId);
    expect(add).toHaveBeenCalledWith(memberRoleId, expect.any(String));
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes the member role and ignores the former role in old queued jobs', async () => {
    const { add, remove, run } = fixture('FORMER', true);

    await run({ discordUserId, addRoleId: formerRoleId, removeRoleId: memberRoleId });

    expect(remove).toHaveBeenCalledWith(memberRoleId, expect.any(String));
    expect(add).not.toHaveBeenCalled();
  });

  it('does not remove a rejoined member role when an old departure job retries', async () => {
    const { add, remove, run } = fixture('ACTIVE', true);

    await run({ discordUserId, addRoleId: formerRoleId, removeRoleId: memberRoleId });

    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('fails with a configuration error before contacting Discord when the member role is missing', async () => {
    const { fetchMember, run } = fixture('ACTIVE', false, null);

    await expect(run({ discordUserId })).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMember).not.toHaveBeenCalled();
  });
});
