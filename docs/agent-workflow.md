# Coordinating Contributors and Agents

## Isolate source changes

Use a dedicated branch and Git worktree for each concurrent task so parallel edits do not collide in the same checkout:

```sh
git worktree add ../storelink-chat -b fix/chat-errors main
git worktree add ../storelink-network -b fix/upstream-network main
```

Install dependencies in each worktree (`scripts/install-dependencies.sh`) and keep `.env`, `.data/` and credentials private.

## Serialize access to the local cluster

`scripts/local-up.sh` and every `scripts/smoke-*.ts` script acquire an exclusive host-wide `flock` lock at `/tmp/storelink-<uid>/storelink-cluster.lock`. If another process holds the lock, the script exits with code `73` (`Cluster busy`).

Wrap manual cluster mutations, cleanup runs, or external client checks in the same lock:

```sh
node scripts/with-cluster-lock.ts -- kubectl --kubeconfig .data/kubeconfig -n storelink get pods
node scripts/with-cluster-lock.ts -- claude -p --mcp-config .data/member-mcp.json --strict-mcp-config --allowedTools mcp__storelink "List today's orders."
```
