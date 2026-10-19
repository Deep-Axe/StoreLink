import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expressMcpApp } from '../../../packages/shared/src/mcp-http.ts';
import { apiKeyPepper, secret } from '../../../packages/shared/src/secrets.ts';
import { DevelopmentStore } from './store.ts';
import { Gateway } from './gateway.ts';
import { gatewayHttpHandler } from './mcp.ts';
import { upstreamClient } from './upstream.ts';
import { PostgresStore } from './postgres-store.ts';
import { FileCredentials, KubernetesCredentials } from './credentials.ts';
import { Registry } from './registry.ts';
import { dashboardApi } from './dashboard-api.ts';
import { openaiModel } from './chat.ts';

const usePostgres = Boolean(
  process.env.DATABASE_URL || process.env.DATABASE_URL_FILE,
);
if (process.env.NODE_ENV === 'production' && !usePostgres)
  throw new Error('Production requires PostgreSQL');
const store = usePostgres
  ? new PostgresStore(secret('DATABASE_URL'))
  : new DevelopmentStore(
      process.env.GATEWAY_DATABASE ?? '.data/gateway.sqlite',
    );
if (store instanceof PostgresStore) await store.migrate();
const pepper = apiKeyPepper();
const gateway = new Gateway(store, pepper);
const port = Number(process.env.GATEWAY_PORT ?? 3000);
const origin = process.env.GATEWAY_ORIGIN ?? `http://127.0.0.1:${port}`;
const app = expressMcpApp(gatewayHttpHandler(gateway, origin), origin, () =>
  store instanceof PostgresStore ? store.health() : true,
);
let registry: Registry | undefined;
let developmentClient: ReturnType<typeof upstreamClient> | undefined;
if (store instanceof PostgresStore) {
  const teamId = process.env.TEAM_ID ?? 'development';
  const defaults = [
    {
      id: 'woo',
      slug: 'woo',
      url: process.env.WOO_MCP_URL ?? 'http://127.0.0.1:3001/mcp',
    },
    {
      id: 'time',
      slug: 'time',
      url: process.env.TIME_MCP_URL ?? 'http://127.0.0.1:3002/mcp',
    },
    {
      id: 'ops',
      slug: 'ops',
      url: process.env.OPERATIONS_MCP_URL ?? 'http://127.0.0.1:3003/mcp',
    },
  ];
  const credentials = process.env.UPSTREAM_SECRET_NAME
    ? new KubernetesCredentials(
        process.env.POD_NAMESPACE ?? 'urumi',
        process.env.UPSTREAM_SECRET_NAME,
      )
    : new FileCredentials();
  registry = new Registry(
    store,
    gateway,
    credentials,
    (
      process.env.UPSTREAM_ALLOWED_ORIGINS ??
      defaults.map((server) => new URL(server.url).origin).join(',')
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  await registry.seed(teamId, defaults);
  await registry.sync();
  const model =
    process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_FILE
      ? openaiModel(secret('OPENAI_API_KEY'))
      : undefined;
  app.use(
    '/api',
    dashboardApi({
      store,
      registry,
      gateway,
      pepper,
      origin,
      model,
      modelName: process.env.OPENAI_MODEL ?? 'gpt-6-luna',
    }),
  );
  const dashboard = resolve('apps/dashboard/dist');
  if (existsSync(dashboard)) {
    app.use((_req, res, next) => {
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      next();
    });
    app.use(express.static(dashboard, { index: 'index.html', maxAge: '1h' }));
  }
} else {
  developmentClient = upstreamClient(
    new URL(process.env.WOO_MCP_URL ?? 'http://127.0.0.1:3001/mcp'),
    secret('WOO_MCP_TOKEN'),
  );
  gateway.register({
    id: 'woo',
    slug: 'woo',
    teamId: process.env.TEAM_ID ?? 'development',
    client: developmentClient,
  });
}
await gateway.refreshAll();
await registry?.recordHealth();
const server = app.listen(port, process.env.BIND_ADDRESS ?? '127.0.0.1', () =>
  console.log(`Gateway listening at ${origin}`),
);
server.on('error', () => {
  console.error('Unable to bind gateway listener');
  process.exitCode = 1;
});
let refreshing = false;
const refresh = setInterval(() => {
  if (refreshing) return;
  refreshing = true;
  void (async () => {
    try {
      await registry?.sync();
      await gateway.refreshAll();
      await registry?.recordHealth();
    } catch {
      console.error('Upstream configuration refresh failed');
    } finally {
      refreshing = false;
    }
  })();
}, 15000);
refresh.unref();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    clearInterval(refresh);
    server.close();
    await registry?.close();
    await developmentClient?.close();
    await store.close();
  });
