import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UpstreamPolicy,
  RegistryInputError,
  publicAddress,
} from '../services/gateway/src/upstream-policy.ts';
import { upstreamClient } from '../services/gateway/src/upstream.ts';

test('admins can register public HTTPS without a Helm allowlist entry', async () => {
  const policy = new UpstreamPolicy(['http://woo-mcp:3001'], async () => [
    { address: '8.8.8.8', family: 4 },
  ]);
  assert.equal(
    (await policy.check('https://new-public.example/mcp')).hostname,
    'new-public.example',
  );
  assert.equal(policy.validate('http://woo-mcp:3001/mcp').protocol, 'http:');
  for (const url of [
    'http://public.example/mcp',
    'https://127.0.0.1/mcp',
    'https://0x7f000001/mcp',
    'https://[::1]/mcp',
    'https://[::ffff:127.0.0.1]/mcp',
    'https://169.254.169.254/mcp',
    'https://user:secret@public.example/mcp',
    'https://public.example/mcp?key=secret',
    'file:///etc/passwd',
  ])
    assert.throws(() => policy.validate(url), RegistryInputError, url);
  assert.throws(() => policy.validate('http://public.example/mcp'), /HTTPS/);
  assert.throws(
    () => policy.validate('https://user:secret@public.example/mcp'),
    /credential field/,
  );
});
test('private, mixed and reserved DNS answers fail closed', async () => {
  for (const address of [
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '64:ff9b::a00:1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(publicAddress(address), false, address);
    const policy = new UpstreamPolicy([], async () => [
      { address: '8.8.8.8', family: 4 },
      { address, family: address.includes(':') ? 6 : 4 },
    ]);
    await assert.rejects(
      () => policy.check('https://private.example/mcp'),
      RegistryInputError,
    );
  }
});
test('DNS rebinding is rejected at the actual socket before sending a credential', async (t) => {
  let resolves = 0;
  const policy = new UpstreamPolicy([], async () => [
    { address: ++resolves === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 },
  ]);
  const url = await policy.check('https://rebind.example/mcp');
  const client = upstreamClient(
    url,
    'must-never-be-sent',
    undefined,
    policy.connectionOptions(url.toString()),
  );
  t.after(() => client.close());
  await assert.rejects(() => client.listTools(), /initialization failed/);
  assert.ok(resolves >= 2, 'must revalidate DNS when the connection opens');
});
