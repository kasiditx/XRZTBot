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
  private started = false;
  private wakeRequested = false;
  private readonly workerId = crypto.randomUUID();

  public constructor(
    private readonly db: Database,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    private readonly guildId: string,
    private readonly retryIntervalMs: number,
    private readonly idlePollIntervalMs: number,
    private readonly logger: pino.Logger,
  ) {}

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.recoverStaleJobs();
    this.started = true;
    this.runTick();
  }

  public async stop(): Promise<void> {
    this.started = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.activeTick;
  }

  public wake(): void {
    if (!this.started) {
      return;
    }

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.activeTick !== null) {
      this.wakeRequested = true;
      return;
    }

    this.scheduleNextTick(0);
  }

  private runTick(): void {
    if (!this.started || this.activeTick !== null) {
      return;
    }

    let nextDelayMs = this.retryIntervalMs;
    this.activeTick = this.processDueJobsAndGetNextDelay()
      .then((delayMs) => {
        nextDelayMs = delayMs;
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'scheduler tick failed');
      })
      .finally(() => {
        this.activeTick = null;
        if (!this.started) {
          return;
        }

        const delayMs = this.wakeRequested ? 0 : nextDelayMs;
        this.wakeRequested = false;
        this.scheduleNextTick(delayMs);
      });
  }

  private scheduleNextTick(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runTick();
    }, delayMs);
    this.timer.unref();
  }

  private async processDueJobsAndGetNextDelay(): Promise<number> {
    await this.processDueJobs();
    const nextRunAt = await this.findNextPendingJobRunAt();
    if (nextRunAt === null) {
      return this.idlePollIntervalMs;
    }

    return Math.min(Math.max(nextRunAt.getTime() - Date.now(), 0), this.idlePollIntervalMs);
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

  private async findNextPendingJobRunAt(): Promise<Date | null> {
    const [job] = await this.db
      .select({ runAt: scheduledJobs.runAt })
      .from(scheduledJobs)
      .where(and(
        eq(scheduledJobs.guildId, this.guildId),
        eq(scheduledJobs.status, 'PENDING'),
      ))
      .orderBy(asc(scheduledJobs.runAt))
      .limit(1);

    return job?.runAt ?? null;
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
