import { bootstrap } from './app/bootstrap.js';

const application = await bootstrap();
let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  try {
    await application.stop();
    process.exitCode = 0;
  } catch (error: unknown) {
    console.error(`Shutdown after ${signal} failed`, error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
