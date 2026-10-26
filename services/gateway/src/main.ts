import express from 'express';
import { createServer } from 'node:http';
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
import { renderPrometheus } from './metrics.ts';
import { PostgresSessions } from './mcp-sessions.ts';
import { PostgresChatAdmission, PostgresRateLimiter } from './rate-limits.ts';

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
const rateLimiter =
  store instanceof PostgresStore
    ? new PostgresRateLimiter(store.pool)
    : undefined;
const mcpHandler = gatewayHttpHandler(gateway, origin, {
  sessions:
    store instanceof PostgresStore
      ? new PostgresSessions(store.pool)
      : undefined,
  rateLimiter,
  requestsPerMinute: Number(process.env.MCP_REQUESTS_PER_MINUTE ?? 120),
});
let draining = false;
const app = expressMcpApp(mcpHandler, origin, () =>
  draining ? false : store instanceof PostgresStore ? store.health() : true,
);
let registry: Registry | undefined;
let stopListening: (() => Promise<void>) | undefined;
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
        process.env.POD_NAMESPACE ?? 'storelink',
        process.env.UPSTREAM_SECRET_NAME,
        pepper,
      )
    : new FileCredentials(pepper);
  if (credentials instanceof KubernetesCredentials)
    await credentials.sealLegacy().then(
      (count) => {
        if (count) console.log(`Encrypted ${count} upstream credential(s)`);
      },
      () => console.error('Upstream credentials could not be encrypted'),
    );
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
  const current = registry;
  gateway.beforeRequest = () => current.ensureCurrent();
  stopListening = registry.listen(secret('DATABASE_URL'));
  const chatLimits = {
    perUserHour: Number(process.env.CHAT_PER_USER_HOUR ?? 15),
    perUserConcurrent: Number(process.env.CHAT_PER_USER_CONCURRENT ?? 1),
    perTeamConcurrent: Number(process.env.CHAT_PER_TEAM_CONCURRENT ?? 4),
    globalConcurrent: Number(process.env.CHAT_GLOBAL_CONCURRENT ?? 16),
  };
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
      chatLimits,
      rateLimiter,
      chatAdmission: new PostgresChatAdmission(store.pool, chatLimits),
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
// Prometheus metrics on a separate port that the Ingress does not route.
const metricsPort = Number(process.env.METRICS_PORT ?? 0);
const metricsServer = metricsPort
  ? createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      void (async () => {
        try {
          const body = renderPrometheus(await store.callStats(), [
            ...gateway.upstreams.values(),
          ]);
          res
            .writeHead(200, {
              'content-type': 'text/plain; version=0.0.4; charset=utf-8',
            })
            .end(body);
        } catch {
          console.error('Metrics collection failed');
          res.writeHead(503).end();
        }
      })();
    }).listen(metricsPort, process.env.BIND_ADDRESS ?? '127.0.0.1')
  : undefined;
let refreshing = false;
const refresh = setInterval(() => {
  if (refreshing) return;
  refreshing = true;
  void (async () => {
    try {
      await rateLimiter?.cleanup();
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
// Fast liveness probes catch short outages, such as a deleted pod being replaced.
let checking = false;
const health = setInterval(
  () => {
    if (checking || refreshing) return;
    checking = true;
    void (async () => {
      try {
        await registry?.ensureCurrent();
        await Promise.all(
          [...gateway.upstreams.keys()].map((id) => gateway.checkHealth(id)),
        );
        await registry?.recordHealth();
      } catch {
        console.error('Upstream health check failed');
      } finally {
        checking = false;
      }
    })();
  },
  Number(process.env.HEALTH_INTERVAL_MS ?? 1000),
);
health.unref();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    // Report not ready and keep serving while the Service and Ingress stop
    // routing here, then let in-flight requests finish before closing.
    draining = true;
    await new Promise((resolve) =>
      setTimeout(resolve, Number(process.env.SHUTDOWN_DELAY_MS ?? 0)),
    );
    clearInterval(refresh);
    clearInterval(health);
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections();
    // Event streams stay open indefinitely; their clients resume on another replica.
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, 10000)),
    ]);
    await mcpHandler.close();
    server.closeAllConnections();
    metricsServer?.close();
    await stopListening?.();
    await registry?.close();
    await developmentClient?.close();
    await store.close();
  });
