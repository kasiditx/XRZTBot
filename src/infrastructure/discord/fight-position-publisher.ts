import type { Client, SendableChannels } from 'discord.js';
import { ValidationError } from '../../domain/errors.js';
import type { FightPositionService } from '../../modules/fight-positions/service.js';
import type { GuildConfigService } from '../../modules/guild-config/service.js';
import { buildFightPositionSummary } from './fight-position-components.js';

export async function syncFightPositionSummary(
  client: Client,
  fightPositions: FightPositionService,
  guildConfig: GuildConfigService,
  guildId: string,
  requireConfigured: boolean,
): Promise<SendableChannels | null> {
  const settings = await guildConfig.get(guildId);
  if (settings?.fightPositionChannelId === null || settings?.fightPositionChannelId === undefined) {
    if (requireConfigured) throw new ValidationError('กรุณาตั้งค่า Channel ตำแหน่ง Fight ก่อน');
    return null;
  }

  const channel = await client.channels.fetch(settings.fightPositionChannelId);
  if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
    throw new ValidationError('Channel ตำแหน่ง Fight ไม่ใช่ Text Channel ที่ Bot ส่งข้อความได้');
  }
  const summary = buildFightPositionSummary(await fightPositions.listAllSetRosters(guildId));
  if (settings.fightPositionSummaryMessageId !== null) {
    const existing = await channel.messages.fetch(settings.fightPositionSummaryMessageId).catch(() => null);
    if (existing !== null) {
      await existing.edit(summary);
      return channel;
    }
  }

  const message = await channel.send(summary);
  await guildConfig.saveFightPositionSummaryMessage(guildId, message.id);
  return channel;
}
