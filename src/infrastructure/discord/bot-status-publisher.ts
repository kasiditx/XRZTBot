import {
  DiscordAPIError,
  Routes,
  type APIMessage,
  type REST,
} from 'discord.js';
import type {
  BotOperationalStatus,
  GuildConfigService,
} from '../../modules/guild-config/service.js';
import { buildBotStatusAlert, buildBotStatusPanel } from './bot-status-components.js';

const UNKNOWN_MESSAGE_ERROR = 10_008;

export interface PublishBotStatusInput {
  readonly rest: REST;
  readonly guildConfig: GuildConfigService;
  readonly guildId: string;
  readonly status: BotOperationalStatus;
  readonly detail: string | null;
  readonly actorDiscordUserId: string | null;
  readonly now: Date;
  readonly announceWhenUnchanged?: boolean;
}

export type PublishBotStatusResult =
  | { readonly outcome: 'SKIPPED'; readonly reason: 'CHANNEL_NOT_CONFIGURED' | 'STATUS_ROLES_NOT_CONFIGURED' }
  | { readonly outcome: 'UNCHANGED'; readonly channelId: string; readonly roleIds: readonly string[] }
  | { readonly outcome: 'PUBLISHED'; readonly channelId: string; readonly roleIds: readonly string[]; readonly messageId: string };

export async function publishBotStatus(input: PublishBotStatusInput): Promise<PublishBotStatusResult> {
  const settings = await input.guildConfig.get(input.guildId);
  if (settings?.botStatusChannelId == null) {
    return { outcome: 'SKIPPED', reason: 'CHANNEL_NOT_CONFIGURED' };
  }
  const roleIds = statusRoleIds(settings);
  if (roleIds === null) {
    return { outcome: 'SKIPPED', reason: 'STATUS_ROLES_NOT_CONFIGURED' };
  }

  const display = {
    status: input.status,
    detail: input.detail,
    actorDiscordUserId: input.actorDiscordUserId,
    updatedAt: input.now,
  };
  const { message, created } = await upsertStatusMessage(
    input.rest,
    settings.botStatusChannelId,
    settings.botStatusMessageId,
    buildBotStatusPanel(display),
  );
  await input.guildConfig.saveBotStatus(
    input.guildId,
    input.status,
    input.detail,
    message.id,
    input.actorDiscordUserId,
    input.now,
  );
  const statusChanged = settings.botStatus !== input.status || settings.botStatusDetail !== input.detail;
  const shouldAnnounce = input.announceWhenUnchanged === true
    || settings.botStatusMessageId === null
    || created
    || statusChanged;
  if (!shouldAnnounce) {
    return {
      outcome: 'UNCHANGED',
      channelId: settings.botStatusChannelId,
      roleIds,
    };
  }
  await input.rest.post(Routes.channelMessages(settings.botStatusChannelId), {
    body: buildBotStatusAlert(display, roleIds),
  });
  return {
    outcome: 'PUBLISHED',
    channelId: settings.botStatusChannelId,
    roleIds,
    messageId: message.id,
  };
}

function statusRoleIds(settings: NonNullable<Awaited<ReturnType<GuildConfigService['get']>>>): readonly string[] | null {
  if (settings.headRoleId === null || settings.deputyRoleId === null || settings.activeMemberRoleId === null) {
    return null;
  }
  return [settings.headRoleId, settings.deputyRoleId, settings.activeMemberRoleId];
}

async function upsertStatusMessage(
  rest: REST,
  channelId: string,
  messageId: string | null,
  body: ReturnType<typeof buildBotStatusPanel>,
): Promise<{ readonly message: APIMessage; readonly created: boolean }> {
  if (messageId !== null) {
    try {
      const message = await rest.patch(Routes.channelMessage(channelId, messageId), { body }) as APIMessage;
      return { message, created: false };
    } catch (error: unknown) {
      if (!(error instanceof DiscordAPIError) || error.code !== UNKNOWN_MESSAGE_ERROR) throw error;
    }
  }
  const message = await rest.post(Routes.channelMessages(channelId), { body }) as APIMessage;
  return { message, created: true };
}
