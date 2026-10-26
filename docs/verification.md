# Verification

## Automated test suite

`npm test` runs 67 deterministic unit and protocol tests across fifteen test files without making paid OpenAI calls:

- **`tests/gateway.test.ts`:** API key HMAC digest lookup, revoked-key attribution after restart, `<slug>__<alias>` tool collision routing (`time__get_status` vs `ops__get_status`), immediate route removal on disable, hung upstream timeout isolation, uncertain mutation auditing without retries, argument schema validation, cross-team route isolation, audit-failure fail-closed behavior, and full MCP SDK Streamable HTTP exchanges.
- **`tests/mcp-notifications.test.ts`:** Stateful Streamable HTTP + GET SSE sessions, team-scoped `notifications/tools/list_changed` delivery, suppression of unchanged catalog refreshes, cross-user/cross-key session rejection (`403`), revoked-key notification cutoff, per-user/global session limits (`429`), `DELETE` cleanup, and idle session expiry (`404`).
- **`tests/health.test.ts`:** 1-second upstream ping probes, per-upstream `Unreachable` transition, 2-second retry hold window before rediscovery, probe timeout bounds, and fresh MCP session reconnection after upstream restart.
- **`tests/upstream-policy.test.ts` & `tests/upstream-network.test.ts`:** Public HTTPS registration without a Helm allowlist change, rejection of loopback/private/link-local/metadata/mixed DNS answers, socket-level DNS rebinding prevention, and 2-second TCP connect timeouts that do not truncate long-running tool calls.
- **`tests/woocommerce.test.ts`:** OAuth 1.0a HMAC-SHA256 canonical host signing, direct HTTP transport for both HTTP and HTTPS public store URLs, redirect/HTML/auth error rejection without mutation retry, and service token / CORS enforcement.
- **`tests/chat.test.ts`, `tests/chat-admission.test.ts` & `tests/dashboard-api.test.ts`:** Scripted OpenAI Responses multi-round tool continuation, mid-turn catalog/authz rechecks, round/call/context bounds, DST-aware store day windows, categorized provider/timeout errors, atomic conversation persistence, and per-user/team/global admission limits that do not charge rejected requests against the hourly quota.
- **`tests/metrics.test.ts`:** Per-server outcome counts and latency aggregation from the audit log, team and time-window filters, histogram-based p95 interpolation, and Prometheus exposition (counters, cumulative histogram buckets, upstream gauges, label escaping).
- **`tests/credentials.test.ts`:** AES-256-GCM credential round trips with a fresh IV per write, fail-closed handling of altered IVs, tags and data, entries moved to another server's slot or read with another pepper, one-time sealing of plaintext entries guarded by the Secret's `resourceVersion`, removal of the plaintext copy kept by `kubectl apply`, and sealed development file credentials.
- **`tests/scaling.test.ts`:** Two gateway replicas behind one origin sharing a database and session store: a session started on one replica continuing on the other, `DELETE` ending it on both, session limits across replicas, rebuilding a session after a replica loses its local copy, registry changes applied before routing, catalog notifications for a stream whose handshake finished on the other replica, and the per-key request limit shared by both replicas with `rate_limited` auditing.
- **`tests/scripts.test.ts`:** `kubectl` binary resolution order and host-wide `flock` cluster lock contention (`exit 73`) and release.

## Cluster smoke checks

All cluster scripts run against the local k3d deployment (`storelink` namespace) and acquire the shared cluster lock:

- **`node scripts/smoke-cluster.ts`:** Connects to `/mcp` through Ingress, verifies all five `woo__*` tools, creates a product through `woo__create_product`, places a Cash on Delivery order in headless Chrome, confirms the order in WordPress admin (`WooCommerce → Orders`), queries today's orders using `time__get_day_window` + `woo__list_orders`, and updates the order status to `processing`.
- **`node scripts/smoke-dashboard.ts`:** Logs into the React dashboard as `admin@storelink.local` and `member@storelink.local`, verifies three `Connected` servers and nine tools, checks CSRF and cross-origin rejection (`403`), verifies member RBAC restrictions, issues and revokes a member API key, tests colliding `time__get_status` and `ops__get_status` calls, disables and re-enables a server, adds/edits/removes a temporary server with credential replacement, exercises single-use member invitations, and saves desktop/mobile screenshots.
- **`node scripts/smoke-catalog-notifications.ts`:** Opens an SDK client with `listChanged` auto-refresh enabled over Ingress SSE, disables and re-enables `ops`, verifies automatic client catalog updates without reconnecting, and confirms key revocation closes access.
- **`node scripts/smoke-pod-delete.ts`:** Force-deletes the `storelink-operations-mcp` pod with `replicas=1` and zero client traffic during the outage, verifies the gateway's 1-second health probe flips `ops` to `Unreachable` and records an `upstream_events` entry while `time` and `woo` calls succeed, and confirms automatic catalog and tool recovery once Kubernetes replaces the pod.
- **`node scripts/smoke-scaling.ts`:** Port-forwards to each of the two gateway pods and pins every request to one of them: initializes an MCP session on one pod and uses it for `tools/list` and `tools/call` on the other; disables a server through one pod and confirms the very next call on the other is refused and its open event stream receives `notifications/tools/list_changed`; confirms a session deleted on one pod returns `404` on the other; sends 121 requests with a temporary key split across both pods and confirms the last receives `429`; and confirms a second chat turn for the same user on the other pod is refused while the first runs.
- **`node scripts/smoke-failures.ts`:** Exercises held scale-to-zero outages, verifies `storelink-gateway` rollout restart retains sessions, disabled server state and audit rows, and verifies `storelink-wordpress` rollout restart retains product and order data on its PVC.
- **`node --env-file=.env scripts/smoke-chat.ts` & `node scripts/smoke-chat-regressions.ts`:** Runs chat and access checks with live OpenAI (`gpt-6-luna`). An administrator creates a product in dashboard chat, places a browser COD order, queries today's orders across `time` and `woo`, and reloads saved conversation history and token counts. A member connects with a separate API key, runs a prompt that uses `time`, `woo` and `ops`, and the check covers server disable, key revocation, conversation isolation (`404`) and attributed audit rows.

## Multi-store checks

- **`node scripts/smoke-multistore.ts`:** Creates stores through two users' dashboards, checks ownership, and admits exactly one concurrent request when one personal slot remains. Discovers ten additional tools, places a COD order in each store (₹149.00 and ₹249.00), and uses dashboard chat to compare today's totals through the time server and both stores' order tools. Deleting one store removes its tools while the other remains usable; final deletion removes both namespaces and all four PVs, returning the gateway to nine tools.
- **Recovery and isolation:** Forces a terminal bootstrap failure, retries through the UI with a new attempt, restarts the provisioner, and checks that credentials remain unchanged. Blocks cross-store WordPress/MariaDB connections while authorized calls work. Covers platform default-deny mode both off and on, restoring the original setting afterward.
- **Deterministic coverage:** `tests/stores.test.ts` and `tests/store-requests.test.ts` cover manifests, namespace safety, attempt-based retries, token crash recovery, TLS readiness, atomic admission, deletion-collision messages and state transitions.
- **Output:** the script writes `.data/multi-store-evidence.json` and screenshots under `.cache/`. It makes one paid, read-only model turn, removes the stores, products and orders it created, and leaves the chat and audit rows. It uses local HTTP. Public certificate issuance is covered in [Public TLS](../README.md#public-tls). Backup and restore steps are in [operations](multi-store.md).

## External MCP client verification

In addition to MCP Inspector (`npx @modelcontextprotocol/inspector`) and the SDK smoke scripts, the gateway was verified with **Claude Code** (`claude -p`) configured solely with `http://dashboard.storelink.localhost/mcp` and a member Bearer key:

```sh
node scripts/with-cluster-lock.ts -- claude -p --mcp-config .data/member-mcp.json --strict-mcp-config --allowedTools mcp__storelink \
  "What orders came in today in the store's timezone? Use the time server for the day window and WooCommerce for orders. Then read the operations sales target and compare. Do not change anything."
```

Claude Code discovered the tools of all three servers (`mcp__storelink__woo__*`, `time__*`, `ops__*`), chained `time__get_day_window`, `woo__list_orders` and `ops__get_fulfillment_policy` in a single prompt, and recorded attributed member rows in `audit_calls`.

## Where the main parts live

### Production deployment and TLS

The same chart runs on single-node k3s (`charts/storelink/values-prod.yaml`). cert-manager HTTP-01 through Traefik issues `storelink-tls` for the storefront and dashboard. A k3s run confirmed a Let's Encrypt chain, HTTPS responses on both hosts, and a `401` from `/mcp` with no API key. That host is no longer running. Additional stores request their own Certificate via `cert-manager.io/cluster-issuer` (`services/gateway/src/store-manifests.ts`). See [Public TLS](../README.md#public-tls), the [production guide](../README.md#production-deployment-k3s) and [production changes](system-design.md#production-changes).

### Network isolation and credentials

Ingress `NetworkPolicy` rules limit who can reach the MCP servers, databases and WordPress. `networkPolicies.defaultDeny` adds a default-deny ingress and egress mode with per-component allow rules (`charts/storelink/templates/network-policies.yaml`). With that mode on, probes confirmed blocked paths: MCP servers to PostgreSQL and the internet, Woo MCP to MariaDB, and the gateway to MariaDB and WordPress. Every workload runs non-root with capabilities dropped (PostgreSQL `70`, MariaDB `999`, WordPress `33` on port 8080, app containers `1000`), checked on an upgraded install and a fresh install. Upstream credentials use AES-256-GCM bound to their ID (`packages/shared/src/credential-cipher.ts`, `services/gateway/src/credentials.ts`, `tests/credentials.test.ts`). The gateway's Kubernetes role can read and patch only `storelink-upstream-credentials` (`charts/storelink/templates/registry-rbac.yaml`). Public upstream registration checks for SSRF and DNS rebinding at the socket (`services/gateway/src/upstream-policy.ts`, `tests/upstream-policy.test.ts`). Secret encryption at rest is a k3s host setting.

### Multiple gateway replicas

`gateway.replicas` runs two gateway pods. They share MCP sessions, and a replica that has not seen a session rebuilds it from the stored handshake (`services/gateway/src/mcp-sessions.ts`, `services/gateway/src/mcp.ts`). Each request checks server revisions, and `LISTEN`/`NOTIFY` spreads configuration changes (`services/gateway/src/registry.ts`). Rate limits, including the per-key `/mcp` limit and chat concurrency leases, live in PostgreSQL (`services/gateway/src/rate-limits.ts`). A stopping replica keeps serving while traffic moves away. Tests: `tests/scaling.test.ts`. Cluster check: `scripts/smoke-scaling.ts`.

### Metrics

Each gateway replica serves Prometheus metrics on port `9464` at `/metrics`: per-server call counters by outcome, a latency histogram, and upstream up/status/last-failure gauges (`services/gateway/src/metrics.ts`, `services/gateway/src/main.ts`). Connection cards and `GET /api/metrics` show 24-hour calls, error rate and average and p95 latency. Health probes run every second and keep `lastError` plus `upstream_events`. Each audit row stores outcome, reason and duration. Tests: `tests/metrics.test.ts`.

### Upgrades and rollback

Each Helm revision runs its own store bootstrap Job (`charts/storelink/templates/store.yaml`). SQL migrations only add tables and columns (`services/gateway/migrations/`). Upgrade and rollback were run on the local cluster, and the backups were restored into scratch databases. Commands are in the [README](../README.md#upgrades-and-rollback) and [system design](system-design.md#upgrades-and-rollback).

### Stores

The dashboard Stores view is `apps/dashboard/src/stores.tsx`. Request handling, the provisioner and the generated manifests live under `services/gateway/src/`. The controller Deployment is `charts/storelink/templates/provisioner.yaml`. Schema changes are migrations 0008 and 0009. Tests: `tests/stores.test.ts`, `tests/store-requests.test.ts`. Cluster check: `scripts/smoke-multistore.ts`. Guide: [multi-store](multi-store.md).

### Catalog updates, chat history and invitations

- Connected MCP clients receive `notifications/tools/list_changed` when their team's upstream catalog changes (`services/gateway/src/mcp.ts`).
- Chat history and input/output token totals are saved per user (`services/gateway/src/chat.ts`, `migrations/0002_dashboard.sql`).
- Member invitations are single-use and expire after 24 hours (`services/gateway/src/dashboard-api.ts`).
- Order tools omit customer contact details. A store write that is interrupted is recorded as `uncertain` and is not retried (`services/woocommerce-mcp/src/server.ts`).
