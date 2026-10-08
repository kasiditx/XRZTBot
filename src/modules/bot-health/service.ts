import type { BotOperationalStatus } from '../guild-config/service.js';

const CHECK_INTERVAL_MS = 60_000;
const PANEL_REFRESH_MS = 5 * 60_000;
const INTERACTION_WINDOW_MS = 5 * 60_000;
const RESPONSE_DEADLINE_MS = 3_000;
const SLOW_OPERATION_MS = 10_000;
const STALLED_OPERATION_MS = 30_000;
const SLOW_DATABASE_MS = 1_000;
const SLOW_DISCORD_MS = 1_000;
const SLOW_EVENT_LOOP_MS = 500;
const REQUIRED_BAD_CHECKS = 2;
const REQUIRED_HEALTHY_CHECKS = 3;
const REPEATED_ERROR_COUNT = 3;
const MAX_RECENT_PROBLEMS = 100;

export interface BotHealthSample {
  readonly databaseMs: number | null;
  readonly discordReady: boolean;
  readonly discordPingMs: number;
  readonly eventLoopDelayMs: number;
}

export interface BotHealthUpdate {
  readonly status: Extract<BotOperationalStatus, 'OPERATIONAL' | 'DEGRADED'>;
  readonly detail: string;
  readonly notify: boolean;
  readonly databaseAvailable: boolean;
  readonly now: Date;
}

export interface BotHealthDependencies {
  readonly sample: () => Promise<BotHealthSample>;
  readonly publish: (update: BotHealthUpdate) => Promise<boolean>;
  readonly reportFailure: (error: unknown) => void;
}

interface InteractionResponseState {
  readonly deferred: boolean;
  readonly replied: boolean;
}

type InteractionProblem = 'TIMEOUT' | 'ERROR' | 'SLOW';

export class BotHealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private activeCheck: Promise<void> | null = null;
  private started = false;
  private badChecks = 0;
  private healthyChecks = 0;
  private degraded = false;
  private lastPublishedStatus: BotHealthUpdate['status'] | null = null;
  private lastPublishedAt = 0;
  private readonly responseTimers = new Set<NodeJS.Timeout>();
  private readonly stalledInteractions = new Set<symbol>();
  private readonly problems: { readonly kind: InteractionProblem; readonly at: number }[] = [];

  public constructor(private readonly dependencies: BotHealthDependencies) {}

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleCheck();
  }

  public async stop(): Promise<void> {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const timer of this.responseTimers) clearTimeout(timer);
    this.responseTimers.clear();
    this.stalledInteractions.clear();
    await this.activeCheck;
  }

  public recordInteractionProblem(kind: InteractionProblem): void {
    this.problems.push({ kind, at: Date.now() });
    if (this.problems.length > MAX_RECENT_PROBLEMS) this.problems.shift();
  }

  public watchInteraction(interaction: InteractionResponseState): () => void {
    if (!this.started) return () => undefined;
    const startedAt = Date.now();
    const operationId = Symbol('interaction');
    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => {
      this.responseTimers.delete(timer);
      if (!interaction.deferred && !interaction.replied) {
        timedOut = true;
        this.recordInteractionProblem('TIMEOUT');
      }
    }, RESPONSE_DEADLINE_MS);
    timer.unref();
    this.responseTimers.add(timer);
    const stalledTimer = setTimeout(() => {
      this.responseTimers.delete(stalledTimer);
      this.stalledInteractions.add(operationId);
    }, STALLED_OPERATION_MS);
    stalledTimer.unref();
    this.responseTimers.add(stalledTimer);
    return () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(stalledTimer);
      this.responseTimers.delete(timer);
      this.responseTimers.delete(stalledTimer);
      this.stalledInteractions.delete(operationId);
      if (!this.started) return;
      if (!timedOut && !interaction.deferred && !interaction.replied) {
        this.recordInteractionProblem('TIMEOUT');
      } else if (!timedOut && Date.now() - startedAt >= SLOW_OPERATION_MS) {
        this.recordInteractionProblem('SLOW');
      }
    };
  }

  private scheduleCheck(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.activeCheck = this.check()
        .catch(this.dependencies.reportFailure)
        .finally(() => {
          this.activeCheck = null;
          if (this.started) this.scheduleCheck();
        });
    }, CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  private async check(): Promise<void> {
    const sample = await this.dependencies.sample();
    if (!this.started) return;
    const now = Date.now();
    while (this.problems[0] !== undefined && this.problems[0].at <= now - INTERACTION_WINDOW_MS) {
      this.problems.shift();
    }
    const issues = healthIssues(sample, this.problems.map(({ kind }) => kind));
    if (this.stalledInteractions.size > 0) issues.push('มีปุ่มหรือคำสั่งที่ยังทำงานไม่เสร็จเกิน 30 วินาที');
    this.updateHealthState(issues.length > 0, sample.databaseMs === null || !sample.discordReady);
    const status = this.degraded ? 'DEGRADED' : 'OPERATIONAL';
    const statusChanged = this.lastPublishedStatus !== status;
    if (!statusChanged && now - this.lastPublishedAt < PANEL_REFRESH_MS) return;
    const published = await this.dependencies.publish({
      status,
      detail: healthDetail(sample, this.degraded, issues),
      notify: statusChanged && (status === 'DEGRADED' || this.lastPublishedStatus !== null),
      databaseAvailable: sample.databaseMs !== null,
      now: new Date(now),
    });
    if (published) {
      this.lastPublishedStatus = status;
      this.lastPublishedAt = now;
    }
  }

  private updateHealthState(hasIssues: boolean, disconnected: boolean): void {
    if (hasIssues) {
      this.badChecks += 1;
      this.healthyChecks = 0;
      if (disconnected || this.badChecks >= REQUIRED_BAD_CHECKS) this.degraded = true;
      return;
    }
    this.badChecks = 0;
    this.healthyChecks += 1;
    if (this.healthyChecks >= REQUIRED_HEALTHY_CHECKS) this.degraded = false;
  }
}

function healthIssues(sample: BotHealthSample, problems: readonly InteractionProblem[]): string[] {
  const issues: string[] = [];
  if (sample.databaseMs === null) issues.push('เชื่อมต่อฐานข้อมูลไม่ได้');
  else if (sample.databaseMs >= SLOW_DATABASE_MS) issues.push('ฐานข้อมูลตอบช้า');
  if (!sample.discordReady) issues.push('การเชื่อมต่อ Discord ยังไม่พร้อม');
  else if (sample.discordPingMs >= SLOW_DISCORD_MS) issues.push('การเชื่อมต่อ Discord ตอบช้า');
  if (sample.eventLoopDelayMs >= SLOW_EVENT_LOOP_MS) issues.push('ระบบประมวลผลค้างหรือทำงานช้า');
  if (problems.includes('TIMEOUT')) issues.push('มีปุ่มหรือคำสั่งไม่ได้รับการตอบกลับภายใน 3 วินาที');
  if (problems.filter((kind) => kind === 'ERROR').length >= REPEATED_ERROR_COUNT) {
    issues.push('พบข้อผิดพลาดขณะใช้งานซ้ำในช่วง 5 นาทีล่าสุด');
  }
  if (problems.filter((kind) => kind === 'SLOW').length >= REPEATED_ERROR_COUNT) {
    issues.push('หลายรายการใช้เวลาทำงานเกิน 10 วินาทีในช่วง 5 นาทีล่าสุด');
  }
  return issues;
}

function healthDetail(sample: BotHealthSample, degraded: boolean, issues: readonly string[]): string {
  let summary = 'ตรวจอัตโนมัติ: การเชื่อมต่อและการตอบสนองพร้อมใช้งาน';
  if (issues.length > 0) {
    summary = degraded ? issues.join('\n') : 'พบความล่าช้าชั่วคราว กำลังตรวจซ้ำ';
  } else if (degraded) {
    summary = 'อาการดีขึ้นแล้ว กำลังตรวจยืนยันก่อนเปลี่ยนกลับเป็นปกติ';
  }
  const discord = !sample.discordReady ? 'ไม่พร้อม' : formatLatency(sample.discordPingMs);
  return [
    summary,
    '',
    `Discord: ${discord}`,
    `Database: ${sample.databaseMs === null ? 'เชื่อมต่อไม่ได้' : formatLatency(sample.databaseMs)}`,
    `Event loop: ${formatLatency(sample.eventLoopDelayMs)}`,
    'ตรวจทุก 1 นาทีโดยประมาณ · อัปเดตข้อความทุก 5 นาทีโดยประมาณ',
  ].join('\n');
}

function formatLatency(value: number): string {
  return Number.isFinite(value) && value >= 0 ? `${Math.round(value).toString()} ms` : 'ยังไม่มีข้อมูล';
}
