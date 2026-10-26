import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client, Pool } from 'pg';
import { apiKeyPepper, secret } from '../../../packages/shared/src/secrets.ts';
import { KubernetesClient, StoreCluster } from './k8s-client.ts';
import { KubernetesCredentials } from './credentials.ts';
import {
  PostgresStoreRegistrar,
  PostgresStoreRepository,
  StoreProvisioner,
} from './store-provisioner.ts';
import type { StoreSettings } from './store-manifests.ts';

// Creates and removes stores requested through the dashboard. It runs as its own
// Deployment so the internet-facing gateway never holds cluster-wide rights.
const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Supply ${name}`);
  return value;
};
const namespace = env('POD_NAMESPACE', 'storelink');
const settings: StoreSettings = {
  images: {
    app: env('STORE_IMAGE_APP'),
    store: env('STORE_IMAGE_STORE'),
    mariadb: env('STORE_IMAGE_MARIADB'),
    pullPolicy: env('STORE_IMAGE_PULL_POLICY', 'IfNotPresent'),
  },
  hostSuffix: env('STORES_HOST_SUFFIX'),
  scheme: env('STORES_SCHEME', 'http') === 'https' ? 'https' : 'http',
  tlsSecretName: process.env.STORES_TLS_SECRET || undefined,
  tlsClusterIssuer: process.env.STORES_TLS_CLUSTER_ISSUER || undefined,
  quota: JSON.parse(env('STORES_QUOTA', '{}')),
  ingressClass: env('STORES_INGRESS_CLASS', 'traefik'),
  storageClass: env('STORES_STORAGE_CLASS', 'local-path'),
  storage: {
    wordpress: env('STORES_WORDPRESS_STORAGE', '2Gi'),
    mariadb: env('STORES_MARIADB_STORAGE', '1Gi'),
  },
  timezone: env('STORE_TIMEZONE', 'Asia/Kolkata'),
  woocommerceVersion: env('WOOCOMMERCE_VERSION'),
  gateway: { namespace, instance: env('GATEWAY_INSTANCE') },
  // The same file the chart mounts for the main store's readiness probe.
  healthPhp: readFileSync(
    new URL('../../../charts/storelink/files/health.php', import.meta.url),
    'utf8',
  ),
  resources: JSON.parse(env('STORES_RESOURCES')),
};

const pool = new Pool({
  connectionString: secret('DATABASE_URL'),
  max: 3,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000,
});
pool.on('error', () =>
  console.error('Application database connection interrupted'),
);
const provisioner = new StoreProvisioner({
  tokenKey: apiKeyPepper(),
  repository: new PostgresStoreRepository(pool),
  cluster: new StoreCluster(new KubernetesClient()),
  registrar: new PostgresStoreRegistrar(
    pool,
    new KubernetesCredentials(
      namespace,
      env('UPSTREAM_SECRET_NAME'),
      apiKeyPepper(),
    ),
  ),
  settings,
});

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const client = await pool.connect();
    try {
      // One pass at a time across overlapping provisioner pods.
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(87264004) AS locked',
      );
      if (!rows[0].locked) return;
      try {
        await provisioner.reconcile();
      } finally {
        await client.query('SELECT pg_advisory_unlock(87264004)');
      }
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(
      `Store reconciliation failed: ${error instanceof Error ? error.message : 'unexpected error'}`,
    );
  } finally {
    running = false;
  }
}
const timer = setInterval(() => void tick(), 5000);
void tick();

// Dashboard requests are announced so they start without waiting for the timer.
let listener: Client | undefined;
let closing = false;
async function listen() {
  if (closing) return;
  const client = new Client({ connectionString: secret('DATABASE_URL') });
  client.on('notification', () => void tick());
  client.on('error', () => {
    void client.end().catch(() => {});
    if (!closing) setTimeout(() => void listen(), 2000);
  });
  try {
    await client.connect();
    await client.query('LISTEN storelink_stores');
    listener = client;
  } catch {
    void client.end().catch(() => {});
    setTimeout(() => void listen(), 2000);
  }
}
void listen();

const health = createServer((req, res) => {
  if (req.url === '/health/live') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.url === '/health/ready') {
    void pool.query('SELECT 1').then(
      () => res.writeHead(200).end('ok'),
      () => res.writeHead(503).end(),
    );
    return;
  }
  res.writeHead(404).end();
}).listen(
  Number(process.env.PORT ?? 3000),
  process.env.BIND_ADDRESS ?? '127.0.0.1',
);

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    closing = true;
    clearInterval(timer);
    health.close();
    await listener?.end().catch(() => {});
    while (running) await new Promise((resolve) => setTimeout(resolve, 100));
    await pool.end();
  });
