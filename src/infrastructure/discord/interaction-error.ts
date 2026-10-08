export function describeInteractionError(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    code: errorCode(error) ?? errorCode(cause),
    status: errorHttpStatus(error),
    // API error objects can contain interaction tokens and evidence in requestBody/url.
    stack: error instanceof Error ? error.stack?.split('\n').filter((line) => line.trimStart().startsWith('at ')).slice(0, 8).join('\n') : undefined,
  };
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined;
}

function errorHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}
