import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { DevelopmentStore } from '../services/gateway/src/store.ts';
import { Gateway } from '../services/gateway/src/gateway.ts';
import { gatewayHttpHandler } from '../services/gateway/src/mcp.ts';
import { expressMcpApp } from '../packages/shared/src/mcp-http.ts';
import { generateApiKey, hashApiKey } from '../packages/shared/src/api-keys.ts';

async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < end, 'Timed out waiting for catalog notification');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function setup(
  t: { after: (fn: () => unknown) => void },
  options: Parameters<typeof gatewayHttpHandler>[2] = {},
) {
  const store = new DevelopmentStore(':memory:');
  const pepper = randomBytes(32);
  const gateway = new Gateway(store, pepper);
  const keys: Record<string, { raw: string; id: string }> = {};
  for (const [user, team] of [
    ['alice', 'a'],
    ['bob', 'b'],
    ['other-alice', 'a'],
  ]) {
    store.addUser(user, team, 'member');
    const raw = generateApiKey();
    keys[user] = { raw, id: store.addKey(user, hashApiKey(raw, pepper)) };
  }
  for (const team of ['a', 'b'])
    gateway.register({
      id: team,
      teamId: team,
      slug: 'time',
      client: {
        async listTools() {
          return {
            tools: [{ name: 'status', inputSchema: { type: 'object' } }],
          };
        },
        async callTool() {
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
    });
  await gateway.refreshAll();
  // Allocate the listener before the app so the validated origin includes its actual port.
  const { createServer } = await import('node:http');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const handler = gatewayHttpHandler(gateway, origin, options);
  server.on('request', expressMcpApp(handler, origin));
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
    await handler.close();
    server.closeAllConnections();
    server.close();
    store.close();
  });
  async function connect(user: string) {
    let notifications = 0,
      streamOpen = false;
    const client = new Client({ name: 'notification-test', version: '1' });
    clients.push(client);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications++;
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(origin + '/mcp'),
      {
        requestInit: { headers: { authorization: `Bearer ${keys[user].raw}` } },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (init?.method === 'GET' && response.ok) streamOpen = true;
          return response;
        },
      },
    );
    await client.connect(transport);
    await until(() => streamOpen);
    return { client, transport, count: () => notifications };
  }
  return { store, gateway, keys, origin, handler, connect };
}

test('real HTTP SSE notifies only the affected team; unchanged discovery is quiet and stale calls fail', async (t) => {
  const f = await setup(t);
  const a = await f.connect('alice'),
    b = await f.connect('bob');
  assert.equal(a.client.getServerCapabilities()?.tools?.listChanged, true);
  f.gateway.setEnabled('a', false);
  await until(() => a.count() === 1);
  assert.equal(b.count(), 0);
  assert.equal((await a.client.listTools()).tools.length, 0);
  assert.equal(
    (await a.client.callTool({ name: 'time__status', arguments: {} })).isError,
    true,
  );
  assert.equal(
    (await b.client.callTool({ name: 'time__status', arguments: {} })).isError,
    undefined,
  );
  f.gateway.setEnabled('a', true);
  await f.gateway.refresh('a');
  await until(() => a.count() === 2);
  assert.equal((await a.client.listTools()).tools.length, 1);
  await f.gateway.refreshAll();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(a.count(), 2);
  assert.equal(b.count(), 0);
  // Deletion/re-registration and changed metadata also invalidate the catalog.
  f.gateway.setEnabled('a', false);
  f.gateway.upstreams.delete('a');
  await until(() => a.count() === 3);
  f.gateway.register({
    id: 'new-a',
    teamId: 'a',
    slug: 'new',
    client: {
      async listTools() {
        return {
          tools: [
            {
              name: 'edited',
              description: 'new metadata',
              inputSchema: { type: 'object' },
            },
          ],
        };
      },
      async callTool() {
        return { content: [] };
      },
    },
  });
  await f.gateway.refresh('new-a');
  await until(() => a.count() === 4);
  assert.equal((await a.client.listTools()).tools[0].name, 'new__edited');
  assert.equal(b.count(), 0);
});

test('sessions reject another user/key and revoked users receive no catalog notifications', async (t) => {
  const f = await setup(t);
  const a = await f.connect('alice');
  const request = (key: string) =>
    fetch(f.origin + '/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'mcp-session-id': a.transport.sessionId!,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'time__status', arguments: {} },
      }),
    });
  assert.equal((await request(f.keys['other-alice'].raw)).status, 403);
  const replacement = generateApiKey();
  f.store.addKey('alice', hashApiKey(replacement, f.gateway.pepper));
  assert.equal((await request(replacement)).status, 403);
  assert.deepEqual(
    (({ reason, server_id }) => ({ reason, server_id }))(
      f.store.auditRows().at(-1)!,
    ),
    { reason: 'session_owner_mismatch', server_id: 'a' },
  );
  f.store.revokeKey(f.keys.alice.id);
  assert.equal((await request(f.keys.alice.raw)).status, 401);
  assert.equal(f.store.auditRows().at(-1)?.server_id, 'a');
  f.gateway.setEnabled('a', false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(a.count(), 0);
  assert.equal(f.store.auditRows().at(-1)?.reason, 'key_revoked');
});

test('session capacity, DELETE cleanup and idle expiry are enforced', async (t) => {
  let now = 0;
  const f = await setup(t, {
    maxUserSessions: 1,
    maxSessions: 2,
    sessionTtlMs: 10000,
    now: () => now,
  });
  const a = await f.connect('alice');
  await assert.rejects(() => f.connect('alice'), /Too many MCP sessions/);
  await a.transport.terminateSession();
  const fresh = await f.connect('alice');
  now = 10001;
  await assert.rejects(() => fresh.client.listTools(), /session expired|404/i);
  const next = await f.connect('alice');
  assert.equal((await next.client.listTools()).tools.length, 1);
});
