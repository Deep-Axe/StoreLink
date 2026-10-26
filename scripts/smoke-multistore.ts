// Live bonus acceptance: creates/removes isolated stores and makes one paid chat turn.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { acquireClusterLock } from './lib/cluster-lock.ts';
import { kubectlCommand } from './lib/kubectl.ts';
import { closeClient } from './lib/mcp-client.ts';

type Store = {
  id: string;
  slug: string;
  displayName: string;
  publicUrl: string;
  status: string;
  failureReason: string | null;
  upstreamSlug: string;
  attempt: number;
};
acquireClusterLock();
const started = new Date().toISOString();
console.log(`Multi-store acceptance started at ${started}`);
const execute = promisify(execFile);
const kube = async (...args: string[]) =>
  (
    await execute(kubectlCommand(), args, {
      env: { ...process.env, KUBECONFIG: `${process.cwd()}/.data/kubeconfig` },
      timeout: 150000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout;
const material = JSON.parse(readFileSync('.data/cluster-secrets.json', 'utf8'));
const secret = (name: string) =>
  Buffer.from(material[name], 'base64').toString('utf8');
const origin = 'http://dashboard.storelink.localhost';
const nonce = Date.now().toString(36).slice(-8);
const north = `n${nonce}`,
  south = `s${nonce}`;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const admin = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  member = await browser.newContext();
const client = new Client({
  name: 'storelink-multi-store-check',
  version: '1',
});
const owned = new Set<string>();
let paused = false;
const evidence: Record<string, unknown> = { started };
async function until(check: () => Promise<boolean>, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for multi-store acceptance state');
}
async function login(context: BrowserContext, role: 'admin' | 'member') {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(origin);
  await page.getByLabel('Email address').fill(`${role}@storelink.local`);
  await page
    .getByLabel('Password', { exact: true })
    .fill(secret(`dashboard-${role}-password`));
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  await page.getByRole('button', { name: 'Stores', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Your stores', exact: true })
    .waitFor();
  return page;
}
async function api(
  context: BrowserContext,
  path: string,
  body?: unknown,
  method = body ? 'POST' : 'GET',
  expected = 200,
): Promise<any> {
  const me = await (await context.request.get(origin + '/api/me')).json();
  const response = await context.request.fetch(origin + '/api' + path, {
    method,
    data: body,
    headers: { origin, 'x-csrf-token': me.csrf },
    timeout: 150000,
  });
  assert.equal(
    response.status(),
    expected,
    `${method} ${path}: ${response.status()}`,
  );
  return response.json();
}
async function create(
  page: Page,
  context: BrowserContext,
  slug: string,
  label: string,
) {
  await page
    .getByRole('button', { name: '+ Create store', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Create store',
    exact: true,
  });
  await dialog.getByLabel('Store name', { exact: true }).fill(label);
  await dialog.getByLabel('Store address', { exact: true }).fill(slug);
  const response = page.waitForResponse(
    (r) =>
      r.url() === origin + '/api/stores' && r.request().method() === 'POST',
  );
  await dialog
    .getByRole('button', { name: 'Create store', exact: true })
    .click();
  const result = await response;
  assert.equal(result.status(), 201);
  const { id } = await result.json();
  owned.add(id);
  await dialog.waitFor({ state: 'hidden' });
  return ((await api(context, '/stores')) as Store[]).find((s) => s.id === id)!;
}
async function remove(page: Page, store: Store) {
  await page.getByRole('button', { name: 'Stores', exact: true }).click();
  await page
    .getByRole('button', { name: `Delete ${store.displayName}`, exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Delete store',
    exact: true,
  });
  await dialog
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await dialog.waitFor({ state: 'hidden' });
}
function data(result: unknown) {
  const parsed = CallToolResultSchema.parse(result);
  assert.ok(!parsed.isError);
  const item = parsed.content.find((c) => c.type === 'text');
  assert.ok(item?.type === 'text');
  return JSON.parse(item.text);
}
async function order(store: Store, name: string, price: string) {
  const product = data(
    await client.callTool({
      name: `${store.upstreamSlug}__create_product`,
      arguments: { name, price },
    }),
  );
  const shopper = await browser.newContext();
  try {
    const page = await shopper.newPage();
    await page.goto(product.permalink);
    await page.goto(store.publicUrl + `/?add-to-cart=${product.id}`);
    await page.goto(store.publicUrl + '/checkout/');
    for (const [field, value] of Object.entries({
      first_name: 'Store',
      last_name: 'Demo',
      address_1: '1 Demo Road',
      city: 'Bengaluru',
      postcode: '560001',
      phone: '9999999999',
      email: 'multi-store@storelink.invalid',
    }))
      await page.locator('#billing_' + field).fill(value);
    await page.locator('#billing_country').selectOption('IN');
    await page.locator('#billing_state').selectOption('KA');
    if (await page.locator('#payment_method_cod').isVisible())
      await page.locator('#payment_method_cod').check();
    if (await page.locator('#terms').isVisible())
      await page.locator('#terms').check();
    await page.locator('#place_order').click();
    await page.waitForURL(/order-received\/\d+/, { timeout: 60000 });
    return Number(/order-received\/(\d+)/.exec(page.url())![1]);
  } finally {
    await shopper.close();
  }
}
try {
  const adminPage = await login(admin, 'admin'),
    memberPage = await login(member, 'member');
  assert.equal(
    (await api(admin, '/stores')).length,
    0,
    'Start with no additional stores; existing user stores are never removed by this check',
  );
  // Test the real database cap before allocating any store workloads.
  await kube(
    '-n',
    'storelink',
    'scale',
    'deployment/storelink-provisioner',
    '--replicas=0',
  );
  paused = true;
  await kube(
    '-n',
    'storelink',
    'rollout',
    'status',
    'deployment/storelink-provisioner',
    '--timeout=60s',
  );
  const scratch = await api(
    member,
    '/stores',
    { slug: `q${nonce}`, displayName: 'Quota baseline' },
    'POST',
    201,
  );
  owned.add(scratch.id);
  const me = await (await member.request.get(origin + '/api/me')).json();
  const requests = await Promise.all(
    ['r', 't'].map((prefix) =>
      member.request.post(origin + '/api/stores', {
        headers: { origin, 'x-csrf-token': me.csrf },
        data: { slug: prefix + nonce, displayName: 'Quota contender' },
      }),
    ),
  );
  assert.deepEqual(requests.map((r) => r.status()).sort(), [201, 409]);
  for (const response of requests)
    if (response.status() === 201) owned.add((await response.json()).id);
  for (const id of owned)
    await api(member, '/stores/' + id, undefined, 'DELETE');
  await kube(
    '-n',
    'storelink',
    'scale',
    'deployment/storelink-provisioner',
    '--replicas=1',
  );
  paused = false;
  await kube(
    '-n',
    'storelink',
    'rollout',
    'status',
    'deployment/storelink-provisioner',
    '--timeout=90s',
  );
  await until(async () => (await api(admin, '/stores')).length === 0);
  owned.clear();
  console.log(
    'Real concurrent admission: one slot, one accepted create, one 409.',
  );
  const [a, b] = await Promise.all([
    create(adminPage, admin, north, 'North acceptance'),
    create(memberPage, member, south, 'South acceptance'),
  ]);
  assert.equal((await api(member, '/stores')).length, 1);
  await api(member, '/stores/' + a.id, undefined, 'DELETE', 404);
  await api(member, '/stores/' + a.id + '/retry', {}, 'POST', 409);
  const namespaceA = `storelink-store-${a.slug}`,
    namespaceB = `storelink-store-${b.slug}`;
  // Force a terminal setup failure, then exercise the dashboard's retry action.
  let failedJob = '';
  await until(async () => {
    const jobs = JSON.parse(
      await kube('-n', namespaceA, 'get', 'jobs', '-o', 'json'),
    ).items;
    failedJob = jobs[0]?.metadata.name ?? '';
    return Boolean(failedJob);
  });
  await kube(
    '-n',
    namespaceA,
    'patch',
    'job',
    failedJob,
    '--type=merge',
    '-p',
    '{"spec":{"activeDeadlineSeconds":1}}',
  );
  await until(
    async () =>
      ((await api(admin, '/stores')) as Store[]).find((s) => s.id === a.id)
        ?.status === 'Failed',
  );
  const before = JSON.parse(
    await kube(
      '-n',
      namespaceA,
      'get',
      'secret',
      'store-credentials',
      '-o',
      'json',
    ),
  ).data;
  const retryResponse = adminPage.waitForResponse((r) =>
    r.url().endsWith(`/stores/${a.id}/retry`),
  );
  await adminPage
    .getByRole('article', { name: a.displayName, exact: true })
    .getByRole('button', { name: 'Retry setup' })
    .click();
  assert.equal((await retryResponse).status(), 200);
  await kube(
    '-n',
    'storelink',
    'rollout',
    'restart',
    'deployment/storelink-provisioner',
  );
  await kube(
    '-n',
    'storelink',
    'rollout',
    'status',
    'deployment/storelink-provisioner',
    '--timeout=90s',
  );
  await until(async () => {
    const stores = (await api(admin, '/stores')) as Store[];
    if (stores.some((s) => s.status === 'Failed'))
      throw new Error(
        'Provisioning failed: ' +
          stores.find((s) => s.status === 'Failed')!.failureReason,
      );
    return stores.length === 2 && stores.every((s) => s.status === 'Ready');
  }, 300000);
  const after = JSON.parse(
    await kube(
      '-n',
      namespaceA,
      'get',
      'secret',
      'store-credentials',
      '-o',
      'json',
    ),
  ).data;
  assert.deepEqual(before, after);
  const ready = ((await api(admin, '/stores')) as Store[]).find(
    (s) => s.id === a.id,
  )!;
  assert.equal(ready.attempt, 2);
  const jobs = JSON.parse(
    await kube('-n', namespaceA, 'get', 'jobs', '-o', 'json'),
  ).items;
  assert.ok(
    jobs.some((j: any) => j.metadata.name !== failedJob && j.status.succeeded),
  );
  for (const store of [a, b])
    await adminPage
      .getByRole('article', { name: store.displayName, exact: true })
      .getByRole('status')
      .filter({ hasText: 'Ready' })
      .waitFor();
  await adminPage.screenshot({
    path: '.cache/multi-store-ready.png',
    fullPage: true,
  });
  console.log(
    'Two stores Ready after a failed Job, UI retry and provisioner restart; store credentials unchanged.',
  );
  const key = JSON.parse(secret('gateway-keys'))['member-b'];
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  await until(
    async () =>
      (await client.listTools()).tools.filter(
        (t) =>
          t.name.startsWith(a.upstreamSlug + '__') ||
          t.name.startsWith(b.upstreamSlug + '__'),
      ).length === 10,
  );
  // Each destination is healthy through the authorized gateway, then blocked cross-store.
  for (const store of [a, b])
    assert.ok(
      data(
        await client.callTool({
          name: store.upstreamSlug + '__list_products',
          arguments: {},
        }),
      ).length > 0,
    );
  for (const [destination, port] of [
    ['wordpress', 80],
    ['mariadb', 3306],
  ] as const) {
    await kube(
      '-n',
      namespaceA,
      'exec',
      'deployment/woo-mcp',
      '--',
      'node',
      '--input-type=module',
      '-e',
      `import net from 'node:net';const socket=net.createConnection({host:${JSON.stringify(destination + '.' + namespaceB + '.svc.cluster.local')},port:${port}});socket.setTimeout(1500);socket.on('connect',()=>process.exit(1));socket.on('timeout',()=>{socket.destroy();console.log('cross-store blocked');});socket.on('error',()=>{console.log('cross-store blocked');});`,
    );
  }
  const volumes: string[] = [];
  for (const namespace of [namespaceA, namespaceB]) {
    const claims = JSON.parse(
      await kube('-n', namespace, 'get', 'pvc', '-o', 'json'),
    ).items;
    assert.equal(claims.length, 2);
    volumes.push(...claims.map((p: any) => p.spec.volumeName));
  }
  const orderA = await order(a, 'North acceptance mug', '149.00'),
    orderB = await order(b, 'South acceptance mug', '249.00');
  await adminPage.getByRole('button', { name: 'Chat', exact: true }).click();
  const chatResponse = adminPage.waitForResponse(
    (r) => r.url() === origin + '/api/chat' && r.request().method() === 'POST',
    { timeout: 150000 },
  );
  await adminPage
    .getByLabel('Message', { exact: true })
    .fill(
      `Compare today's orders in exactly these two stores: ${a.upstreamSlug} and ${b.upstreamSlug}. First use time__get_day_window, then call ${a.upstreamSlug}__list_orders and ${b.upstreamSlug}__list_orders with its UTC date filters. Report each store's order count, total and currency. Do not change anything.`,
    );
  await adminPage
    .getByRole('button', { name: 'Send message', exact: true })
    .click();
  const response = await chatResponse;
  assert.equal(response.status(), 200);
  const answer = await response.json();
  for (const name of [
    'time__get_day_window',
    a.upstreamSlug + '__list_orders',
    b.upstreamSlug + '__list_orders',
  ])
    assert.ok(
      answer.activity.some((call: any) => call.name === name && !call.isError),
      `Model did not call ${name}`,
    );
  assert.match(answer.text, /149/);
  assert.match(answer.text, /249/);
  await adminPage.screenshot({
    path: '.cache/multi-store-chat.png',
    fullPage: true,
  });
  evidence.stores = [
    { slug: a.slug, orderId: orderA, total: '149.00' },
    { slug: b.slug, orderId: orderB, total: '249.00' },
  ];
  evidence.conversationId = answer.id;
  evidence.tokens = { input: answer.inputTokens, output: answer.outputTokens };
  evidence.retryAndRestart = true;
  evidence.isolation = true;
  evidence.atomicAdmission = true;
  await remove(adminPage, a);
  await until(
    async () =>
      !((await api(admin, '/stores')) as Store[]).some((s) => s.id === a.id),
  );
  owned.delete(a.id);
  await until(
    async () =>
      !(await client.listTools()).tools.some((t) =>
        t.name.startsWith(a.upstreamSlug + '__'),
      ),
  );
  assert.equal(
    (
      await client.callTool({
        name: a.upstreamSlug + '__list_products',
        arguments: {},
      })
    ).isError,
    true,
  );
  assert.ok(
    data(
      await client.callTool({
        name: b.upstreamSlug + '__list_products',
        arguments: {},
      }),
    ).length > 0,
  );
  await remove(memberPage, b);
  await until(async () => (await api(admin, '/stores')).length === 0);
  owned.delete(b.id);
  for (const namespace of [namespaceA, namespaceB])
    assert.equal(
      (
        await kube(
          'get',
          'namespace',
          namespace,
          '--ignore-not-found',
          '-o',
          'name',
        )
      ).trim(),
      '',
    );
  for (const volume of volumes)
    await until(
      async () =>
        (
          await kube('get', 'pv', volume, '--ignore-not-found', '-o', 'name')
        ).trim() === '',
      90000,
    );
  await until(async () => (await client.listTools()).tools.length === 9);
  evidence.teardown = true;
  evidence.finished = new Date().toISOString();
  writeFileSync(
    '.data/multi-store-evidence.json',
    JSON.stringify(evidence, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify(evidence));
} finally {
  if (paused)
    await kube(
      '-n',
      'storelink',
      'scale',
      'deployment/storelink-provisioner',
      '--replicas=1',
    ).catch(() => {});
  for (const id of owned)
    await api(admin, '/stores/' + id, undefined, 'DELETE').catch(() => {});
  if (owned.size)
    await until(
      async () =>
        !((await api(admin, '/stores')) as Store[]).some((s) =>
          owned.has(s.id),
        ),
      120000,
    ).catch(() => {});
  await closeClient(client).catch(() => {});
  for (const context of [admin, member])
    await api(context, '/logout', {}, 'POST').catch(() => {});
  await browser.close();
}
