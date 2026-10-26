import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { generateApiKey, hashApiKey } from '../packages/shared/src/api-keys.ts';
import { DevelopmentStore } from '../services/gateway/src/store.ts';
import { Gateway } from '../services/gateway/src/gateway.ts';
import type { ToolClient } from '../services/gateway/src/gateway.ts';
import {
  estimateQuantile,
  latencyBucketsMs,
  renderPrometheus,
  summarizeCalls,
} from '../services/gateway/src/metrics.ts';

const tool = (name: string) => ({
  name,
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
});

function client(behaviour: 'ok' | 'fail' | 'hang'): ToolClient {
  return {
    async listTools() {
      return { tools: [tool('get_status')] };
    },
    async callTool() {
      if (behaviour === 'fail') throw new TypeError('fetch failed');
      if (behaviour === 'hang') await new Promise(() => {});
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

async function setup() {
  const store = new DevelopmentStore(':memory:');
  const pepper = randomBytes(32);
  const gateway = new Gateway(store, pepper, { discoveryMs: 50, callMs: 40 });
  const key = generateApiKey();
  store.addUser('admin-a', 'team', 'admin');
  store.addKey('admin-a', hashApiKey(key, pepper));
  for (const [id, behaviour] of [
    ['time', 'ok'],
    ['ops', 'fail'],
    ['slow', 'hang'],
  ] as const)
    gateway.register({
      id,
      teamId: 'team',
      slug: id,
      client: client(behaviour),
    });
  await gateway.refreshAll();
  return { store, gateway, actor: await gateway.authenticate(key) };
}

test('call statistics aggregate outcomes and latency per upstream from the audit log', async (t) => {
  const { store, gateway, actor } = await setup();
  t.after(() => store.close());
  for (let i = 0; i < 3; i++) await gateway.call(actor, 'time__get_status', {});
  await gateway.call(actor, 'ops__get_status', {});
  await gateway.call(actor, 'slow__get_status', {});

  const stats = new Map(store.callStats().map((s) => [s.serverId, s]));
  assert.equal(stats.get('time')?.success, 3);
  assert.equal(stats.get('ops')?.failed, 1);
  assert.equal(stats.get('slow')?.timeout, 1);

  const time = summarizeCalls(stats.get('time'));
  assert.equal(time.calls, 3);
  assert.equal(time.errorRate, 0);
  const slow = summarizeCalls(stats.get('slow'));
  assert.equal(slow.errors, 1);
  assert.equal(slow.timeouts, 1);
  assert.equal(slow.errorRate, 100);
  assert.ok(slow.avgLatencyMs >= 40);
  assert.ok(slow.p95LatencyMs > 0);

  // Rows outside the window and other teams are excluded.
  assert.equal(store.callStats({ teamId: 'other' }).length, 0);
  assert.equal(
    store.callStats({ since: new Date(Date.now() + 60_000) }).length,
    0,
  );
  assert.equal(store.callStats({ teamId: 'team' }).length, 3);
});

test('denied calls are attributed to the requested server namespace', async (t) => {
  const { store, gateway, actor } = await setup();
  t.after(() => store.close());
  gateway.setEnabled('time', false);
  await gateway.call(actor, 'time__get_status', {});
  await gateway.call(actor, 'unknown__get_status', {});
  store.revokeKey(actor.keyId!);
  await assert.rejects(gateway.call(actor, 'ops__get_status', {}));

  const stats = new Map(store.callStats().map((s) => [s.serverId, s]));
  assert.equal(stats.get('time')?.denied, 1);
  assert.equal(stats.get('ops')?.denied, 1);
  assert.equal(stats.size, 2);
});

test('p95 is interpolated within the matching histogram bucket', () => {
  // 100 calls: 90 at <=5 ms, 10 between 50 and 100 ms.
  const buckets = latencyBucketsMs.map((bound) =>
    bound < 100 ? 90 : 100,
  ) as number[];
  assert.equal(estimateQuantile(0.95, buckets, 100), 75);
  assert.equal(estimateQuantile(0.5, buckets, 100), 3);
  assert.equal(
    estimateQuantile(
      0.95,
      buckets.map(() => 0),
      0,
    ),
    0,
  );
  // Calls slower than the largest bound report that bound.
  assert.equal(
    estimateQuantile(
      0.95,
      buckets.map(() => 0),
      10,
    ),
    latencyBucketsMs[latencyBucketsMs.length - 1],
  );
  assert.deepEqual(summarizeCalls(undefined), {
    calls: 0,
    errors: 0,
    timeouts: 0,
    denied: 0,
    errorRate: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
  });
});

test('Prometheus output exposes counters, a cumulative histogram and upstream state', async (t) => {
  const { store, gateway, actor } = await setup();
  t.after(() => store.close());
  await gateway.call(actor, 'time__get_status', {});
  await gateway.call(actor, 'ops__get_status', {});
  gateway.upstreams.get('slow')!.slug = 'slow "lane"';
  const text = renderPrometheus(store.callStats(), [
    ...gateway.upstreams.values(),
  ]);

  assert.match(text, /# TYPE storelink_tool_calls_total counter/);
  assert.match(
    text,
    /storelink_tool_calls_total\{team="team",server="time",slug="time",outcome="success"\} 1/,
  );
  assert.match(
    text,
    /storelink_tool_calls_total\{team="team",server="ops",slug="ops",outcome="failed"\} 1/,
  );
  assert.match(text, /# TYPE storelink_tool_call_duration_seconds histogram/);
  assert.match(
    text,
    /storelink_tool_call_duration_seconds_bucket\{team="team",server="time",slug="time",le="\+Inf"\} 1/,
  );
  assert.match(
    text,
    /storelink_tool_call_duration_seconds_count\{team="team",server="time",slug="time"\} 1/,
  );
  // Bucket counts never decrease as the bound grows.
  const timeBuckets = [
    ...text.matchAll(
      /storelink_tool_call_duration_seconds_bucket\{team="team",server="time",slug="time",le="[^"]+"\} (\d+)/g,
    ),
  ].map((match) => Number(match[1]));
  assert.equal(timeBuckets.length, latencyBucketsMs.length + 1);
  assert.deepEqual(
    timeBuckets,
    [...timeBuckets].sort((a, b) => a - b),
  );
  assert.match(
    text,
    /storelink_upstream_up\{team="team",server="time",slug="time"\} 1/,
  );
  assert.match(
    text,
    /storelink_upstream_up\{team="team",server="ops",slug="ops"\} 0/,
  );
  assert.match(
    text,
    /storelink_upstream_status\{team="team",server="ops",slug="ops",status="Unreachable"\} 1/,
  );
  assert.match(
    text,
    /storelink_upstream_last_failure_timestamp_seconds\{team="team",server="ops",slug="ops"\} \d+/,
  );
  // Label values are escaped.
  assert.match(text, /slug="slow \\"lane\\""/);
  assert.ok(text.endsWith('\n'));
});
