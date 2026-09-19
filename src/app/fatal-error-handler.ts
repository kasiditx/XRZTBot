export interface FatalErrorHandlerDependencies {
  readonly publishDegradedStatus: () => Promise<void>;
  readonly logFatalError: (error: Error) => void;
  readonly logStatusFailure: (error: unknown) => void;
  readonly exit: (code: number) => void;
  readonly timeoutMillis?: number;
}

export async function handleFatalError(
  error: Error,
  dependencies: FatalErrorHandlerDependencies,
): Promise<void> {
  dependencies.logFatalError(error);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      dependencies.publishDegradedStatus(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out while publishing degraded bot status')), dependencies.timeoutMillis ?? 5_000);
      }),
    ]);
  } catch (statusError: unknown) {
    dependencies.logStatusFailure(statusError);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    dependencies.exit(1);
  }
}

export function normalizeFatalError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : 'Unknown fatal process error');
}
