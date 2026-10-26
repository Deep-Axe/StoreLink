import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DevelopmentStore } from '../services/gateway/src/store.ts';
import { Gateway } from '../services/gateway/src/gateway.ts';
import { gatewayHttpHandler } from '../services/gateway/src/mcp.ts';
import { MemorySessions } from '../services/gateway/src/mcp-sessions.ts';
import { expressMcpApp } from '../packages/shared/src/mcp-http.ts';
import { generateApiKey, hashApiKey } from '../packages/shared/src/api-keys.ts';

// Two gateway replicas share one database and session store behind one origin.
// The router alternates between them, as a load balancer may.
async function setup(
  t: { after: (fn: () => unknown) => void },
  options: { maxUserSessions?: number } = {},
) {
  const store = new DevelopmentStore(':memory:');
  const sessions = new MemorySessions();
  const pepper = randomBytes(32);
  const key = generateApiKey();
  store.addUser('alice', 'team', 'member');
  store.addKey('alice', hashApiKey(key, pepper));
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const replicas = await Promise.all(
    ['one', 'two'].map(async (name) => {
      const gateway = new Gateway(store, pepper);
      gateway.register({
        id: 'time',
        teamId: 'team',
        slug: 'time',
        client: {
          async listTools() {
            return {
              tools: [{ name: 'status', inputSchema: { type: 'object' } }],
            };
          },
          async callTool() {
            return { content: [{ type: 'text', text: name }] };
          },
        },
      });
      await gateway.refreshAll();
      const handler = gatewayHttpHandler(gateway, origin, {
        sessions,
        ...options,
      });
      return { name, gateway, handler, app: expressMcpApp(handler, origin) };
    }),
  );
  const served: string[] = [];
  let next = 0;
  server.on('request', (req, res) => {
    const replica = replicas[next++ % replicas.length];
    served.push(`${req.method} ${replica.name}`);
    replica.app(req, res);
  });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
    await Promise.allSettled(replicas.map((r) => r.handler.close()));
    server.closeAllConnections();
    server.close();
    store.close();
  });
  async function connect() {
    const client = new Client({ name: 'scaling-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(origin + '/mcp'),
      { requestInit: { headers: { authorization: `Bearer ${key}` } } },
    );
    await client.connect(transport);
    clients.push(client);
    return { client, transport };
  }
  return { replicas, served, connect, origin, key };
}

const text = (result: unknown) =>
  (result as { content: { text: string }[] }).content[0].text;

test('a session started on one replica continues on the other', async (t) => {
  const f = await setup(t);
  const { client, transport } = await f.connect();
  const answers = new Set<string>();
  for (let i = 0; i < 2; i++)
    assert.equal((await client.listTools()).tools[0].name, 'time__status');
  for (let i = 0; i < 2; i++)
    answers.add(
      text(await client.callTool({ name: 'time__status', arguments: {} })),
    );
  // Both replicas served tool calls for the same session.
  assert.deepEqual([...answers].sort(), ['one', 'two']);
  assert.ok(f.served.filter((r) => r.startsWith('POST one')).length > 1);
  assert.ok(f.served.filter((r) => r.startsWith('POST two')).length > 1);

  // Ending the session on one replica ends it on both.
  const id = transport.sessionId!;
  await transport.terminateSession();
  for (let i = 0; i < 2; i++) {
    const response = await fetch(f.origin + '/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${f.key}`,
        'mcp-session-id': id,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(response.status, 404);
  }
  assert.deepEqual(
    f.served
      .slice(-2)
      .map((r) => r.split(' ')[1])
      .sort(),
    ['one', 'two'],
  );
});

test('session limits hold across replicas', async (t) => {
  const f = await setup(t, { maxUserSessions: 1 });
  const { transport } = await f.connect();
  await assert.rejects(() => f.connect(), /Too many MCP sessions/);
  await transport.terminateSession();
  await f.connect();
});

test('a replica rebuilds a session after losing its local copy', async (t) => {
  const f = await setup(t);
  const { client } = await f.connect();
  // Closing drops each replica's local servers, as a restart would; the store keeps the session.
  for (const replica of f.replicas) await replica.handler.close();
  assert.equal((await client.listTools()).tools.length, 1);
  assert.equal(
    text(await client.callTool({ name: 'time__status', arguments: {} })).length,
    3,
  );
});
