import { jest } from '@jest/globals';
import { ApplicationCommandOptionType, REST, type Interaction, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { registerGuildCommands } from '../../src/infrastructure/discord/commands.js';
import { DiscordInteractionHandler, type InteractionHandlerDependencies } from '../../src/infrastructure/discord/interaction-handler.js';

describe('MiruBot slash commands', () => {
  it('registers setup-roles with Dev, Head, Deputy and Member as the required options', async () => {
    const put = jest.spyOn(REST.prototype, 'put').mockResolvedValue([]);
    try {
      await registerGuildCommands('test-token', '100000000000000001', '100000000000000002');

      const body = put.mock.calls[0]?.[1]?.body as RESTPostAPIChatInputApplicationCommandsJSONBody[];
      const setupRoles = body.find((command) => command.name === 'mirubot')?.options?.find((option) => option.name === 'setup-roles');
      if (setupRoles?.type !== ApplicationCommandOptionType.Subcommand) throw new Error('setup-roles is not registered');
      expect(setupRoles.options?.map(({ name, type, required }) => ({ name, type, required }))).toEqual(
        ['dev', 'head', 'deputy', 'member'].map((name) => ({ name, type: ApplicationCommandOptionType.Role, required: true })),
      );
    } finally {
      put.mockRestore();
    }
  });

  it('allows an existing Dev to configure the four roles with no former role option', async () => {
    const guildId = '100000000000000001';
    const devRoleId = '100000000000000002';
    const roles = new Map([
      ['dev', devRoleId],
      ['head', '100000000000000003'],
      ['deputy', '100000000000000004'],
      ['member', '100000000000000005'],
    ]);
    const configureRoles = jest.fn<() => Promise<void>>().mockResolvedValue();
    const ignore = { handle: () => Promise.resolve(false) };
    const handler = new DiscordInteractionHandler({
      guildConfig: { get: () => Promise.resolve({ devRoleId }), configureRoles },
      activityInteractions: ignore, attendanceInteractions: ignore, fineInteractions: ignore,
      treasuryInteractions: ignore, weeklyDuesInteractions: ignore, weeklyItemsInteractions: ignore,
      stockInteractions: ignore, fightPositionInteractions: ignore,
      logger: { warn: jest.fn(), error: jest.fn() },
    } as unknown as InteractionHandlerDependencies);
    const state = { deferred: false, replied: false };
    const editReply = jest.fn<() => Promise<void>>().mockResolvedValue();
    const interaction = {
      commandName: 'mirubot',
      createdTimestamp: Date.now(),
      guild: { id: guildId, members: { fetch: () => Promise.resolve({ roles: { cache: new Map([[devRoleId, {}]]) } }) } },
      guildId,
      user: { id: '100000000000000006' },
      options: {
        getSubcommand: () => 'setup-roles',
        getRole: (name: string) => {
          const id = roles.get(name);
          if (id === undefined) throw new Error(`Unexpected role option ${name}`);
          return { id };
        },
      },
      get deferred() { return state.deferred; },
      get replied() { return state.replied; },
      deferReply: () => { state.deferred = true; return Promise.resolve(); },
      editReply,
      isRepliable: () => true,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isMessageComponent: () => false,
      isChatInputCommand: () => true,
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(configureRoles).toHaveBeenCalledWith(guildId, {
      devRoleId,
      headRoleId: roles.get('head'),
      deputyRoleId: roles.get('deputy'),
      activeMemberRoleId: roles.get('member'),
    });
  });
});
