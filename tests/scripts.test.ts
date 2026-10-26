import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kubectlCommand } from '../scripts/lib/kubectl.ts';

test('kubectl uses an override, an executable local install, or PATH in that order', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'storelink-kubectl-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const local = join(directory, 'kubectl');
  assert.equal(kubectlCommand({}, local), 'kubectl');
  writeFileSync(local, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  assert.equal(kubectlCommand({}, local), 'kubectl');
  chmodSync(local, 0o755);
  assert.equal(kubectlCommand({}, local), local);
  assert.equal(
    kubectlCommand({ STORELINK_KUBECTL: '/custom/kubectl' }, local),
    '/custom/kubectl',
  );
});

test('shared cluster lock rejects an overlapping agent and releases after completion', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'storelink-lock-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: directory };
  const { spawn, spawnSync } = await import('node:child_process');
  const args = [
    'scripts/with-cluster-lock.ts',
    '--',
    process.execPath,
    '-e',
    'console.log("held");setTimeout(()=>{},1200)',
  ];
  const first = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const done = new Promise<number | null>((resolve) =>
    first.once('exit', resolve),
  );
  await new Promise<void>((resolve, reject) => {
    first.stdout.once('data', () => resolve());
    first.once('exit', (code) => {
      if (code) reject(new Error(`Lock owner failed: ${code}`));
    });
    first.once('error', reject);
  });
  const blocked = spawnSync(
    process.execPath,
    [
      'scripts/with-cluster-lock.ts',
      '--',
      process.execPath,
      '-e',
      'process.exit(0)',
    ],
    { encoding: 'utf8', env },
  );
  assert.equal(blocked.status, 73);
  assert.match(blocked.stderr, /Cluster busy/);
  assert.equal(await done, 0);
  const released = spawnSync(
    process.execPath,
    [
      'scripts/with-cluster-lock.ts',
      '--',
      process.execPath,
      '-e',
      'process.exit(0)',
    ],
    { encoding: 'utf8', env },
  );
  assert.equal(released.status, 0);
});
