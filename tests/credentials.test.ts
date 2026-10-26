import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FileCredentials,
  KubernetesCredentials,
  SecretConflictError,
} from '../services/gateway/src/credentials.ts';

const credential = { header: 'authorization', value: 'Bearer upstream-token' };

// An in-memory Secret that applies JSON merge patches like the API server.
class FakeSecret extends KubernetesCredentials {
  data: Record<string, string> = {};
  resourceVersion = 1;
  conflicts = 0;
  async request(method: string, body?: unknown) {
    if (method === 'PATCH') {
      const patch = body as {
        metadata?: { resourceVersion: string };
        data: Record<string, string | null>;
      };
      if (patch.metadata && this.conflicts-- > 0) {
        this.resourceVersion++;
        throw new SecretConflictError('conflict');
      }
      for (const [id, value] of Object.entries(patch.data))
        if (value === null) delete this.data[id];
        else this.data[id] = value;
      this.resourceVersion++;
    }
    return {
      metadata: { resourceVersion: String(this.resourceVersion) },
      data: { ...this.data },
    };
  }
}

const raw = (secret: FakeSecret, id: string) =>
  Buffer.from(secret.data[id], 'base64').toString('utf8');

function setup(pepper = randomBytes(32)) {
  return new FakeSecret('storelink', 'upstream', pepper);
}

test('credentials round-trip and are stored as AES-GCM envelopes', async () => {
  const secret = setup();
  await secret.set('woo', credential);
  assert.deepEqual(await secret.get('woo'), credential);
  const stored = raw(secret, 'woo');
  assert.doesNotMatch(stored, /Bearer|upstream-token|authorization/);
  assert.equal(JSON.parse(stored).v, 1);
  // A fresh IV each time: the same credential never produces the same ciphertext.
  await secret.set('time', credential);
  assert.notEqual(
    JSON.parse(raw(secret, 'time')).data,
    JSON.parse(stored).data,
  );
  await secret.set('woo', null);
  assert.equal(await secret.get('woo'), undefined);
});

test('altered, moved or foreign-key envelopes fail closed', async () => {
  const pepper = randomBytes(32);
  const secret = setup(pepper);
  await secret.set('woo', credential);
  const envelope = JSON.parse(raw(secret, 'woo'));
  const write = (id: string, value: object) => {
    secret.data[id] = Buffer.from(JSON.stringify(value)).toString('base64');
  };
  for (const field of ['iv', 'tag', 'data'] as const) {
    const bytes = Buffer.from(envelope[field], 'base64');
    bytes[0] ^= 1;
    write('woo', { ...envelope, [field]: bytes.toString('base64') });
    await assert.rejects(secret.get('woo'));
  }
  // Moving woo's envelope into the time slot is rejected by the authenticated ID.
  write('woo', envelope);
  write('time', envelope);
  await assert.rejects(secret.get('time'));
  // A gateway with a different pepper cannot read it.
  const other = setup(randomBytes(32));
  other.data = secret.data;
  await assert.rejects(other.get('woo'));
  assert.deepEqual(await secret.get('woo'), credential);
});

test('plaintext entries from older releases are readable and sealed once', async () => {
  const secret = setup();
  secret.data.woo = Buffer.from(JSON.stringify(credential)).toString('base64');
  secret.data.time = Buffer.from(JSON.stringify(credential)).toString('base64');
  await secret.set('ops', credential);
  const ops = secret.data.ops;
  assert.deepEqual(await secret.get('woo'), credential);

  secret.conflicts = 1;
  assert.equal(await secret.sealLegacy(), 2);
  for (const id of ['woo', 'time', 'ops'])
    assert.doesNotMatch(raw(secret, id), /Bearer/);
  assert.equal(secret.data.ops, ops);
  assert.deepEqual(await secret.get('time'), credential);
  assert.equal(await secret.sealLegacy(), 0);
});

test('development file credentials are sealed too', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'credentials-')), 'c.json');
  const files = new FileCredentials(randomBytes(32), path);
  await files.set('woo', credential);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /Bearer/);
  assert.deepEqual(await files.get('woo'), credential);
});
