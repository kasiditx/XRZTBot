import type { AuditLog } from '../../modules/audit/service.js';
import { MiruEmbedBuilder as EmbedBuilder } from './theme.js';

const IGNORED_CHANGE_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'publicChannelId',
  'publicMessageId',
]);

const SENSITIVE_FIELD_PATTERN = /(authorization|database.?url|password|secret|token)/i;

export function buildAuditLogMessage(audit: AuditLog) {
  const actor = audit.actorDiscordUserId === 'SYSTEM'
    ? '🤖 ระบบอัตโนมัติ'
    : `<@${audit.actorDiscordUserId}>`;
  const changedFields = findChangedFields(audit.before, audit.after);
  const embed = new EmbedBuilder()
    .setColor(auditColor(audit.action))
    .setTitle(`🛡️ ${audit.action}`)
    .addFields(
      { name: 'ผู้ดำเนินการ', value: actor, inline: true },
      { name: 'ประเภทข้อมูล', value: audit.entityType, inline: true },
      { name: 'รหัสรายการ', value: `\`${audit.entityId.slice(0, 100)}\``, inline: false },
      { name: 'ข้อมูลที่เปลี่ยน', value: changedFields.length === 0 ? 'ไม่มี field ที่เปลี่ยน' : changedFields.map((field) => `\`${field}\``).join(', '), inline: false },
    )
    .setFooter({ text: `Audit ID: ${audit.id}` })
    .setTimestamp(audit.createdAt);

  if (audit.reason !== null) {
    embed.addFields({ name: 'เหตุผล', value: audit.reason.slice(0, 1_024) });
  }

  return {
    embeds: [embed],
    allowedMentions: { parse: [] as const },
  };
}

function findChangedFields(before: unknown, after: unknown): string[] {
  const beforeRecord = toRecord(before);
  const afterRecord = toRecord(after);
  const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
  return [...keys]
    .filter((key) => !IGNORED_CHANGE_FIELDS.has(key) && !SENSITIVE_FIELD_PATTERN.test(key))
    .filter((key) => JSON.stringify(beforeRecord[key]) !== JSON.stringify(afterRecord[key]))
    .sort()
    .slice(0, 20);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function auditColor(action: string): number {
  if (/(CANCELLED|CORRECTED|FORMER|REJECTED|REVERSED)/.test(action)) return 0xed4245;
  if (action.includes('APPROVED')) return 0x57f287;
  return 0x5865f2;
}
