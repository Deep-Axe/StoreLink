import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { acquireClusterLock } from './lib/cluster-lock.ts';
import { kubectlCommand } from './lib/kubectl.ts';

acquireClusterLock();
console.log(`Pod-delete-only check started at ${new Date().toISOString()}`);
const kube = async (...args: string[]) =>
  (
    await promisify(execFile)(kubectlCommand(), ['-n', 'storelink', ...args], {
      env: { ...process.env, KUBECONFIG: `${process.cwd()}/.data/kubeconfig` },
      timeout: 120000,
    })
  ).stdout;
const material = JSON.parse(readFileSync('.data/cluster-secrets.json', 'utf8'));
const key = JSON.parse(
  Buffer.from(material['gateway-keys'], 'base64').toString(),
)['member-b'];
const password = Buffer.from(
  material['dashboard-admin-password'],
  'base64',
).toString('utf8');
const origin = 'http://dashboard.storelink.localhost';
const login = await fetch(origin + '/api/login', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@storelink.local', password }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie')!.split(';')[0];
const { csrf } = await login.json();
async function api(path: string) {
  const response = await fetch(origin + '/api' + path, {
    headers: { cookie },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
const client = new Client({ name: 'storelink-pod-delete-check', version: '1' });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  assert.equal(
    (await client.callTool({ name: 'ops__get_status', arguments: {} })).isError,
    undefined,
  );
  const initial = JSON.parse(
    await kube(
      'get',
      'pods',
      '-l',
      'storelink/component=operations-mcp',
      '-o',
      'json',
    ),
  ).items;
  assert.equal(initial.length, 1);
  const oldUid = initial[0].metadata.uid;
  const eventsBefore = await api('/server-events');
  const lastSequence = Number(eventsBefore[0]?.sequence ?? 0);
  // No client traffic during the outage: the gateway's health probe must detect it.
  const failureStarted = Date.now();
  await kube(
    'delete',
    'pod',
    initial[0].metadata.name,
    '--grace-period=0',
    '--force',
    '--wait=false',
  );
  let failed: { status: string; lastError?: string } | undefined;
  while (Date.now() - failureStarted < 15000) {
    failed = (await api('/servers')).find(
      (s: { id: string }) => s.id === 'ops',
    );
    if (failed?.status === 'Unreachable') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(
    failed?.status,
    'Unreachable',
    'Dashboard never reported the deleted upstream as Unreachable',
  );
  const detectedMs = Date.now() - failureStarted;
  const events = await api('/server-events');
  assert.ok(
    events.some(
      (e: { sequence: string; server_id: string; status: string }) =>
        Number(e.sequence) > lastSequence &&
        e.server_id === 'ops' &&
        e.status === 'Unreachable',
    ),
  );
  assert.equal(
    (await client.callTool({ name: 'time__get_status', arguments: {} }))
      .isError,
    undefined,
  );
  const { orderId } = JSON.parse(
    readFileSync('.data/last-store-check.json', 'utf8'),
  );
  assert.equal(
    (
      await client.callTool({
        name: 'woo__get_order',
        arguments: { order_id: orderId },
      })
    ).isError,
    undefined,
  );
  const deployment = JSON.parse(
    await kube('get', 'deployment/storelink-operations-mcp', '-o', 'json'),
  );
  assert.equal(deployment.spec.replicas, 1);
  console.log(
    JSON.stringify({
      deletedPodUid: oldUid,
      observed: 'Unreachable',
      lastError: failed?.lastError,
      clientCallsDuringOutage: 0,
      otherServers: 'time and Woo healthy',
      replicas: 1,
      detectedMs,
    }),
  );
  await kube(
    'rollout',
    'status',
    'deployment/storelink-operations-mcp',
    '--timeout=90s',
  );
  // Each gateway replica probes upstreams itself, so wait until a call succeeds
  // rather than trusting a catalog that another replica may have served.
  const until = Date.now() + 45000;
  while (
    !(await client.listTools()).tools.some(
      (t) => t.name === 'ops__get_status',
    ) ||
    (await client.callTool({ name: 'ops__get_status', arguments: {} })).isError
  ) {
    assert.ok(Date.now() < until, 'Catalog did not recover');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const replacement = JSON.parse(
    await kube(
      'get',
      'pods',
      '-l',
      'storelink/component=operations-mcp',
      '-o',
      'json',
    ),
  ).items;
  assert.ok(
    replacement.some(
      (pod: { metadata: { uid: string } }) => pod.metadata.uid !== oldUid,
    ),
  );
  console.log(
    'Deployment replaced the deleted pod automatically; tools and calls recovered without scaling.',
  );
} finally {
  await kube(
    'rollout',
    'status',
    'deployment/storelink-operations-mcp',
    '--timeout=90s',
  ).catch(() => {});
  await client.close();
  await fetch(origin + '/api/logout', {
    method: 'POST',
    headers: {
      origin,
      cookie,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    },
    body: '{}',
  });
}
