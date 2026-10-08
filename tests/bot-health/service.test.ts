import { jest } from '@jest/globals';
import { BotHealthMonitor, type BotHealthSample, type BotHealthUpdate } from '../../src/modules/bot-health/service.js';

const healthySample: BotHealthSample = {
  databaseMs: 30,
  discordReady: true,
  discordPingMs: 100,
  eventLoopDelayMs: 20,
};

function setup() {
  const sample = jest.fn<() => Promise<BotHealthSample>>().mockResolvedValue(healthySample);
  const publish = jest.fn<(update: BotHealthUpdate) => Promise<boolean>>().mockResolvedValue(true);
  const reportFailure = jest.fn<(error: unknown) => void>();
  const monitor = new BotHealthMonitor({ sample, publish, reportFailure });
  monitor.start();
  return { sample, publish, reportFailure, monitor };
}

describe('automatic bot health monitoring', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-08T13:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('refreshes healthy status without notifications and limits panel writes to every five minutes', async () => {
    const { monitor, publish, sample } = setup();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(sample).toHaveBeenCalledTimes(5);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'OPERATIONAL', notify: false }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(2);
    await monitor.stop();
  });

  it.each([
    ['database', { ...healthySample, databaseMs: 1_500 }],
    ['Discord', { ...healthySample, discordPingMs: 1_500 }],
    ['event loop', { ...healthySample, eventLoopDelayMs: 600 }],
  ])('requires consecutive slow %s checks and confirms recovery before notifying', async (_label, slowSample) => {
    const { monitor, publish, sample } = setup();
    sample.mockResolvedValue(slowSample);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'OPERATIONAL', notify: false }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'DEGRADED', notify: true }));
    sample.mockResolvedValue(healthySample);
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(publish).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'OPERATIONAL', notify: true }));
    await monitor.stop();
  });

  it('does not turn a single slow probe into an incident', async () => {
    const { monitor, sample, publish } = setup();
    sample.mockResolvedValueOnce({ ...healthySample, databaseMs: 1_001 });
    await jest.advanceTimersByTimeAsync(4 * 60_000);
    expect(publish.mock.calls.every(([update]) => update.status === 'OPERATIONAL')).toBe(true);
    await monitor.stop();
  });

  it.each([
    ['database', { ...healthySample, databaseMs: null }],
    ['Discord', { ...healthySample, discordReady: false }],
  ])('reports a disconnected %s at the next check', async (_label, disconnectedSample) => {
    const { monitor, sample, publish } = setup();
    sample.mockResolvedValue(disconnectedSample);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'DEGRADED', notify: true }));
    await monitor.stop();
  });

  it('detects an unacknowledged button while its handler is still waiting', async () => {
    const { monitor, publish } = setup();
    const finish = monitor.watchInteraction({ deferred: false, replied: false });
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(publish.mock.calls.at(-1)?.[0].status).toBe('DEGRADED');
    expect(publish.mock.calls.at(-1)?.[0].detail).toContain('3 วินาที');
    finish();
    await jest.advanceTimersByTimeAsync(6 * 60_000);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'OPERATIONAL', notify: true }));
    await monitor.stop();
  });

  it('does not treat a deferred or modal response as a timeout', async () => {
    const { monitor, publish } = setup();
    const interaction = { deferred: false, replied: false };
    const finish = monitor.watchInteraction(interaction);
    interaction.deferred = true;
    await jest.advanceTimersByTimeAsync(4_000);
    finish();
    monitor.watchInteraction({ deferred: false, replied: true })();
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(publish.mock.calls.every(([update]) => update.status === 'OPERATIONAL')).toBe(true);
    await monitor.stop();
  });

  it('detects handlers that finish without responding to a stale or unsupported button', async () => {
    const { monitor, publish } = setup();
    monitor.watchInteraction({ deferred: false, replied: false })();
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'DEGRADED' }));
    await monitor.stop();
  });

  it('detects a handler stuck after deferring and waits for completion before recovering', async () => {
    const { monitor, publish } = setup();
    const finish = monitor.watchInteraction({ deferred: true, replied: false });
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(publish.mock.calls.at(-1)?.[0].status).toBe('DEGRADED');
    expect(publish.mock.calls.at(-1)?.[0].detail).toContain('30 วินาที');
    await jest.advanceTimersByTimeAsync(6 * 60_000);
    expect(publish.mock.calls.at(-1)?.[0].status).toBe('DEGRADED');
    finish();
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'OPERATIONAL', notify: true }));
    await monitor.stop();
  });

  it('reports repeated system errors without treating one error as an outage', async () => {
    const { monitor, publish } = setup();
    monitor.recordInteractionProblem('ERROR');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'OPERATIONAL' }));
    monitor.recordInteractionProblem('ERROR');
    monitor.recordInteractionProblem('ERROR');
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'DEGRADED' }));
    await monitor.stop();
  });

  it('detects repeated slow completion even when responses were deferred in time', async () => {
    const { monitor, publish } = setup();
    for (let index = 0; index < 3; index += 1) {
      const finish = monitor.watchInteraction({ deferred: true, replied: false });
      await jest.advanceTimersByTimeAsync(10_000);
      finish();
    }
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(publish.mock.calls.at(-1)?.[0].status).toBe('DEGRADED');
    expect(publish.mock.calls.at(-1)?.[0].detail).toContain('10 วินาที');
    await monitor.stop();
  });

  it('retries failed status delivery and still sends the incident notification', async () => {
    const { monitor, publish, sample, reportFailure } = setup();
    sample.mockResolvedValue({ ...healthySample, databaseMs: null });
    publish.mockRejectedValueOnce(new Error('Discord unavailable'));
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'DEGRADED', notify: true }));
    await monitor.stop();
  });

  it('keeps checks serialized and waits for an active probe during shutdown', async () => {
    const { monitor, sample, publish } = setup();
    let resolveSample: ((value: BotHealthSample) => void) | undefined;
    sample.mockImplementation(() => new Promise((resolve) => { resolveSample = resolve; }));
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(sample).toHaveBeenCalledTimes(1);
    const stopping = monitor.stop();
    resolveSample?.(healthySample);
    await stopping;
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(sample).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('clears interaction watchdogs on shutdown', async () => {
    const { monitor, sample } = setup();
    monitor.watchInteraction({ deferred: false, replied: false });
    await monitor.stop();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(sample).not.toHaveBeenCalled();
  });
});
