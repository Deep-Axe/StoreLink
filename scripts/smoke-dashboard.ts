import { acquireClusterLock } from './lib/cluster-lock.ts';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

acquireClusterLock();

const origin =
  process.env.URUMI_DASHBOARD_URL ?? 'http://dashboard.urumi.localhost';
const secret = JSON.parse(
  readFileSync('.data/cluster-secrets.json', 'utf8'),
) as Record<string, string>;
const decoded = (key: string) =>
  Buffer.from(secret[key], 'base64').toString('utf8');
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const errors: string[] = [];
async function login(page: Page, email: string, password: string) {
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
}
async function api<T>(
  context: BrowserContext,
  path: string,
  body?: unknown,
  method = body ? 'POST' : 'GET',
  expected = 200,
): Promise<T> {
  const me = await context.request.get(`${origin}/api/me`);
  const identity = await me.json();
  const result = await context.request.fetch(`${origin}/api${path}`, {
    method,
    data: body,
    headers: { origin, 'x-csrf-token': identity.csrf },
  });
  assert.equal(
    result.status(),
    expected,
    `Unexpected response from ${path}: ${result.status()}`,
  );
  return result.json();
}
const adminContext = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const memberContext = await browser.newContext();
const external = new Client({ name: 'urumi-member-check', version: '0.1.0' });
let keyId: string | undefined;
try {
  const adminPage = await adminContext.newPage();
  await login(
    adminPage,
    'admin@urumi.local',
    decoded('dashboard-admin-password'),
  );
  await adminPage.getByRole('button', { name: /Connections/ }).click();
  await adminPage.getByRole('heading', { name: 'Your connections' }).waitFor();
  await adminPage.getByText('Connected', { exact: true }).first().waitFor();
  await adminPage.screenshot({
    path: '.cache/dashboard-connections.png',
    fullPage: true,
  });
  const servers = await api<
    { id: string; status: string; slug: string; url: string }[]
  >(adminContext, '/servers');
  assert.equal(servers.length, 3);
  assert.ok(servers.every((server) => server.status === 'Connected'));
  const invalidCsrf = await adminContext.request.post(`${origin}/api/keys`, {
    data: { label: 'must not exist' },
    headers: { origin },
  });
  assert.equal(invalidCsrf.status(), 403);
  const crossOrigin = await adminContext.request.post(`${origin}/api/keys`, {
    data: { label: 'must not exist' },
    headers: { origin: 'https://untrusted.invalid' },
  });
  assert.equal(crossOrigin.status(), 403);
  console.log(
    'Dashboard login, three connected upstreams, CSRF and origin checks passed.',
  );
  const memberPage = await memberContext.newPage();
  await login(
    memberPage,
    'member@urumi.local',
    decoded('dashboard-member-password'),
  );
  await api(memberContext, '/members', undefined, 'GET', 403);
  await api(
    memberContext,
    '/servers',
    { slug: 'forbidden', url: servers[0].url, enabled: true },
    'POST',
    403,
  );
  const issued = await api<{ id: string; key: string }>(
    memberContext,
    '/keys',
    { label: 'Temporary smoke-check key' },
    'POST',
    201,
  );
  keyId = issued.id;
  await external.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${issued.key}` } },
    }),
  );
  const catalog = await external.listTools();
  assert.equal(catalog.tools.length, 9);
  for (const name of ['time__get_status', 'ops__get_status']) {
    const result = CallToolResultSchema.parse(
      await external.callTool({ name, arguments: {} }),
    );
    assert.equal(result.isError, undefined);
    assert.ok(
      result.content.some(
        (item) =>
          item.type === 'text' &&
          item.text.includes(name.startsWith('time') ? 'time' : 'operations'),
      ),
    );
  }
  await api(
    adminContext,
    '/servers',
    { slug: 'metadata', url: 'http://169.254.169.254/mcp', enabled: true },
    'POST',
    400,
  );
  await api(
    adminContext,
    '/servers',
    {
      id: 'time',
      slug: 'time',
      url: servers.find((server) => server.id === 'time')!.url,
      enabled: true,
      credential: { header: 'Host', value: 'untrusted.invalid' },
    },
    'POST',
    400,
  );
  assert.ok(
    (await external.listTools()).tools.some(
      (tool) => tool.name === 'time__get_day_window',
    ),
  );
  const time = servers.find((server) => server.id === 'time')!;
  await api(
    adminContext,
    '/servers',
    { id: time.id, slug: time.slug, url: time.url, enabled: false },
    'POST',
    201,
  );
  assert.ok(
    !(await external.listTools()).tools.some((tool) =>
      tool.name.startsWith('time__'),
    ),
  );
  assert.equal(
    CallToolResultSchema.parse(
      await external.callTool({ name: 'time__get_status', arguments: {} }),
    ).isError,
    true,
  );
  assert.equal(
    CallToolResultSchema.parse(
      await external.callTool({ name: 'ops__get_status', arguments: {} }),
    ).isError,
    undefined,
  );
  await api(
    adminContext,
    '/servers',
    { id: time.id, slug: time.slug, url: time.url, enabled: true },
    'POST',
    201,
  );
  assert.ok(
    (await external.listTools()).tools.some(
      (tool) => tool.name === 'time__get_status',
    ),
  );
  await api(memberContext, `/keys/${issued.id}`, undefined, 'DELETE');
  await assert.rejects(() =>
    external.callTool({ name: 'ops__get_status', arguments: {} }),
  );
  await assert.rejects(() => external.listTools());
  const audits = await api<
    { user_id: string; outcome: string; requested_name: string }[]
  >(adminContext, '/audit');
  assert.ok(
    audits.some(
      (row) =>
        row.user_id === 'member-b' &&
        row.outcome === 'denied' &&
        row.requested_name === 'ops__get_status',
    ),
  );
  console.log(
    'Member key issuance, duplicate-name routing, disable/re-enable, immediate revocation and denied-call attribution passed.',
  );
  const temporary = await api<{ id: string }>(
    adminContext,
    '/servers',
    {
      slug: 'temporary',
      url: time.url,
      enabled: true,
      credential: {
        header: 'Authorization',
        value: `Bearer ${decoded('time-mcp-token')}`,
      },
    },
    'POST',
    201,
  );
  try {
    const adminKey = JSON.parse(decoded('gateway-keys'))['admin-a'] as string;
    const adminClient = new Client({
      name: 'urumi-registration-check',
      version: '0.1.0',
    });
    try {
      await adminClient.connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${adminKey}` } },
        }),
      );
      assert.ok(
        (await adminClient.listTools()).tools.some(
          (tool) => tool.name === 'temporary__get_day_window',
        ),
      );
      const listing = await api<unknown>(adminContext, '/servers');
      assert.equal(
        JSON.stringify(listing).includes(decoded('time-mcp-token')),
        false,
      );
      await api(
        adminContext,
        '/servers',
        {
          id: temporary.id,
          slug: 'temporary',
          url: servers.find((server) => server.id === 'ops')!.url,
          enabled: true,
          credential: {
            header: 'authorization',
            value: `Bearer ${decoded('operations-mcp-token')}`,
          },
        },
        'POST',
        201,
      );
      const catalog = await adminClient.listTools();
      assert.ok(
        catalog.tools.some(
          (tool) => tool.name === 'temporary__get_fulfillment_policy',
        ),
      );
      assert.ok(
        !catalog.tools.some(
          (tool) => tool.name === 'temporary__get_day_window',
        ),
      );
    } finally {
      await adminClient.close();
    }
  } finally {
    await api(adminContext, `/servers/${temporary.id}`, undefined, 'DELETE');
  }
  console.log(
    'Administrator add/edit/remove and server-side credential replacement passed.',
  );
  const email = `invite-${Date.now()}@urumi.invalid`,
    password = randomBytes(24).toString('base64url');
  const invitation = await api<{ url: string }>(
    adminContext,
    '/invitations',
    { email },
    'POST',
    201,
  );
  const invited = await browser.newContext();
  try {
    const page = await invited.newPage();
    await page.goto(invitation.url);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await page.getByLabel('Email address').waitFor();
    await login(page, email, password);
    const identity = await api<{ user: { userId: string; role: string } }>(
      invited,
      '/me',
    );
    assert.equal(identity.user.role, 'member');
    const another = await api<{ id: string; key: string }>(
      invited,
      '/keys',
      { label: 'Invitation check' },
      'POST',
      201,
    );
    await api(memberContext, `/keys/${another.id}`, undefined, 'DELETE');
    const keys = await api<{ id: string; revoked_at: string | null }[]>(
      invited,
      '/keys',
    );
    assert.equal(keys.find((key) => key.id === another.id)?.revoked_at, null);
    await api(
      memberContext,
      `/conversations/foreign-conversation`,
      undefined,
      'GET',
      404,
    );
    const token = new URLSearchParams(
      new URL(invitation.url).hash.slice(1),
    ).get('invite');
    const replay = await browser.newContext();
    try {
      const result = await replay.request.post(`${origin}/api/accept-invite`, {
        data: { token, password },
        headers: { origin },
      });
      assert.equal(result.status(), 400);
    } finally {
      await replay.close();
    }
    await api(
      adminContext,
      `/members/${identity.user.userId}`,
      undefined,
      'DELETE',
    );
    await api(invited, '/me', undefined, 'GET', 401);
  } finally {
    await invited.close();
  }
  await adminPage.setViewportSize({ width: 390, height: 844 });
  await adminPage.screenshot({
    path: '.cache/dashboard-mobile.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    'Browser invitation acceptance, replay prevention, member ownership and removal checks passed.',
  );
  console.log(
    'Dashboard browser checks passed; screenshots are in .cache/. No live model calls were made.',
  );
} finally {
  if (keyId)
    await api(memberContext, `/keys/${keyId}`, undefined, 'DELETE').catch(
      () => {},
    );
  const servers = await api<
    { id: string; slug: string; url: string; enabled: boolean }[]
  >(adminContext, '/servers').catch(() => []);
  const time = servers.find((server) => server.id === 'time');
  if (time && !time.enabled)
    await api(
      adminContext,
      '/servers',
      { ...time, enabled: true },
      'POST',
      201,
    ).catch(() => {});
  await external.close();
  await browser.close();
}
