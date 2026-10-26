import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { acquireClusterLock } from './lib/cluster-lock.ts';

acquireClusterLock();
console.log(
  `Catalog notification check started at ${new Date().toISOString()}`,
);
const origin =
  process.env.STORELINK_DASHBOARD_URL ?? 'http://dashboard.storelink.localhost';
const secrets = JSON.parse(readFileSync('.data/cluster-secrets.json', 'utf8'));
const password = Buffer.from(
  secrets['dashboard-admin-password'],
  'base64',
).toString('utf8');
const login = await fetch(origin + '/api/login', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@storelink.local', password }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie')!.split(';')[0];
const { csrf } = await login.json();
async function api(
  path: string,
  body?: unknown,
  method = body ? 'POST' : 'GET',
) {
  const response = await fetch(origin + '/api' + path, {
    method,
    headers: {
      origin,
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
}
const servers = await api('/servers');
const operations = servers.find(
  (server: { id: string }) => server.id === 'ops',
);
assert.ok(operations?.enabled);
let keyId: string | undefined;
let notifications = 0,
  streamOpen = false;
let catalog: string[] = [];
const client = new Client(
  { name: 'storelink-live-notifications', version: '1' },
  {
    listChanged: {
      tools: {
        autoRefresh: true,
        onChanged(error, tools) {
          assert.ifError(error);
          catalog = (tools ?? []).map((tool) => tool.name);
          notifications++;
        },
      },
    },
  },
);
async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < end, 'No automatic catalog update received');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
try {
  const issued = await api('/keys', {
    userId: 'member-b',
    label: 'Catalog notification smoke',
  });
  keyId = issued.id;
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${issued.key}` } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === 'GET' && response.ok) streamOpen = true;
        return response;
      },
    }),
  );
  await until(() => streamOpen);
  catalog = (await client.listTools()).tools.map((tool) => tool.name);
  assert.equal(catalog.length, 9);
  await api('/servers', {
    id: operations.id,
    slug: operations.slug,
    url: operations.url,
    enabled: false,
  });
  await until(
    () =>
      notifications > 0 && !catalog.some((name) => name.startsWith('ops__')),
  );
  assert.ok(
    catalog.some((name) => name.startsWith('woo__')) &&
      catalog.some((name) => name.startsWith('time__')),
  );
  assert.equal(
    (await client.callTool({ name: 'ops__get_status', arguments: {} })).isError,
    true,
  );
  assert.equal(
    (await client.callTool({ name: 'time__get_status', arguments: {} }))
      .isError,
    undefined,
  );
  const disabledCount = notifications;
  await api('/servers', {
    id: operations.id,
    slug: operations.slug,
    url: operations.url,
    enabled: true,
  });
  await until(
    () =>
      notifications > disabledCount &&
      catalog.some((name) => name === 'ops__get_status'),
  );
  await api('/keys/' + keyId, undefined, 'DELETE');
  await assert.rejects(() =>
    client.callTool({ name: 'time__get_status', arguments: {} }),
  );
  console.log(
    JSON.stringify({
      transport: 'Streamable HTTP + GET SSE through Ingress',
      notifications,
      automaticCatalogRefresh: true,
      revocation: true,
      tools: catalog.length,
    }),
  );
} finally {
  await api('/servers', {
    id: operations.id,
    slug: operations.slug,
    url: operations.url,
    enabled: operations.enabled,
  });
  if (keyId) await api('/keys/' + keyId, undefined, 'DELETE');
  await client.close();
  await api('/logout', {}, 'POST');
}
