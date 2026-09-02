import { PermissionsBitField } from 'discord.js';

const requiredBotChannelPermissions = [
  { flag: PermissionsBitField.Flags.ViewChannel, label: 'View Channel' },
  { flag: PermissionsBitField.Flags.SendMessages, label: 'Send Messages' },
  { flag: PermissionsBitField.Flags.EmbedLinks, label: 'Embed Links' },
  { flag: PermissionsBitField.Flags.AttachFiles, label: 'Attach Files' },
  { flag: PermissionsBitField.Flags.ReadMessageHistory, label: 'Read Message History' },
] as const;

export function listMissingBotChannelPermissions(permissions: Readonly<PermissionsBitField>): string[] {
  return requiredBotChannelPermissions
    .filter(({ flag }) => !permissions.has(flag))
    .map(({ label }) => label);
}
