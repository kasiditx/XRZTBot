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
}

export type PublishBotStatusResult =
  | { readonly outcome: 'SKIPPED'; readonly reason: 'CHANNEL_NOT_CONFIGURED' | 'MEMBER_ROLE_NOT_CONFIGURED' }
  | { readonly outcome: 'UNCHANGED'; readonly channelId: string; readonly memberRoleId: string }
  | { readonly outcome: 'PUBLISHED'; readonly channelId: string; readonly memberRoleId: string; readonly messageId: string };

export async function publishBotStatus(input: PublishBotStatusInput): Promise<PublishBotStatusResult> {
  const settings = await input.guildConfig.get(input.guildId);
  if (settings?.botStatusChannelId == null) {
    return { outcome: 'SKIPPED', reason: 'CHANNEL_NOT_CONFIGURED' };
  }
  if (settings.activeMemberRoleId === null) {
    return { outcome: 'SKIPPED', reason: 'MEMBER_ROLE_NOT_CONFIGURED' };
  }
  if (settings.botStatusMessageId !== null && settings.botStatus === input.status) {
    return {
      outcome: 'UNCHANGED',
      channelId: settings.botStatusChannelId,
      memberRoleId: settings.activeMemberRoleId,
    };
  }

  const display = {
    status: input.status,
    detail: input.detail,
    actorDiscordUserId: input.actorDiscordUserId,
    updatedAt: input.now,
  };
  const message = await upsertStatusMessage(
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
  await input.rest.post(Routes.channelMessages(settings.botStatusChannelId), {
    body: buildBotStatusAlert(display, settings.activeMemberRoleId),
  });
  return {
    outcome: 'PUBLISHED',
    channelId: settings.botStatusChannelId,
    memberRoleId: settings.activeMemberRoleId,
    messageId: message.id,
  };
}

async function upsertStatusMessage(
  rest: REST,
  channelId: string,
  messageId: string | null,
  body: ReturnType<typeof buildBotStatusPanel>,
): Promise<APIMessage> {
  if (messageId !== null) {
    try {
      return await rest.patch(Routes.channelMessage(channelId, messageId), { body }) as APIMessage;
    } catch (error: unknown) {
      if (!(error instanceof DiscordAPIError) || error.code !== UNKNOWN_MESSAGE_ERROR) throw error;
    }
  }
  return await rest.post(Routes.channelMessages(channelId), { body }) as APIMessage;
}
