import { and, asc, eq, lte, lt } from 'drizzle-orm';
import type pino from 'pino';
import type { Database } from '../../infrastructure/db/client.js';
import { scheduledJobs } from '../../infrastructure/db/schema.js';

export type ScheduledJob = typeof scheduledJobs.$inferSelect;
export type JobHandler = (job: ScheduledJob) => Promise<void>;

const STALE_LOCK_MS = 5 * 60 * 1_000;
const MAX_BACKOFF_MS = 15 * 60 * 1_000;

export class DurableScheduler {
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private readonly workerId = crypto.randomUUID();

  public constructor(
    private readonly db: Database,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    private readonly guildId: string,
    private readonly pollIntervalMs: number,
    private readonly logger: pino.Logger,
  ) {}

  public async start(): Promise<void> {
    if (this.timer !== null) {
      return;
    }

    await this.recoverStaleJobs();
    this.timer = setInterval(() => {
      this.runTick();
    }, this.pollIntervalMs);
    this.timer.unref();
    this.runTick();
  }

  public async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.activeTick;
  }

  private runTick(): void {
    if (this.activeTick !== null) {
      return;
    }

    this.activeTick = this.processDueJobs()
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'scheduler tick failed');
      })
      .finally(() => {
        this.activeTick = null;
      });
  }

  private async processDueJobs(): Promise<void> {
    for (;;) {
      const job = await this.claimNextJob();
      if (job === null) {
        return;
      }
      await this.executeJob(job);
    }
  }

  private async claimNextJob(): Promise<ScheduledJob | null> {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(scheduledJobs)
        .where(and(
          eq(scheduledJobs.guildId, this.guildId),
          eq(scheduledJobs.status, 'PENDING'),
          lte(scheduledJobs.runAt, new Date()),
        ))
        .orderBy(asc(scheduledJobs.runAt))
        .limit(1)
        .for('update', { skipLocked: true });

      if (job === undefined) {
        return null;
      }

      const [claimed] = await tx
        .update(scheduledJobs)
        .set({
          status: 'RUNNING',
          attempts: job.attempts + 1,
          lockedAt: new Date(),
          lockedBy: this.workerId,
          updatedAt: new Date(),
        })
        .where(and(
          eq(scheduledJobs.guildId, this.guildId),
          eq(scheduledJobs.id, job.id),
          eq(scheduledJobs.status, 'PENDING'),
        ))
        .returning();

      return claimed ?? null;
    });
  }

  private async executeJob(job: ScheduledJob): Promise<void> {
    const handler = this.handlers.get(job.jobType);
    if (handler === undefined) {
      await this.failPermanently(job, `No handler registered for ${job.jobType}`);
      return;
    }

    try {
      await handler(job);
      await this.db
        .update(scheduledJobs)
        .set({
          status: 'COMPLETED',
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(scheduledJobs.guildId, this.guildId),
          eq(scheduledJobs.id, job.id),
          eq(scheduledJobs.lockedBy, this.workerId),
        ));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown scheduler error';
      this.logger.error({ err: error, jobId: job.id, jobType: job.jobType }, 'scheduled job failed');

      if (job.attempts >= job.maxAttempts) {
        await this.failPermanently(job, message);
        return;
      }

      const backoffMs = Math.min(2 ** Math.max(0, job.attempts - 1) * 5_000, MAX_BACKOFF_MS);
      await this.db
        .update(scheduledJobs)
        .set({
          status: 'PENDING',
          runAt: new Date(Date.now() + backoffMs),
          lockedAt: null,
          lockedBy: null,
          lastError: message,
          updatedAt: new Date(),
        })
        .where(and(
          eq(scheduledJobs.guildId, this.guildId),
          eq(scheduledJobs.id, job.id),
          eq(scheduledJobs.lockedBy, this.workerId),
        ));
    }
  }

  private async failPermanently(job: ScheduledJob, message: string): Promise<void> {
    await this.db
      .update(scheduledJobs)
      .set({
        status: 'FAILED',
        lockedAt: null,
        lockedBy: null,
        lastError: message.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(and(eq(scheduledJobs.guildId, this.guildId), eq(scheduledJobs.id, job.id)));
  }

  private async recoverStaleJobs(): Promise<void> {
    const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
    const recovered = await this.db
      .update(scheduledJobs)
      .set({
        status: 'PENDING',
        lockedAt: null,
        lockedBy: null,
        lastError: 'Recovered stale worker lock',
        updatedAt: new Date(),
      })
      .where(and(
        eq(scheduledJobs.guildId, this.guildId),
        eq(scheduledJobs.status, 'RUNNING'),
        lt(scheduledJobs.lockedAt, staleBefore),
      ))
      .returning({ id: scheduledJobs.id });

    if (recovered.length > 0) {
      this.logger.warn({ count: recovered.length }, 'recovered stale scheduled jobs');
    }
  }
}
