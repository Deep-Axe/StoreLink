import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// One host-wide lock across checkouts/worktrees. Do not put it inside a worktree.
export const clusterLockPath = join(
  tmpdir(),
  `storelink-${process.getuid?.() ?? 'user'}`,
  'urumi-cluster.lock',
);
export function runWithClusterLock(command: string, args: string[]): never {
  mkdirSync(join(clusterLockPath, '..'), { recursive: true, mode: 0o700 });
  const result = spawnSync(
    'flock',
    [
      '--exclusive',
      '--nonblock',
      '--conflict-exit-code',
      '73',
      clusterLockPath,
      command,
      ...args,
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, STORELINK_CLUSTER_LOCK: clusterLockPath },
    },
  );
  if (result.error)
    console.error('Cannot acquire cluster lock; install the flock utility.');
  if (result.status === 73)
    console.error(
      `Cluster busy: another agent owns ${clusterLockPath}. Wait for that task to finish; do not delete the lock file.`,
    );
  process.exit(result.status ?? 1);
}
export function acquireClusterLock(): void {
  if (process.env.STORELINK_CLUSTER_LOCK === clusterLockPath) return;
  runWithClusterLock(process.execPath, [
    ...process.execArgv,
    ...process.argv.slice(1),
  ]);
}
