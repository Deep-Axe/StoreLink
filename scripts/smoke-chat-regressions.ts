import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { acquireClusterLock } from './lib/cluster-lock.ts';

acquireClusterLock();
console.log(`Chat regression started at ${new Date().toISOString()}`);
const origin =
  process.env.STORELINK_DASHBOARD_URL ?? 'http://dashboard.storelink.localhost';
const secrets = JSON.parse(readFileSync('.data/cluster-secrets.json', 'utf8'));
const password = Buffer.from(
  secrets['dashboard-admin-password'],
  'base64',
).toString('utf8');
async function login(email: string, password: string) {
  const response = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const { csrf } = await response.json();
  return async (path: string, body?: unknown, method = body ? 'POST' : 'GET') =>
    fetch(origin + '/api' + path, {
      method,
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrf,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(130000),
    });
}
const admin = await login('admin@storelink.local', password);
const email = `invite-${Date.now()}@storelink.test`;
const invited = await admin('/invitations', { email });
assert.equal(invited.status, 201);
const invite = await invited.json();
const token = new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
  'invite',
);
const memberPassword = randomBytes(24).toString('base64url');
const accepted = await fetch(origin + '/api/accept-invite', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ token, password: memberPassword }),
});
assert.equal(accepted.status, 201);
const member = await login(email, memberPassword);
const me = await (await member('/me')).json();
try {
  const before = await (await member('/conversations')).json();
  assert.equal(before.length, 0);
  for (let i = 0; i < 17; i++)
    assert.equal((await member('/chat', { message: '  \t ' })).status, 400);
  const after = await (await member('/conversations')).json();
  assert.equal(after.length, 0);
  assert.equal(
    (
      await member('/chat', {
        message: 'hello',
        conversationId: 'foreign-conversation',
      })
    ).status,
    404,
  );
  // One paid, read-only turn proves invalid requests did not exhaust the 15-turn allowance.
  const response = await member('/chat', {
    message:
      'Use only time__get_status to report the store timezone. Do not change anything.',
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.id);
  assert.ok(
    result.activity.some(
      (a: { name: string; isError: boolean }) =>
        a.name === 'time__get_status' && !a.isError,
    ),
  );
  assert.ok(result.inputTokens > 0);
  assert.ok(result.outputTokens > 0);
  const saved = await (await member('/conversations/' + result.id)).json();
  assert.equal(saved.input_tokens, String(result.inputTokens));
  console.log(
    JSON.stringify({
      validationRequests: 17,
      orphanConversations: 0,
      readOnlyTool: 'time__get_status',
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    }),
  );
} finally {
  assert.equal(
    (await admin('/members/' + me.user.userId, undefined, 'DELETE')).status,
    200,
  );
  await member('/logout', {}, 'POST').catch(() => {});
  await admin('/logout', {}, 'POST');
}
