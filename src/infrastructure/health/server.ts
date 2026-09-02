import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Client } from 'discord.js';

export interface HealthDependencies {
  readonly client: Client;
  readonly checkDatabase: () => Promise<boolean>;
}

export async function startHealthServer(port: number, dependencies: HealthDependencies): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'not_found' }));
      return;
    }

    void respondWithHealth(response, dependencies);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

async function respondWithHealth(
  response: ServerResponse,
  dependencies: HealthDependencies,
): Promise<void> {
  const database = await dependencies.checkDatabase().catch(() => false);
  const discord = dependencies.client.isReady();
  const healthy = database && discord;
  response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ status: healthy ? 'ok' : 'degraded', database, discord }));
}
