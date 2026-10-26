import { acquireClusterLock } from './lib/cluster-lock.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { kubectlCommand } from './lib/kubectl.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

acquireClusterLock();

const command = promisify(execFile),
  kubectl = kubectlCommand();
const env = { ...process.env, KUBECONFIG: `${process.cwd()}/.data/kubeconfig` };
const kube = (...args: string[]) =>
  command(kubectl, ['-n', 'storelink', ...args], {
    env,
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
console.log(`Failure check started at ${new Date().toISOString()}`);
const origin = 'http://dashboard.storelink.localhost';
const material = JSON.parse(
  readFileSync('.data/cluster-secrets.json', 'utf8'),
) as Record<string, string>;
const key = JSON.parse(
  Buffer.from(material['gateway-keys'], 'base64').toString(),
)['admin-a'] as string;
const password = Buffer.from(
  material['dashboard-admin-password'],
  'base64',
).toString();
const login = await fetch(`${origin}/api/login`, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@storelink.local', password }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie')!.split(';')[0];
const { csrf } = (await login.json()) as { csrf: string };
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}/api${path}`, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(body ? 10000 : 2000),
    headers: {
      origin,
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json() as Promise<T>;
}
async function until(check: () => Promise<boolean>, ms = 30000) {
  let lastError: unknown;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for recovery', { cause: lastError });
}
type Server = {
  id: string;
  slug: string;
  url: string;
  enabled: boolean;
  status: string;
};
let client = new Client({ name: 'storelink-failure-check', version: '0.1.0' });
const callTimeoutMs = Number(
  process.env.STORELINK_SMOKE_MCP_TIMEOUT_MS ?? 20000,
);
if (!Number.isFinite(callTimeoutMs) || callTimeoutMs < 20000)
  throw new Error(
    'STORELINK_SMOKE_MCP_TIMEOUT_MS must be at least 20000 (gateway call budget plus margin)',
  );
const transport = () =>
  new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal:
          init?.method === 'GET'
            ? init.signal
            : init?.signal
              ? AbortSignal.any([
                  init.signal,
                  AbortSignal.timeout(callTimeoutMs),
                ])
              : AbortSignal.timeout(callTimeoutMs),
      }),
  });
await until(async () => {
  await client.close();
  client = new Client({ name: 'storelink-failure-check', version: '0.1.0' });
  await client.connect(transport());
  return true;
});
const call = async (name: string, args: Record<string, unknown> = {}) =>
  CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
let time: Server | undefined;
try {
  const initialTime = (await api<Server[]>('/servers')).find(
    (server) => server.id === 'time',
  )!;
  if (!initialTime.enabled)
    await api('/servers', { ...initialTime, enabled: true });
  await kube(
    'delete',
    'pods',
    '-l',
    'storelink/component=operations-mcp',
    '--wait=false',
  );
  await kube('scale', 'deployment/storelink-operations-mcp', '--replicas=0');
  await kube(
    'wait',
    '--for=delete',
    'pods',
    '-l',
    'storelink/component=operations-mcp',
    '--timeout=60s',
  );
  const failureStarted = performance.now();
  assert.equal((await call('ops__get_status')).isError, true);
  const failureMs = Math.round(performance.now() - failureStarted);
  assert.ok(
    failureMs < callTimeoutMs,
    'Gateway must return its error before the client deadline',
  );
  console.log(
    `Dead upstream returned a tool error after ${failureMs} ms (client budget ${callTimeoutMs} ms).`,
  );
  assert.ok(!(await call('time__get_status')).isError);
  const servers = await api<Server[]>('/servers');
  assert.equal(
    servers.find((server) => server.id === 'ops')?.status,
    'Unreachable',
  );
  console.log(
    'Killed operations pod and held it down: dashboard reports Unreachable; time calls remain healthy.',
  );
  await kube('scale', 'deployment/storelink-operations-mcp', '--replicas=1');
  await kube(
    'rollout',
    'status',
    'deployment/storelink-operations-mcp',
    '--timeout=90s',
  );
  // Each gateway replica probes upstreams itself, so wait until a call succeeds
  // rather than trusting a catalog that another replica may have served.
  await until(async () =>
    (await client.listTools()).tools.some(
      (tool) => tool.name === 'ops__get_status',
    ),
  );
  await until(async () => !(await call('ops__get_status')).isError);
  console.log('Upstream recovered and its namespaced tools returned.');
  time = (await api<Server[]>('/servers')).find(
    (server) => server.id === 'time',
  )!;
  await api('/servers', { ...time, enabled: false });
  const auditsBefore = await api<{ id: string }[]>('/audit');
  await kube('rollout', 'restart', 'deployment/storelink-gateway');
  await kube(
    'rollout',
    'status',
    'deployment/storelink-gateway',
    '--timeout=90s',
  );
  await until(async () => {
    await api('/me');
    return true;
  });
  await until(async () => {
    await client.close();
    client = new Client({ name: 'storelink-failure-check', version: '0.1.0' });
    await client.connect(transport());
    return true;
  });
  assert.ok(
    !(await client.listTools()).tools.some((tool) =>
      tool.name.startsWith('time__'),
    ),
  );
  assert.equal(
    (await api<Server[]>('/servers')).find((server) => server.id === 'time')
      ?.status,
    'Disabled',
  );
  const auditsAfter = await api<{ id: string }[]>('/audit');
  assert.ok(auditsAfter.some((row) => row.id === auditsBefore[0].id));
  assert.ok(!(await call('ops__get_status')).isError);
  await api('/servers', { ...time, enabled: true });
  console.log(
    'Gateway restart retained session, disabled configuration and audit records.',
  );
  const evidence = JSON.parse(
    readFileSync('.data/last-store-check.json', 'utf8'),
  ) as { productId: number; orderId: number };
  await kube('rollout', 'restart', 'deployment/storelink-wordpress');
  await kube(
    'rollout',
    'status',
    'deployment/storelink-wordpress',
    '--timeout=120s',
  );
  // Readiness probes use SHORTINIT; service endpoint propagation and full Woo boot
  // can lag behind pod Ready. Only this read-only recovery probe may be repeated.
  let recoveryReads = 0;
  await until(async () => {
    recoveryReads++;
    const order = await call('woo__get_order', { order_id: evidence.orderId });
    return (
      !order.isError &&
      order.content.some(
        (item) =>
          item.type === 'text' && JSON.parse(item.text).id === evidence.orderId,
      )
    );
  }, 60000);
  console.log(
    `Read-only order recovery probe completed after ${recoveryReads} attempt(s).`,
  );
  console.log(
    `WordPress replacement retained product/order data, including order ${evidence.orderId}.`,
  );
} finally {
  await kube(
    'scale',
    'deployment/storelink-operations-mcp',
    '--replicas=1',
  ).catch(() => {});
  if (time)
    await until(async () => {
      await api('/servers', { ...time!, enabled: true });
      return true;
    }).catch(() => {});
  await client.close();
}
