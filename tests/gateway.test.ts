import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateApiKey, hashApiKey } from '../packages/shared/src/api-keys.ts';
import { DevelopmentStore } from '../services/gateway/src/store.ts';
import { Gateway } from '../services/gateway/src/gateway.ts';
import type { ToolClient } from '../services/gateway/src/gateway.ts';
import { gatewayHttpHandler } from '../services/gateway/src/mcp.ts';
import { upstreamClient } from '../services/gateway/src/upstream.ts';
import { WooStoreClient } from '../services/woocommerce-mcp/src/store-client.ts';
import { wooHttpHandler } from '../services/woocommerce-mcp/src/server.ts';

const statusTool = {
  name: 'get_status',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
const statusClient = (name: string): ToolClient => ({
  async listTools() {
    return { tools: [statusTool] };
  },
  async callTool() {
    return { content: [{ type: 'text', text: name }] };
  },
});

function firstText(result: CallToolResult): string {
  const content = result.content[0];
  assert.ok(content?.type === 'text');
  return content.text;
}

async function setup() {
  const store = new DevelopmentStore(':memory:');
  const pepper = randomBytes(32);
  const gateway = new Gateway(store, pepper, { discoveryMs: 30, callMs: 30 });
  const key = generateApiKey();
  store.addUser('member-b', 'team', 'member');
  const keyId = store.addKey('member-b', hashApiKey(key, pepper));
  return {
    store,
    pepper,
    gateway,
    key,
    keyId,
    actor: await gateway.authenticate(key),
  };
}

test('API digests support direct lookup without storing recoverable keys; revoked ownership survives restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'urumi-'));
  const filename = join(directory, 'gateway.sqlite');
  const pepper = randomBytes(32),
    key = generateApiKey();
  try {
    const first = new DevelopmentStore(filename);
    first.addUser('b', 'team', 'member');
    const digest = hashApiKey(key, pepper);
    const id = first.addKey('b', digest);
    assert.notEqual(hashApiKey(key, randomBytes(32)), digest);
    assert.equal(first.findKey(hashApiKey(key, pepper))?.userId, 'b');
    first.revokeKey(id);
    first.close();
    assert.equal(readFileSync(filename).includes(Buffer.from(key)), false);
    const reopened = new DevelopmentStore(filename);
    assert.ok(reopened.findKey(digest)?.revokedAt);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('colliding upstream names stay distinct; disable immediately removes routes and rejects stale calls', async (t) => {
  const { gateway, store, actor } = await setup();
  t.after(() => store.close());
  for (const slug of ['time', 'operations'])
    gateway.register({
      id: slug,
      teamId: 'team',
      slug,
      client: statusClient(slug),
    });
  await gateway.refreshAll();
  assert.deepEqual(
    (await gateway.listTools(actor)).map((tool) => tool.name).sort(),
    ['operations__get_status', 'time__get_status'],
  );
  assert.equal(
    firstText(await gateway.call(actor, 'operations__get_status')),
    'operations',
  );
  gateway.setEnabled('operations', false);
  assert.deepEqual(
    (await gateway.listTools(actor)).map((tool) => tool.name),
    ['time__get_status'],
  );
  assert.equal(
    (await gateway.call(actor, 'operations__get_status')).isError,
    true,
  );
  assert.equal(store.auditRows().at(-1)?.outcome, 'denied');
});

test('an unrelated hung server does not block a healthy route; mutation uncertainty is audited without retry', async (t) => {
  const { gateway, store, actor } = await setup();
  t.after(() => store.close());
  gateway.register({
    id: 'healthy',
    teamId: 'team',
    slug: 'healthy',
    client: statusClient('alive'),
  });
  await gateway.refresh('healthy');
  gateway.register({
    id: 'hung',
    teamId: 'team',
    slug: 'hung',
    client: {
      listTools: () => new Promise(() => {}),
      callTool: () => new Promise(() => {}),
    },
  });
  const refresh = gateway.refresh('hung');
  assert.equal(
    firstText(await gateway.call(actor, 'healthy__get_status')),
    'alive',
  );
  await refresh;
  assert.equal(gateway.upstreams.get('hung')?.status, 'Unreachable');
  let calls = 0;
  gateway.register({
    id: 'writer',
    teamId: 'team',
    slug: 'writer',
    client: {
      async listTools() {
        return {
          tools: [
            {
              ...statusTool,
              name: 'create',
              annotations: { readOnlyHint: false },
            },
          ],
        };
      },
      callTool() {
        calls++;
        return new Promise(() => {});
      },
    },
  });
  await gateway.refresh('writer');
  const result = await gateway.call(actor, 'writer__create');
  assert.equal(result.isError, true);
  assert.match(firstText(result), /may have completed/);
  assert.equal(calls, 1);
  assert.equal(store.auditRows().at(-1)?.outcome, 'uncertain');
  assert.equal(gateway.upstreams.get('writer')?.status, 'Unreachable');
});

test('argument errors keep a healthy upstream connected, and cross-team routes are hidden', async (t) => {
  const { gateway, store, actor } = await setup();
  t.after(() => store.close());
  let calls = 0;
  gateway.register({
    id: 'time',
    teamId: 'team',
    slug: 'time',
    client: {
      async listTools() {
        return { tools: [statusTool] };
      },
      async callTool() {
        calls++;
        return { content: [] };
      },
    },
  });
  gateway.register({
    id: 'other',
    teamId: 'other-team',
    slug: 'other',
    client: statusClient('private'),
  });
  await gateway.refreshAll();
  assert.equal((await gateway.listTools(actor)).length, 1);
  assert.equal(
    (await gateway.call(actor, 'time__get_status', { invalid: true })).isError,
    true,
  );
  assert.equal(calls, 0);
  assert.equal(gateway.upstreams.get('time')?.status, 'Connected');
  assert.equal((await gateway.call(actor, 'other__get_status')).isError, true);
});

test('late discovery cannot restore a server disabled during discovery', async (t) => {
  const { gateway, store, actor } = await setup();
  t.after(() => store.close());
  let complete!: (value: { tools: (typeof statusTool)[] }) => void;
  gateway.register({
    id: 'time',
    teamId: 'team',
    slug: 'time',
    client: {
      listTools: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      callTool: statusClient('time').callTool,
    },
  });
  const pending = gateway.refresh('time');
  gateway.setEnabled('time', false);
  complete({ tools: [statusTool] });
  await pending;
  assert.equal(gateway.upstreams.get('time')?.status, 'Disabled');
  assert.deepEqual(await gateway.listTools(actor), []);
});

test('audit persistence failure prevents an upstream side effect', async (t) => {
  const { gateway, store, actor } = await setup();
  t.after(() => store.close());
  let calls = 0;
  gateway.register({
    id: 'time',
    teamId: 'team',
    slug: 'time',
    client: {
      ...statusClient('time'),
      async callTool() {
        calls++;
        return { content: [] };
      },
    },
  });
  await gateway.refreshAll();
  store.beginAudit = () => {
    throw new Error('disk full');
  };
  await assert.rejects(gateway.call(actor, 'time__get_status'), /disk full/);
  assert.equal(calls, 0);
});

test('real MCP HTTP initialization, discovery, store tools and per-request revocation work through both SDK clients', async (t) => {
  const { store, gateway, key, keyId } = await setup();
  t.after(() => store.close());
  const serviceToken = randomBytes(32).toString('base64url');
  const requests: { method: string; url: string; body?: string }[] = [];
  const adapter = new WooStoreClient({
    publicUrl: 'https://store.example.test',
    connectService: 'wordpress.urumi.svc.cluster.local',
    consumerKey: 'ck_test_fixture',
    consumerSecret: 'cs_test_fixture',
    async send(input) {
      requests.push({
        method: input.method,
        url: input.url.toString(),
        body: input.body,
      });
      assert.equal(input.url.origin, 'http://store.example.test');
      assert.match(input.headers.authorization, /^OAuth /);
      assert.equal(input.headers.authorization.includes(key), false);
      const value = input.url.pathname.includes('orders')
        ? {
            id: 7,
            status: 'processing',
            currency: 'INR',
            total: '12.00',
            billing: { email: 'private@example.test' },
            line_items: [],
          }
        : {
            id: 9,
            name: 'Demo',
            price: '12.00',
            status: 'publish',
            permalink: 'https://store.example.test/product/demo',
          };
      const listing =
        input.method === 'GET' && !/\/\d+$/.test(input.url.pathname);
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(listing ? [value] : value),
      };
    },
  });
  const wooHandler = wooHttpHandler(adapter, serviceToken, 'http://woo.test');
  const upstream = upstreamClient(
    new URL('http://woo.test/mcp'),
    serviceToken,
    async (input, init) => {
      const request = new Request(input, init);
      assert.equal(
        request.headers.get('authorization'),
        `Bearer ${serviceToken}`,
      );
      assert.equal(request.headers.get('cookie'), null);
      return wooHandler(request);
    },
  );
  t.after(() => upstream.close());
  gateway.register({
    id: 'woo',
    teamId: 'team',
    slug: 'woo',
    client: upstream,
  });
  await gateway.refreshAll();
  assert.equal(gateway.upstreams.get('woo')?.status, 'Connected');
  const handler = gatewayHttpHandler(gateway, 'http://gateway.test');
  const external = new Client({ name: 'external-user-b', version: 'test' });
  t.after(() => external.close());
  await external.connect(
    new StreamableHTTPClientTransport(new URL('http://gateway.test/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: (input, init) => handler(new Request(input, init)),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1,
        maxReconnectionDelay: 1,
        reconnectionDelayGrowFactor: 1,
      },
    }),
  );
  const listed = await external.listTools();
  assert.equal(listed.tools.length, 5);
  assert.ok(listed.tools.some((tool) => tool.name === 'woo__list_orders'));
  const orders = await external.callTool({
    name: 'woo__list_orders',
    arguments: {},
  });
  assert.equal(orders.isError, undefined);
  assert.equal(JSON.stringify(orders).includes('private@example.test'), false);
  await external.callTool({
    name: 'woo__create_product',
    arguments: { name: 'Demo', price: '12.00' },
  });
  await external.callTool({
    name: 'woo__get_order',
    arguments: { order_id: 7 },
  });
  await external.callTool({
    name: 'woo__update_order_status',
    arguments: { order_id: 7, status: 'completed' },
  });
  await external.callTool({ name: 'woo__list_products', arguments: {} });
  assert.equal(store.auditRows().length, 5);
  assert.ok(
    store
      .auditRows()
      .every((row) => row.user_id === 'member-b' && row.outcome === 'success'),
  );
  const count = requests.length;
  store.revokeKey(keyId);
  await assert.rejects(
    external.callTool({ name: 'woo__list_orders', arguments: {} }),
  );
  assert.equal(requests.length, count);
  assert.equal(store.auditRows().at(-1)?.reason, 'key_revoked');
  assert.equal(store.auditRows().at(-1)?.user_id, 'member-b');
  const response = await handler(
    new Request('http://gateway.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer unknown',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'woo__list_orders' },
      }),
    }),
  );
  assert.equal(response.status, 401);
  assert.equal(store.auditRows().at(-1)?.user_id, null);
  assert.equal(store.auditRows().at(-1)?.reason, 'unauthenticated');
});

test('uncertain store writes survive both MCP hops and are never retried', async (t) => {
  const { gateway, store, actor } = await setup();
  t.after(() => store.close());
  let calls = 0;
  const adapter = new WooStoreClient({
    publicUrl: 'http://store.test',
    connectService: 'wordpress',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    async send() {
      calls++;
      throw new Error('socket lost after write');
    },
  });
  const handler = wooHttpHandler(adapter, 'service-only', 'http://woo.test');
  const client = upstreamClient(
    new URL('http://woo.test/mcp'),
    'service-only',
    (input, init) => handler(new Request(input, init)),
  );
  t.after(() => client.close());
  gateway.register({ id: 'woo', teamId: 'team', slug: 'woo', client });
  await gateway.refreshAll();
  const result = await gateway.call(actor, 'woo__create_product', {
    name: 'Potentially created',
    price: '19.00',
  });
  assert.equal(result.isError, true);
  assert.equal(result._meta?.['urumi/outcome'], 'uncertain');
  assert.equal(calls, 1);
  assert.equal(store.auditRows().at(-1)?.outcome, 'uncertain');
});
