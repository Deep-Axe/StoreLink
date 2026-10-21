import OpenAI from 'openai';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { ResponseOutputItem } from 'openai/resources/responses/responses';
import { generateApiKey, hashApiKey } from '../packages/shared/src/api-keys.ts';
import { Gateway } from '../services/gateway/src/gateway.ts';
import { DevelopmentStore } from '../services/gateway/src/store.ts';
import { runChat, ChatInputError } from '../services/gateway/src/chat.ts';
import type { Model, ModelResponse } from '../services/gateway/src/chat.ts';
import { dayWindow } from '../services/time-mcp/src/server.ts';

const functionCall = (name: string, id: string, args = '{}') =>
  ({
    type: 'function_call',
    id: `item-${id}`,
    call_id: id,
    name,
    arguments: args,
    status: 'completed',
  }) as ResponseOutputItem;
const response = (output: ResponseOutputItem[], text = ''): ModelResponse => ({
  output,
  output_text: text,
  usage: { input_tokens: 20, output_tokens: 5 },
});
async function setup() {
  const store = new DevelopmentStore(':memory:');
  const pepper = randomBytes(32),
    key = generateApiKey();
  store.addUser('a', 'team', 'admin');
  const keyId = store.addKey('a', hashApiKey(key, pepper));
  const gateway = new Gateway(store, pepper);
  let mutations = 0;
  for (const slug of ['time', 'woo'])
    gateway.register({
      id: slug,
      teamId: 'team',
      slug,
      client: {
        async listTools() {
          return {
            tools: [
              {
                name: 'get_status',
                inputSchema: { type: 'object', properties: {} },
                annotations: { readOnlyHint: slug === 'time' },
              },
            ],
          };
        },
        async callTool() {
          if (slug === 'woo') mutations++;
          return { content: [{ type: 'text', text: `${slug} actual result` }] };
        },
      },
    });
  await gateway.refreshAll();
  return {
    store,
    gateway,
    keyId,
    actor: await gateway.authenticate(key),
    mutations: () => mutations,
  };
}

test('chat preserves Responses reasoning and call IDs, uses two gateway routes, and accounts for tokens', async (t) => {
  const setupResult = await setup();
  const { store, gateway, actor } = setupResult;
  t.after(() => store.close());
  let round = 0;
  const reasoning = {
    type: 'reasoning',
    id: 'reasoning-1',
    summary: [],
  } as ResponseOutputItem;
  const model: Model = async (input) => {
    assert.equal(input.store, false);
    assert.equal(input.parallel_tool_calls, false);
    assert.equal(input.max_output_tokens, 1800);
    assert.deepEqual(
      input.tools?.map((tool) => ('name' in tool ? tool.name : '')),
      ['time__get_status', 'woo__get_status'],
    );
    const messages = input.input as unknown[];
    if (round === 1) {
      assert.ok(messages.some((item) => item === reasoning));
      assert.ok(
        messages.some(
          (item) =>
            (item as { call_id?: string }).call_id === 'call-time' &&
            (item as { type?: string }).type === 'function_call_output',
        ),
      );
    }
    return [
      response([reasoning, functionCall('time__get_status', 'call-time')]),
      response([functionCall('woo__get_status', 'call-woo')]),
      response([], 'Both real tools answered.'),
    ][round++];
  };
  const result = await runChat({
    gateway,
    actor,
    model,
    modelName: 'scripted-test-only',
    messages: [],
    message: 'Use both services.',
  });
  assert.equal(result.text, 'Both real tools answered.');
  assert.equal(result.activity.length, 2);
  assert.equal(setupResult.mutations(), 1);
  assert.equal(result.inputTokens, 60);
  assert.equal(result.outputTokens, 15);
  assert.deepEqual(
    store.auditRows().map((row) => [row.user_id, row.server_id, row.outcome]),
    [
      ['a', 'time', 'success'],
      ['a', 'woo', 'success'],
    ],
  );
});

test('chat rechecks the enabled catalog and authorization between tool calls without replaying mutations', async (t) => {
  const { store, gateway, actor, keyId, mutations } = await setup();
  t.after(() => store.close());
  let round = 0;
  const model: Model = async (input) => {
    if (round++ === 0) {
      gateway.setEnabled('woo', false);
      return response([functionCall('woo__get_status', 'disabled')]);
    }
    assert.equal(input.tools?.length, 1);
    store.revokeKey(keyId);
    return response([functionCall('time__get_status', 'revoked')]);
  };
  const result = await runChat({
    gateway,
    actor,
    model,
    modelName: 'scripted-test-only',
    messages: [],
    message: 'Use the tools.',
  });
  assert.equal(mutations(), 0);
  assert.ok(result.activity.every((activity) => activity.isError));
  assert.ok(store.auditRows().every((row) => row.outcome === 'denied'));
});

test('chat bounds a model that continually requests tools', async (t) => {
  const { store, gateway, actor } = await setup();
  t.after(() => store.close());
  let count = 0;
  const result = await runChat({
    gateway,
    actor,
    model: async () =>
      response([functionCall('time__get_status', String(++count))]),
    modelName: 'scripted-test-only',
    messages: [],
    message: 'Read status.',
  });
  assert.equal(count, 8);
  assert.equal(result.activity.length, 8);
  assert.equal(store.auditRows().length, 8);
  assert.match(result.text, /limit/);
});

test('store day windows respect local midnight, DST and exclusive second-precision REST filters', () => {
  const india = dayWindow(
    'Asia/Kolkata',
    undefined,
    Temporal.Instant.from('2026-10-18T20:00:00Z'),
  );
  assert.equal(india.date, '2026-10-19');
  assert.equal(india.start_utc, '2026-10-18T18:30:00Z');
  assert.equal(india.after, '2026-10-18T18:29:59Z');
  const spring = dayWindow('America/New_York', '2026-03-08');
  assert.equal(
    (Date.parse(spring.end_exclusive_utc) - Date.parse(spring.start_utc)) /
      3600000,
    23,
  );
  const fall = dayWindow('America/New_York', '2026-11-01');
  assert.equal(
    (Date.parse(fall.end_exclusive_utc) - Date.parse(fall.start_utc)) / 3600000,
    25,
  );
  assert.throws(() => dayWindow('invalid/timezone', '2026-10-19'));
  assert.throws(() => dayWindow('UTC', '2026-02-30'));
});

test('chat rejects blank input and oversized context before model or tool execution', async (t) => {
  const { store, gateway, actor } = await setup();
  t.after(() => store.close());
  for (const [message, messages] of [
    ['   ', []],
    ['x'.repeat(8001), []],
    [
      'continue',
      Array.from({ length: 301 }, () => ({
        role: 'user' as const,
        content: 'old',
      })),
    ],
    ['continue', [{ role: 'user', content: 'x'.repeat(196609) }]],
  ] as const) {
    await assert.rejects(
      () =>
        runChat({
          gateway,
          actor,
          model: async () => {
            throw new Error('Model must not run');
          },
          modelName: 'test',
          message,
          messages: [...messages],
        }),
      ChatInputError,
    );
  }
  assert.equal(store.auditRows().length, 0);
});

test('model errors return actionable status, log safe diagnostics and preserve completed mutations', async (t) => {
  const { store, gateway, actor, mutations } = await setup();
  t.after(() => store.close());
  for (const [status, code, expected] of [
    [401, 'invalid_api_key', 'model_configuration'],
    [404, 'model_not_found', 'model_configuration'],
    [429, 'insufficient_quota', 'model_quota'],
    [429, 'rate_limit_exceeded', 'model_rate_limit'],
    [500, 'internal_error', 'model_unavailable'],
  ] as const) {
    let round = 0;
    const logs: unknown[] = [];
    const result = await runChat({
      gateway,
      actor,
      modelName: 'test',
      messages: [],
      message: 'Change store',
      logError: (event) => logs.push(event),
      model: async () => {
        if (round++ === 0)
          return response([functionCall('woo__get_status', 'mutation')]);
        throw new OpenAI.APIError(
          status,
          { code, message: 'SECRET_PROVIDER_MESSAGE' },
          'SECRET_PROVIDER_MESSAGE',
          new Headers({ 'x-request-id': 'req_safe' }),
        );
      },
    });
    assert.equal(result.failure?.code, expected);
    assert.notEqual(result.failure?.status, 200);
    assert.equal(result.activity.length, 1);
    assert.equal(result.inputTokens, 20);
    assert.match(result.text, /may already have completed/);
    assert.equal(logs.length, 1);
    assert.ok(!JSON.stringify(logs).includes('SECRET_PROVIDER_MESSAGE'));
    assert.match(JSON.stringify(logs), /req_safe/);
  }
  assert.equal(mutations(), 5, 'no automatic mutation retries');
});

test('SDK timeouts and signal aborts produce gateway timeout errors before any tool runs', async (t) => {
  const { store, gateway, actor } = await setup();
  t.after(() => store.close());
  for (const error of [
    new OpenAI.APIConnectionTimeoutError(),
    new OpenAI.APIUserAbortError(),
    new DOMException('deadline', 'TimeoutError'),
  ]) {
    const result = await runChat({
      gateway,
      actor,
      modelName: 'test',
      messages: [],
      message: 'hello',
      model: async () => {
        throw error;
      },
      logError: () => {},
    });
    assert.equal(result.failure?.status, 504);
    assert.equal(result.failure?.code, 'model_timeout');
    assert.equal(result.activity.length, 0);
    assert.match(result.text, /No tools ran/);
  }
});
