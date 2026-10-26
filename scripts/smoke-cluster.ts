import { acquireClusterLock } from './lib/cluster-lock.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium } from '@playwright/test';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

acquireClusterLock();

const material = JSON.parse(
  readFileSync('.data/cluster-secrets.json', 'utf8'),
) as Record<string, string>;
const keys = JSON.parse(
  Buffer.from(material['gateway-keys'], 'base64').toString('utf8'),
) as Record<string, string>;
const origin =
  process.env.STORELINK_GATEWAY_URL ??
  'http://dashboard.storelink.localhost/mcp';
const client = new Client({
  name: 'storelink-real-store-check',
  version: '0.1.0',
});
function data(value: unknown): unknown {
  const result = CallToolResultSchema.parse(value);
  const text = result.content.find((content) => content.type === 'text');
  if (result.isError || !text || text.type !== 'text')
    throw new Error(text?.type === 'text' ? text.text : 'Tool failed');
  return JSON.parse(text.text);
}
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin), {
      requestInit: { headers: { authorization: `Bearer ${keys['admin-a']}` } },
    }),
  );
  const catalog = await client.listTools();
  for (const tool of [
    'list_products',
    'create_product',
    'list_orders',
    'get_order',
    'update_order_status',
  ]) {
    assert.ok(catalog.tools.some((entry) => entry.name === `woo__${tool}`));
  }
  const name = `StoreLink live check ${Date.now()}`;
  const product = data(
    await client.callTool({
      name: 'woo__create_product',
      arguments: { name, price: '149.00' },
    }),
  ) as { id: number; permalink: string; name: string };
  assert.equal(product.name, name);
  const products = data(
    await client.callTool({
      name: 'woo__list_products',
      arguments: { search: name },
    }),
  ) as { id: number }[];
  assert.ok(products.some((entry) => entry.id === product.id));
  console.log(
    `Real gateway → Woo MCP → REST: created and found product ${product.id}.`,
  );
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  let orderId: number;
  try {
    const page = await browser.newPage();
    await page.goto(product.permalink);
    await page.getByRole('heading', { name, exact: true }).first().waitFor();
    const storeOrigin = new URL(product.permalink).origin;
    await page.goto(`${storeOrigin}/?add-to-cart=${product.id}`);
    await page.goto(`${storeOrigin}/checkout/`);
    for (const [field, value] of Object.entries({
      first_name: 'Demo',
      last_name: 'Buyer',
      address_1: '1 Demo Road',
      city: 'Bengaluru',
      postcode: '560001',
      phone: '9999999999',
      email: 'demo-buyer@storelink.test',
    })) {
      await page.locator(`#billing_${field}`).fill(value);
    }
    await page.locator('#billing_country').selectOption('IN');
    await page.locator('#billing_state').selectOption('KA');
    const payment = page.locator('#payment_method_cod');
    if (await payment.isVisible()) await payment.check();
    if (await page.locator('#terms').isVisible())
      await page.locator('#terms').check();
    await page.locator('#place_order').click();
    try {
      await page.waitForURL(/order-received\/\d+/, { timeout: 60000 });
    } catch (error) {
      await page.screenshot({
        path: '.cache/checkout-failure.png',
        fullPage: true,
      });
      console.error(
        (await page.locator('.woocommerce-error').allTextContents()).join('\n'),
      );
      throw error;
    }
    orderId = Number(/order-received\/(\d+)/.exec(page.url())?.[1]);
    assert.ok(orderId);
    console.log(
      `Storefront cash-on-delivery checkout created order ${orderId}.`,
    );
    await page.goto(`${storeOrigin}/wp-login.php`);
    await page.locator('#user_login').fill('admin');
    await page
      .locator('#user_pass')
      .fill(
        Buffer.from(material['wordpress-admin-password'], 'base64').toString(
          'utf8',
        ),
      );
    await page.locator('#wp-submit').click();
    await page.waitForURL(/wp-admin/);
    await page.goto(
      `${storeOrigin}/wp-admin/admin.php?page=wc-orders&action=edit&id=${orderId}`,
    );
    assert.match(
      await page.locator('body').innerText(),
      new RegExp(`Order #${orderId}`),
    );
    console.log(`WooCommerce admin shows order ${orderId}.`);
  } finally {
    await browser.close();
  }
  const order = data(
    await client.callTool({
      name: 'woo__get_order',
      arguments: { order_id: orderId! },
    }),
  ) as { id: number; status: string };
  assert.equal(order.id, orderId!);
  const orders = data(
    await client.callTool({ name: 'woo__list_orders', arguments: {} }),
  ) as { id: number }[];
  assert.ok(orders.some((entry) => entry.id === orderId!));
  const window = data(
    await client.callTool({ name: 'time__get_day_window', arguments: {} }),
  ) as { after: string; before: string };
  const today = data(
    await client.callTool({
      name: 'woo__list_orders',
      arguments: { after: window.after, before: window.before },
    }),
  ) as { id: number }[];
  assert.ok(
    today.some((row) => row.id === orderId!),
    'Today’s UTC query must include the new storefront order',
  );
  console.log(
    'Time server → WooCommerce UTC date filtering returned the new order.',
  );
  const updated = data(
    await client.callTool({
      name: 'woo__update_order_status',
      arguments: { order_id: orderId!, status: 'processing' },
    }),
  ) as { status: string };
  assert.equal(updated.status, 'processing');
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
    'All five real WooCommerce tools and storefront checkout passed.',
  );
} finally {
  await client.close();
}
