import { and, eq } from 'drizzle-orm';
import type { Database } from '../../infrastructure/db/client.js';
import { auditLogs, scheduledJobs } from '../../infrastructure/db/schema.js';

export type AuditLog = typeof auditLogs.$inferSelect;
export type AuditTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface AuditEvent {
  readonly guildId: string;
  readonly actorDiscordUserId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly reason?: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export class AuditService {
  public constructor(private readonly db: Database) {}

  public async record(event: AuditEvent): Promise<void> {
    await this.db.transaction(async (tx) => {
      await writeAudit(tx, event);
    });
  }

  public async findById(guildId: string, auditId: string): Promise<AuditLog | null> {
    const [audit] = await this.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.guildId, guildId), eq(auditLogs.id, auditId)))
      .limit(1);
    return audit ?? null;
  }

  public async markPublished(guildId: string, auditId: string, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(auditLogs)
      .set({ publicChannelId: channelId, publicMessageId: messageId })
      .where(and(eq(auditLogs.guildId, guildId), eq(auditLogs.id, auditId)));
  }
}

export async function writeAudit(tx: AuditTransaction, event: AuditEvent): Promise<AuditLog> {
  const [audit] = await tx
    .insert(auditLogs)
    .values({
      guildId: event.guildId,
      actorDiscordUserId: event.actorDiscordUserId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...(event.before === undefined ? {} : { before: event.before }),
      ...(event.after === undefined ? {} : { after: event.after }),
    })
    .returning();
  if (audit === undefined) throw new Error('Audit creation did not return a row');

  await tx
    .insert(scheduledJobs)
    .values({
      guildId: event.guildId,
      jobType: 'AUDIT_PUBLISH',
      deduplicationKey: `audit:${audit.id}:publish`,
      payload: { auditId: audit.id },
      runAt: audit.createdAt,
    })
    .onConflictDoNothing();

  return audit;
}
