import { PermissionsBitField } from 'discord.js';
import { listMissingBotChannelPermissions } from '../../src/infrastructure/discord/channel-permissions.js';

describe('listMissingBotChannelPermissions', () => {
  it('returns every permission required to publish system messages', () => {
    const permissions = new PermissionsBitField();

    expect(listMissingBotChannelPermissions(permissions)).toEqual([
      'View Channel',
      'Send Messages',
      'Embed Links',
      'Attach Files',
      'Read Message History',
    ]);
  });

  it('returns only permissions that are missing', () => {
    const permissions = new PermissionsBitField([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
    ]);

    expect(listMissingBotChannelPermissions(permissions)).toEqual([
      'Embed Links',
      'Attach Files',
      'Read Message History',
    ]);
  });

  it('returns an empty list when the bot can publish', () => {
    const permissions = new PermissionsBitField([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.EmbedLinks,
      PermissionsBitField.Flags.AttachFiles,
      PermissionsBitField.Flags.ReadMessageHistory,
    ]);

    expect(listMissingBotChannelPermissions(permissions)).toEqual([]);
  });
});
