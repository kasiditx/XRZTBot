import { jest } from '@jest/globals';
import { handleFatalError, normalizeFatalError } from '../../src/app/fatal-error-handler.js';

describe('fatal process error handling', () => {
  it('publishes degraded status before exiting', async () => {
    const publishDegradedStatus = jest.fn<() => Promise<void>>().mockResolvedValue();
    const logFatalError = jest.fn<(error: Error) => void>();
    const logStatusFailure = jest.fn<(error: unknown) => void>();
    const exit = jest.fn<(code: number) => void>();
    const error = new Error('fatal failure');

    await handleFatalError(error, { publishDegradedStatus, logFatalError, logStatusFailure, exit });

    expect(logFatalError).toHaveBeenCalledWith(error);
    expect(publishDegradedStatus).toHaveBeenCalledTimes(1);
    expect(logStatusFailure).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still exits when publishing the degraded status fails', async () => {
    const statusError = new Error('Discord unavailable');
    const logStatusFailure = jest.fn<(error: unknown) => void>();
    const exit = jest.fn<(code: number) => void>();

    await handleFatalError(new Error('fatal failure'), {
      publishDegradedStatus: () => Promise.reject(statusError),
      logFatalError: () => undefined,
      logStatusFailure,
      exit,
    });

    expect(logStatusFailure).toHaveBeenCalledWith(statusError);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('normalizes non-error rejection reasons without exposing object contents', () => {
    expect(normalizeFatalError('database disconnected').message).toBe('database disconnected');
    expect(normalizeFatalError({ token: 'secret' }).message).toBe('Unknown fatal process error');
  });
});
