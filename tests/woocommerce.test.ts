import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  oauthAuthorization,
  WooStoreClient,
} from '../services/woocommerce-mcp/src/store-client.ts';
import { wooHttpHandler } from '../services/woocommerce-mcp/src/server.ts';

test('OAuth signatures bind the canonical hostname, HTTP method, encoded filters and timestamp', () => {
  const url = new URL(
    'http://store.storelink.test/wp-json/wc/v3/orders?search=a%20b%26c&page=2',
  );
  const signed = oauthAuthorization(
    'GET',
    url,
    'ck_fixture',
    'cs_fixture',
    'fixed_nonce',
    '1700000000',
  );
  assert.match(signed, /oauth_signature_method="HMAC-SHA256"/);
  assert.equal(signed.includes('cs_fixture'), false);
  for (const variant of [
    oauthAuthorization(
      'POST',
      url,
      'ck_fixture',
      'cs_fixture',
      'fixed_nonce',
      '1700000000',
    ),
    oauthAuthorization(
      'GET',
      new URL(
        url
          .toString()
          .replace('store.storelink.test', 'wordpress.storelink.svc'),
      ),
      'ck_fixture',
      'cs_fixture',
      'fixed_nonce',
      '1700000000',
    ),
    oauthAuthorization(
      'GET',
      url,
      'ck_fixture',
      'cs_fixture',
      'fixed_nonce',
      '1700000001',
    ),
  ])
    assert.notEqual(variant, signed);
});

test('public HTTP and HTTPS settings both use direct HTTP/OAuth without leaking raw secrets', async () => {
  for (const scheme of ['http', 'https']) {
    const client = new WooStoreClient({
      publicUrl: `${scheme}://store.storelink.test`,
      connectService: 'wordpress.storelink.svc',
      consumerKey: 'ck_fixture',
      consumerSecret: 'cs_fixture',
      async send(input) {
        assert.equal(
          input.url.toString(),
          'http://store.storelink.test/wp-json/wc/v3/products',
        );
        assert.match(input.headers.authorization, /^OAuth /);
        assert.equal(input.url.toString().includes('cs_fixture'), false);
        return {
          status: 200,
          contentType: 'application/json; charset=UTF-8',
          body: '[]',
        };
      },
    });
    assert.deepEqual(await client.request('GET', 'products'), []);
  }
});

test('redirects and HTML/authentication errors are rejected without replaying a mutation or exposing the body', async () => {
  for (const response of [
    { status: 302, contentType: 'text/html', body: 'cs_secret_in_error' },
    {
      status: 401,
      contentType: 'application/json',
      body: '{"secret":"cs_secret_in_error"}',
    },
    { status: 200, contentType: 'text/html', body: 'cs_secret_in_error' },
  ]) {
    let calls = 0;
    const client = new WooStoreClient({
      publicUrl: 'http://store.test',
      connectService: 'wordpress',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      async send() {
        calls++;
        return response;
      },
    });
    await assert.rejects(
      client.request('POST', 'products', {}, { name: 'Demo' }),
      (error) => {
        assert.equal(String(error).includes('cs_secret_in_error'), false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test('Woo MCP rejects missing service credentials and cross-origin browser requests', async () => {
  const client = new WooStoreClient({
    publicUrl: 'http://store.test',
    connectService: 'wordpress',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    async send() {
      throw new Error('Should not execute');
    },
  });
  const handler = wooHttpHandler(client, 'upstream-secret', 'http://woo.test');
  assert.equal(
    (
      await handler(
        new Request('http://woo.test/mcp', { method: 'POST', body: '{}' }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handler(
        new Request('http://woo.test/mcp', {
          method: 'POST',
          body: '{}',
          headers: {
            origin: 'https://attacker.test',
            authorization: 'Bearer upstream-secret',
          },
        }),
      )
    ).status,
    403,
  );
});
