import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import express from 'express';
import OpenAI from 'openai';
import { dashboardApi } from '../services/gateway/src/dashboard-api.ts';
import { hashApiKey } from '../packages/shared/src/api-keys.ts';
import type { PostgresStore } from '../services/gateway/src/postgres-store.ts';
import type { Registry } from '../services/gateway/src/registry.ts';
import type { Gateway } from '../services/gateway/src/gateway.ts';
import type { Model } from '../services/gateway/src/chat.ts';

async function fixture(t: { after: (fn: () => void) => void }, model: Model) {
  const writes: { sql: string; values: unknown[] }[] = [];
  const pepper = Buffer.alloc(32, 1),
    token = 'a'.repeat(43);
  const user = {
    userId: 'member',
    teamId: 'team',
    role: 'member',
    sessionId: 'session',
  };
  let storedMessages: unknown[] = [];
  const store = {
    pool: {
      async query(sql: string, values: unknown[] = []) {
        if (sql.includes('FROM sessions s')) return { rows: [user] };
        if (sql.startsWith('SELECT messages FROM conversations'))
          return {
            rows: values[0] === 'owned' ? [{ messages: storedMessages }] : [],
          };
        if (
          sql.startsWith('INSERT INTO conversations') ||
          sql.startsWith('UPDATE conversations')
        ) {
          writes.push({ sql, values });
          return { rows: [], rowCount: 1 };
        }
        throw new Error('Unexpected query: ' + sql);
      },
    },
  } as unknown as PostgresStore;
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  app.use(
    '/api',
    dashboardApi({
      store,
      registry: {} as Registry,
      gateway: { listTools: async () => [] } as unknown as Gateway,
      pepper,
      origin,
      model,
      modelName: 'test',
    }),
  );
  return {
    writes,
    setMessages: (messages: unknown[]) => {
      storedMessages = messages;
    },
    post: (body: unknown) =>
      fetch(origin + '/api/chat', {
        method: 'POST',
        headers: {
          origin,
          cookie: `urumi=${token}`,
          'x-csrf-token': hashApiKey(`csrf:${token}`, pepper),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
  };
}

test('HTTP chat validation returns 400/404 without creating conversations or invoking a model', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return { output: [], output_text: 'ok' };
  });
  assert.equal((await f.post({ message: '  ' })).status, 400);
  assert.equal(
    (await f.post({ message: 'hello', conversationId: 'foreign' })).status,
    404,
  );
  f.setMessages([{ role: 'user', content: 'x'.repeat(196609) }]);
  const oversized = await f.post({
    message: 'continue',
    conversationId: 'owned',
  });
  assert.equal(oversized.status, 400);
  assert.match((await oversized.json()).error, /new conversation/);
  assert.equal(calls, 0);
  assert.equal(f.writes.length, 0);
});

test('early provider rejection is non-200 and creates no conversation; successful turns persist atomically', async (t) => {
  let fail = true;
  const f = await fixture(t, async () => {
    if (fail)
      throw new OpenAI.APIError(
        401,
        { code: 'invalid_api_key' },
        'redacted',
        new Headers(),
      );
    return {
      output: [],
      output_text: 'hello',
      usage: { input_tokens: 12, output_tokens: 3 },
    };
  });
  const rejected = await f.post({ message: 'hello' });
  assert.equal(rejected.status, 502);
  assert.equal((await rejected.json()).id, undefined);
  assert.equal(f.writes.length, 0);
  fail = false;
  const accepted = await f.post({ message: 'hello' });
  assert.equal(accepted.status, 200);
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].sql, /INSERT.*messages,input_tokens,output_tokens/);
  assert.ok(JSON.parse(String(f.writes[0].values[4])).length >= 2);
  await f.post({ message: 'again', conversationId: 'owned' });
  assert.match(f.writes[1].sql, /WHERE id=\$4 AND user_id=\$5 AND team_id=\$6/);
});
