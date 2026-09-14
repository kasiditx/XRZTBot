import type { BotOperationalStatus } from '../../modules/guild-config/service.js';
import { buildMiruEmbed } from './theme.js';

export interface BotStatusDisplayInput {
  readonly status: BotOperationalStatus;
  readonly detail: string | null;
  readonly actorDiscordUserId: string;
  readonly updatedAt: Date;
}

export function buildBotStatusPanel(input: BotStatusDisplayInput) {
  const display = botStatusDisplay(input.status);
  const description = [
    `## ${display.emoji} ${display.label}`,
    display.guidance,
    ...(input.detail === null ? [] : ['', `**รายละเอียด**\n${input.detail}`]),
    '',
    `**อัปเดตโดย** <@${input.actorDiscordUserId}>`,
    `**อัปเดตล่าสุด** <t:${discordTimestamp(input.updatedAt)}:F>`,
  ].join('\n');
  return {
    embeds: [buildMiruEmbed({
      tone: display.tone,
      title: 'สถานะ MiruBot',
      description,
      module: 'Bot Status',
    })],
    allowedMentions: { parse: [] as const },
  };
}

export function buildBotStatusAlert(input: BotStatusDisplayInput, memberRoleId: string) {
  const display = botStatusDisplay(input.status);
  return {
    content: `<@&${memberRoleId}>`,
    embeds: [buildMiruEmbed({
      tone: display.tone,
      title: `MiruBot ${display.label}`,
      description: [
        `${display.emoji} ${display.guidance}`,
        ...(input.detail === null ? [] : ['', `**รายละเอียด**\n${input.detail}`]),
      ].join('\n'),
      module: 'Status Notification',
    })],
    allowedMentions: { parse: [] as const, roles: [memberRoleId] },
  };
}

function botStatusDisplay(status: BotOperationalStatus) {
  if (status === 'OPERATIONAL') {
    return {
      emoji: '🟢',
      label: 'ใช้งานได้ปกติ',
      guidance: 'สมาชิกสามารถใช้งานคำสั่งของ Bot ได้ตามปกติ',
      tone: 'success' as const,
    };
  }
  return {
    emoji: '🟠',
    label: 'กำลังอัปเดต',
    guidance: 'ขอให้งดใช้งานคำสั่งของ Bot ชั่วคราวจนกว่าจะมีประกาศพร้อมใช้งาน',
    tone: 'warning' as const,
  };
}

function discordTimestamp(value: Date): string {
  return Math.floor(value.getTime() / 1_000).toString();
}
