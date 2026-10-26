import { acquireClusterLock } from './lib/cluster-lock.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolActivity } from '../services/gateway/src/chat.ts';
import { closeClient } from './lib/mcp-client.ts';

acquireClusterLock();

// Explicit live integration script. It makes paid OpenAI calls and creates demo data.
// Run: node --env-file=.env scripts/smoke-chat.ts
if (!process.env.OPENAI_API_KEY)
  throw new Error(
    'Load OPENAI_API_KEY from the ignored .env before running the live chat check',
  );
const origin =
  process.env.STORELINK_DASHBOARD_URL ?? 'http://dashboard.storelink.localhost';
const material = JSON.parse(
  readFileSync('.data/cluster-secrets.json', 'utf8'),
) as Record<string, string>;
const secret = (name: string) =>
  Buffer.from(material[name], 'base64').toString('utf8');
const command = promisify(execFile);
type Answer = {
  id: string;
  text: string;
  activity: ToolActivity[];
  inputTokens: number;
  outputTokens: number;
};
type Server = {
  id: string;
  slug: string;
  url: string;
  enabled: boolean;
  status: string;
};
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const admin = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  }),
  member = await browser.newContext();
const pageErrors: string[] = [];
let keyId: string | undefined,
  operations: Server | undefined,
  external: Client | undefined;
const keyFile = '.data/live-chat-member-key';
const evidence: {
  checkedAt: string;
  model?: string;
  productId?: number;
  orderId?: number;
  dashboard?: unknown;
  external?: unknown;
  controls?: unknown;
} = { checkedAt: new Date().toISOString() };
async function login(
  context: BrowserContext,
  email: string,
  password: string,
): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  return page;
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
  const response = await context.request.fetch(`${origin}/api${path}`, {
    method,
    data: body,
    headers: { origin, 'x-csrf-token': identity.csrf },
    timeout: 150000,
  });
  assert.equal(response.status(), expected, `${path}: unexpected HTTP status`);
  return response.json();
}
async function ask(page: Page, message: string): Promise<Answer> {
  const waiting = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/chat` &&
      response.request().method() === 'POST',
    { timeout: 150000 },
  );
  await page.getByLabel('Message', { exact: true }).fill(message);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const response = await waiting;
  assert.equal(response.status(), 200);
  const result = (await response.json()) as Answer;
  await page
    .getByRole('button', { name: 'Send message', exact: true })
    .waitFor({ state: 'visible' });
  assert.ok(
    !/Chat could not finish|No answer was returned|reached its tool limit/.test(
      result.text,
    ),
    'The live model must finish the answer',
  );
  console.log(
    `Dashboard tools: ${result.activity.map((activity) => activity.name).join(', ') || '(none)'}`,
  );
  return result;
}
function resultData(activity: ToolActivity): unknown {
  assert.equal(activity.isError, false, `${activity.name} failed`);
  const result = CallToolResultSchema.parse(JSON.parse(activity.result));
  assert.ok(!result.isError);
  const text = result.content.find((item) => item.type === 'text');
  assert.ok(text?.type === 'text');
  return JSON.parse(text.text);
}
function calls(answer: Pick<Answer, 'activity'>, name: string) {
  return answer.activity.filter(
    (activity) => activity.name === name && !activity.isError,
  );
}
async function externalPrompt(message: string): Promise<Omit<Answer, 'id'>> {
  const result = await command(
    process.execPath,
    ['scripts/external-chat.ts', '--json', message],
    {
      env: {
        ...process.env,
        STORELINK_GATEWAY_URL: `${origin}/mcp`,
        STORELINK_GATEWAY_KEY_FILE: keyFile,
      },
      timeout: 150000,
      maxBuffer: 1024 * 1024,
    },
  );
  const answer = JSON.parse(result.stdout) as Omit<Answer, 'id'>;
  assert.ok(
    !/Chat could not finish|No answer was returned|reached its tool limit/.test(
      answer.text,
    ),
  );
  console.log(
    `External member tools: ${answer.activity.map((activity) => activity.name).join(', ')}`,
  );
  return answer;
}
try {
  const page = await login(
    admin,
    'admin@storelink.local',
    secret('dashboard-admin-password'),
  );
  const config = await api<{ chatConfigured: boolean; model: string }>(
    admin,
    '/me',
  );
  assert.equal(config.chatConfigured, true);
  evidence.model = config.model;
  const productName = `StoreLink Chat Demo ${Date.now()}`;
  const created = await ask(
    page,
    `Create exactly one published simple product named "${productName}" priced at 149.00 INR using the store tool. Return its ID and storefront URL. Do not create other products.`,
  );
  const creation = calls(created, 'woo__create_product');
  assert.equal(creation.length, 1);
  const product = resultData(creation[0]) as {
    id: number;
    name: string;
    price: string;
    permalink: string;
  };
  assert.equal(product.name, productName);
  assert.ok(product.id && product.permalink);
  evidence.productId = product.id;
  console.log(`Live dashboard chat created product ${product.id}.`);
  const shopper = await browser.newContext();
  let orderId: number;
  try {
    const store = await shopper.newPage();
    await store.goto(product.permalink);
    await store
      .getByRole('heading', { name: productName, exact: true })
      .first()
      .waitFor();
    const storeOrigin = new URL(product.permalink).origin;
    await store.goto(`${storeOrigin}/?add-to-cart=${product.id}`);
    await store.goto(`${storeOrigin}/checkout/`);
    for (const [field, value] of Object.entries({
      first_name: 'Chat',
      last_name: 'Demo',
      address_1: '1 Demo Road',
      city: 'Bengaluru',
      postcode: '560001',
      phone: '9999999999',
      email: 'chat-demo@storelink.invalid',
    }))
      await store.locator(`#billing_${field}`).fill(value);
    await store.locator('#billing_country').selectOption('IN');
    await store.locator('#billing_state').selectOption('KA');
    if (await store.locator('#payment_method_cod').isVisible())
      await store.locator('#payment_method_cod').check();
    if (await store.locator('#terms').isVisible())
      await store.locator('#terms').check();
    await store.locator('#place_order').click();
    await store.waitForURL(/order-received\/\d+/, { timeout: 60000 });
    orderId = Number(/order-received\/(\d+)/.exec(store.url())?.[1]);
    assert.ok(orderId);
    evidence.orderId = orderId;
    await store.goto(`${storeOrigin}/wp-login.php`);
    await store.locator('#user_login').fill('admin');
    await store.locator('#user_pass').fill(secret('wordpress-admin-password'));
    await store.locator('#wp-submit').click();
    await store.waitForURL(/wp-admin/);
    await store.goto(
      `${storeOrigin}/wp-admin/admin.php?page=wc-orders&action=edit&id=${orderId}`,
    );
    assert.match(
      await store.locator('body').innerText(),
      new RegExp(`Order #${orderId}`),
    );
  } finally {
    await shopper.close();
  }
  console.log(
    `Chat-created product was ordered through COD; WooCommerce admin confirms order ${orderId!}.`,
  );
  const orders = await ask(
    page,
    `What orders came in today? Use the time server for the store timezone and query the store with those date bounds. Include order IDs and totals. Check whether order ${orderId!} is in the results.`,
  );
  assert.ok(calls(orders, 'time__get_day_window').length);
  assert.ok(calls(orders, 'woo__list_orders').length);
  // Stored activity keeps the first 4000 characters of a result, so a long
  // order list is cut off; newest orders come first, so look for the ID there.
  assert.ok(
    calls(orders, 'woo__list_orders').some((activity) =>
      activity.result.includes(`\\"id\\":${orderId!},`),
    ),
  );
  assert.match(orders.text, new RegExp(String(orderId!)));
  const saved = await api<{
    title: string;
    input_tokens: string;
    output_tokens: string;
    messages: unknown[];
  }>(admin, `/conversations/${created.id}`);
  assert.ok(Number(saved.input_tokens) > 0 && Number(saved.output_tokens) > 0);
  assert.ok(saved.messages.length > 4);
  await page.screenshot({
    path: '.cache/live-chat-dashboard.png',
    fullPage: true,
  });
  await page.reload();
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  await page.getByRole('button').filter({ hasText: saved.title }).click();
  await page.getByText(orders.text, { exact: true }).waitFor();
  console.log(
    'Dashboard order answer, persisted conversation and real token accounting passed.',
  );
  await login(
    member,
    'member@storelink.local',
    secret('dashboard-member-password'),
  );
  await api(member, `/conversations/${created.id}`, undefined, 'GET', 404);
  const issued = await api<{ id: string; key: string }>(
    member,
    '/keys',
    { label: 'Live model acceptance' },
    'POST',
    201,
  );
  keyId = issued.id;
  writeFileSync(keyFile, issued.key, { mode: 0o600 });
  external = new Client({ name: 'storelink-live-user-b', version: '0.1.0' });
  await external.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${issued.key}` } },
    }),
  );
  assert.equal((await external.listTools()).tools.length, 9);
  const combined = await externalPrompt(
    `Find today's order totals in the store timezone using the time server and WooCommerce tools, then read the operations sales target and compare actual sales against it. Include order ${orderId!} if present. Do not change anything.`,
  );
  for (const name of [
    'time__get_day_window',
    'woo__list_orders',
    'ops__get_fulfillment_policy',
  ])
    assert.ok(calls(combined, name).length, `External agent must call ${name}`);
  assert.match(combined.text, new RegExp(String(orderId!)));
  assert.ok(combined.inputTokens > 0 && combined.outputTokens > 0);
  const servers = await api<Server[]>(admin, '/servers');
  operations = servers.find((server) => server.id === 'ops')!;
  await api(
    admin,
    '/servers',
    {
      id: operations.id,
      slug: operations.slug,
      url: operations.url,
      enabled: false,
    },
    'POST',
    201,
  );
  assert.ok(
    !(await external.listTools()).tools.some((tool) =>
      tool.name.startsWith('ops__'),
    ),
  );
  assert.ok(
    !(await api<{ name: string }[]>(admin, '/tools')).some((tool) =>
      tool.name.startsWith('ops__'),
    ),
  );
  const disabled = await ask(
    page,
    'Read the operations fulfillment policy if its tool is currently available. If unavailable, say so; do not infer or invent the policy.',
  );
  assert.ok(
    disabled.activity
      .filter((activity) => activity.name.startsWith('ops__'))
      .every((activity) => activity.isError),
  );
  const healthy = await externalPrompt(
    `Use the time server and WooCommerce to list today's order IDs, including order ${orderId!} if present. Do not change anything.`,
  );
  assert.ok(
    calls(healthy, 'time__get_day_window').length &&
      calls(healthy, 'woo__list_orders').length,
  );
  assert.ok(
    !healthy.activity.some(
      (activity) => activity.name.startsWith('ops__') && !activity.isError,
    ),
  );
  await api(
    admin,
    '/servers',
    {
      id: operations.id,
      slug: operations.slug,
      url: operations.url,
      enabled: true,
    },
    'POST',
    201,
  );
  await api(member, `/keys/${issued.id}`, undefined, 'DELETE');
  await assert.rejects(() =>
    external!.callTool({ name: 'woo__list_orders', arguments: {} }),
  );
  await assert.rejects(() => external!.listTools());
  const audits = await api<
    {
      user_id: string;
      requested_name: string;
      outcome: string;
      key_id: string | null;
    }[]
  >(admin, '/audit');
  assert.ok(
    audits.some(
      (row) =>
        row.user_id === 'admin-a' &&
        row.requested_name === 'woo__create_product' &&
        row.outcome === 'success' &&
        !row.key_id,
    ),
  );
  for (const name of [
    'time__get_day_window',
    'woo__list_orders',
    'ops__get_fulfillment_policy',
  ])
    assert.ok(
      audits.some(
        (row) =>
          row.user_id === 'member-b' &&
          row.key_id === issued.id &&
          row.requested_name === name &&
          row.outcome === 'success',
      ),
    );
  assert.ok(
    audits.some(
      (row) =>
        row.user_id === 'member-b' &&
        row.key_id === issued.id &&
        row.outcome === 'denied',
    ),
  );
  assert.deepEqual(pageErrors, []);
  evidence.dashboard = {
    conversationId: created.id,
    createTools: created.activity.map((item) => item.name),
    ordersTools: orders.activity.map((item) => item.name),
    inputTokens:
      created.inputTokens + orders.inputTokens + disabled.inputTokens,
    outputTokens:
      created.outputTokens + orders.outputTokens + disabled.outputTokens,
  };
  evidence.external = {
    tools: combined.activity.map((item) => item.name),
    inputTokens: combined.inputTokens + healthy.inputTokens,
    outputTokens: combined.outputTokens + healthy.outputTokens,
  };
  evidence.controls = {
    disabledToolsAbsent: true,
    healthyCallsDuringDisable: true,
    keyRevocation: true,
    auditAttribution: true,
    conversationIsolation: true,
  };
  writeFileSync(
    '.data/live-chat-evidence.json',
    JSON.stringify(evidence, null, 2) + '\n',
    { mode: 0o600 },
  );
  writeFileSync(
    '.data/last-store-check.json',
    JSON.stringify(
      {
        productId: product.id,
        orderId: orderId!,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(
    'Live dashboard + external OpenAI acceptance passed; evidence is in .data/live-chat-evidence.json.',
  );
} finally {
  if (operations)
    await api(
      admin,
      '/servers',
      {
        id: operations.id,
        slug: operations.slug,
        url: operations.url,
        enabled: true,
      },
      'POST',
      201,
    ).catch(() => {});
  if (keyId)
    await api(member, `/keys/${keyId}`, undefined, 'DELETE').catch(() => {});
  try {
    unlinkSync(keyFile);
  } catch {}
  if (external) await closeClient(external);
  await browser.close();
}
