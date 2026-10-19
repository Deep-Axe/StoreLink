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
    kubectlCommand({ URUMI_KUBECTL: '/custom/kubectl' }, local),
    '/custom/kubectl',
  );
});
