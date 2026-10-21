# Coordinating Contributors and Agents

## Isolate source changes

Give each agent its own branch and Git worktree. Never let concurrent agents switch branches or edit the same checkout.

```sh
git worktree add ../storelink-chat -b fix/chat-errors main
git worktree add ../storelink-network -b fix/upstream-network main
```

Install dependencies in each worktree. Agree on file ownership, report the branch/commit and checks performed, and integrate only completed commits. Keep credentials, kubeconfig and planning notes private; do not commit or copy them into review artifacts.

## Serialize the shared local cluster

`local-up.sh` and every `smoke-*.ts` script automatically acquire a host-wide `flock` lock under `/tmp/storelink-<uid>/`. The lock is shared across worktrees, so a test that restarts pods cannot overlap another browser/model test. A contender exits with code 73 and a clear busy message. The operating system releases the lock after the command exits; never delete an occupied lock file or set `STORELINK_CLUSTER_LOCK` yourself.

Wrap manual mutation, cleanup, deploy and third-party client demonstrations in the same lock:

```sh
node scripts/with-cluster-lock.ts -- kubectl --kubeconfig .data/kubeconfig -n urumi get pods
node scripts/with-cluster-lock.ts -- claude -p --mcp-config .data/member-mcp.json --strict-mcp-config --allowedTools mcp__urumi "List today's orders."
```

Keep a lock for the entire test, including its cleanup. Run different tests sequentially, record UTC start/end times and the tested Git revision, and restore server/replica settings in `finally`. A historical log is not proof for a modified script.

The lock coordinates agents on this host; remote runners need a shared CI concurrency group or Kubernetes Lease, or separate clusters/namespaces with their own credentials, storage, URLs and values. Git worktrees alone do not isolate Kubernetes workloads. Worktree copies must resolve credentials and kubeconfig for the intended environment before running setup.
