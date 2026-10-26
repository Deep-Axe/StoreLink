import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { DevelopmentStore } from '../services/gateway/src/store.ts';
import { Gateway } from '../services/gateway/src/gateway.ts';
import type { ToolClient } from '../services/gateway/src/gateway.ts';
import { upstreamClient } from '../services/gateway/src/upstream.ts';
import { mcpHttpHandler } from '../packages/shared/src/mcp-http.ts';
import { timeServer } from '../services/time-mcp/src/server.ts';

const statusTool = {
  name: 'get_status',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

function fakeClient(state: { down: boolean; hang?: boolean }): ToolClient {
  const check = async () => {
    if (state.hang) await new Promise(() => {});
    if (state.down) throw new TypeError('fetch failed');
  };
  return {
    async listTools() {
      await check();
      return { tools: [statusTool] };
    },
    async callTool() {
      await check();
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    async ping() {
      await check();
      return {};
    },
  };
}

function setup(options: { probeMs?: number; retryMs?: number } = {}) {
  const store = new DevelopmentStore(':memory:');
  const gateway = new Gateway(store, randomBytes(32), {
    discoveryMs: 50,
    callMs: 50,
    ...options,
  });
  return { store, gateway };
}

const routeNames = (gateway: Gateway) => [...gateway.routes.keys()].sort();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a failed probe marks only that upstream unreachable and holds it until the retry delay passes', async (t) => {
  const { store, gateway } = setup({ retryMs: 80 });
  t.after(() => store.close());
  const ops = { down: false };
  gateway.register({
    id: 'ops',
    teamId: 'team',
    slug: 'ops',
    client: fakeClient(ops),
  });
  gateway.register({
    id: 'time',
    teamId: 'team',
    slug: 'time',
    client: fakeClient({ down: false }),
  });
  await gateway.refreshAll();
  assert.deepEqual(routeNames(gateway), [
    'team:ops__get_status',
    'team:time__get_status',
  ]);

  ops.down = true;
  await Promise.all([gateway.checkHealth('ops'), gateway.checkHealth('time')]);
  const failed = gateway.upstreams.get('ops')!;
  assert.equal(failed.status, 'Unreachable');
  assert.equal(failed.lastError, 'Health check failed or timed out');
  assert.ok(failed.lastFailureAt);
  assert.equal(gateway.upstreams.get('time')!.status, 'Connected');
  assert.deepEqual(routeNames(gateway), ['team:time__get_status']);

  // The replacement is back, but the failure stays visible until the retry delay passes.
  ops.down = false;
  await gateway.checkHealth('ops');
  assert.equal(failed.status, 'Unreachable');
  await sleep(100);
  await gateway.checkHealth('ops');
  assert.equal(failed.status, 'Connected');
  assert.deepEqual(routeNames(gateway), [
    'team:ops__get_status',
    'team:time__get_status',
  ]);
});

test('a hung probe is bounded by the probe timeout; disabled upstreams are not probed', async (t) => {
  const { store, gateway } = setup({ probeMs: 40 });
  t.after(() => store.close());
  const state = { down: false, hang: false };
  gateway.register({
    id: 'ops',
    teamId: 'team',
    slug: 'ops',
    client: fakeClient(state),
  });
  await gateway.refreshAll();
  state.hang = true;
  const started = Date.now();
  await gateway.checkHealth('ops');
  assert.ok(Date.now() - started < 500);
  assert.equal(gateway.upstreams.get('ops')!.status, 'Unreachable');

  gateway.setEnabled('ops', false);
  await gateway.checkHealth('ops');
  assert.equal(gateway.upstreams.get('ops')!.status, 'Disabled');
});

test('the real upstream client detects an outage by ping and recovers through a fresh connection', async (t) => {
  const { store, gateway } = setup({ probeMs: 500, retryMs: 0 });
  t.after(() => store.close());
  const handler = mcpHttpHandler({
    hosts: ['time.test'],
    authorize() {},
    createServer: () => timeServer('UTC'),
  });
  const outage = { down: false };
  const client = upstreamClient(
    new URL('http://time.test/mcp'),
    '',
    async (input, init) => {
      if (outage.down) throw new TypeError('fetch failed');
      return handler(new Request(input, init));
    },
  );
  t.after(() => client.close());
  gateway.register({ id: 'time', teamId: 'team', slug: 'time', client });
  await gateway.refreshAll();
  assert.equal(gateway.upstreams.get('time')!.status, 'Connected');

  outage.down = true;
  await gateway.checkHealth('time');
  assert.equal(gateway.upstreams.get('time')!.status, 'Unreachable');
  assert.equal(gateway.routes.size, 0);

  outage.down = false;
  await gateway.checkHealth('time');
  assert.equal(gateway.upstreams.get('time')!.status, 'Connected');
  await gateway.checkHealth('time');
  assert.equal(gateway.upstreams.get('time')!.status, 'Connected');
  assert.ok(gateway.routes.has('team:time__get_status'));
});
