# Threat Model

## Assets and trust boundaries

- **Protected assets:** WooCommerce REST credentials, upstream MCP credentials, user gateway API keys, browser session cookies, the OpenAI API key, store product/order data, and audit records.
- **Trust boundaries:** Browser and external MCP traffic enters through Traefik Ingress. Only the gateway pod talks to upstream MCP servers, and only the WooCommerce MCP pod talks to the WordPress REST API using the store integration credentials. The LLM and all upstream tool descriptions and tool outputs are treated as untrusted input.

## Shared upstream credentials

Team members never see the WooCommerce consumer key/secret or upstream bearer tokens; `GET /api/servers` returns `hasCredential` booleans to admins and omits URLs and credential metadata for members.

Hiding credentials does not restrict what an enabled tool can do. Because the gateway authenticates to WooCommerce with a shared `shop_manager` key, any member who can call `woo__create_product` or `woo__update_order_status` can create published products or change order statuses on the shared store. To limit unnecessary exposure:

- The WooCommerce MCP server exposes only the five required product and order tools (no user, plugin, settings or webhook endpoints).
- Order responses strip customer billing/shipping addresses, email addresses and phone numbers (`services/woocommerce-mcp/src/server.ts`).
- Every tool invocation is logged in `audit_calls` with the calling gateway user and API key before the upstream request is sent.

## Why client tokens are terminated at the gateway

External clients authenticate to `/mcp` with a per-user gateway API key (`storelink_...`), and browser users authenticate to `/api/*` with a session cookie. The gateway terminates those credentials and attaches only the target upstream's configured static header when forwarding a tool call:

- Forwarding a user's gateway key to an upstream would let a compromised or third-party upstream impersonate that user against the gateway and call every other registered server on their behalf.
- Upstream servers have independent authentication schemes and no access to the gateway's user database or key pepper.
- Terminating keys at the gateway allows immediate per-request revocation (`gateway.authenticate` and `store.isActive`) across all upstreams, including inside already-open Streamable HTTP sessions, while still attributing post-revocation denials to the revoked key's owner.

## Untrusted upstreams and prompt injection

A registered upstream server can return tool descriptions or tool results crafted to manipulate the model (for example, instructing it to call `woo__create_product`, change an order status, or exfiltrate data from another tool's output into a subsequent call's arguments).

Mitigations in place:

- **System instructions:** `services/gateway/src/chat.ts` instructs the model to treat tool descriptions and tool outputs as untrusted data, never invent results, and only run store mutations when explicitly asked by the user.
- **Constrained capability surface:** The model has no shell, filesystem or arbitrary HTTP fetch tool; it can only invoke registered MCP tools with arguments that pass Ajv JSON Schema validation.
- **Metadata and output bounds:** Tool descriptions are capped at 4 KiB, input schemas at 64 KiB, gateway tool responses at 256 KiB (32 KiB inside chat context), and chat turns are capped at 8 model rounds and 20 tool calls.
- **Admin-only registration and SSRF protection:** Only admins can add or edit upstreams. Public upstreams must use HTTPS and resolve exclusively to public unicast IPs at both registration time and socket connection time (`services/gateway/src/upstream-policy.ts`), blocking loopback, link-local/cloud metadata (`169.254.169.254`), cluster-internal Services, and DNS rebinding. Redirects and URL-embedded credentials are rejected.

Prompt injection remains an inherent risk whenever an LLM processes untrusted tool output alongside write-capable tools: a malicious upstream could still steer the model into calling another enabled tool during the same turn. Administrators should only register upstreams they trust with the team's enabled tool catalog.

## What one team member can do to another

Within a team, members share the store and upstream tool catalog:

- **Shared capabilities:** Any member can create products, update order statuses, and consume team OpenAI quota (bounded by `chat.limits.perUserHour`, `perUserConcurrent`, `perTeamConcurrent`, and `globalConcurrent`).
- **Enforced isolation:** Members cannot add, edit, disable or delete upstream servers (`403`), list or invite members (`403`), or revoke another user's API key. Conversations (`GET /api/conversations/:id`, `POST /api/chat`), personal audit logs (`GET /api/audit`), and active MCP session IDs (`mcp-session-id`) are scoped to the authenticated user; cross-user access returns `403` or `404`.
- **Browser and session controls:** State-changing `/api/*` requests require a same-origin `Origin` header, a matching `Host` header, and a session-bound `x-csrf-token`. Login and invitation endpoints enforce per-IP and per-account rate limits, dashboard API requests are limited per user, and `/mcp` requests per API key. The counters live in PostgreSQL, so they hold across gateway replicas and restarts.

## Cluster and storage boundaries

- **NetworkPolicies (`charts/storelink/templates/network-policies.yaml`):** `woo-mcp`, `time-mcp`, `operations-mcp` and `postgres` accept connections only from `gateway`. `mariadb` accepts only `wordpress` and `store-bootstrap`, and `wordpress` accepts only `woo-mcp` and Traefik. All other traffic, including outbound internet access, is open by default for development.
- **Default-deny mode (`networkPolicies.defaultDeny: true`, off by default):** every pod in the namespace starts with no ingress and no egress, and all pods may query CoreDNS. On top of that:
  - **Ingress:** the rules above, plus `gateway` accepting only Traefik (and `networkPolicies.metricsFrom` on the metrics port).
  - **Egress:** `gateway` reaches `postgres`, the three MCP servers, the Kubernetes API (`networkPolicies.kubernetesApi`) and public HTTPS on port 443, with private address ranges excluded. `woo-mcp` reaches only `wordpress`, and `wordpress` and `store-bootstrap` reach only `mariadb`. `time-mcp`, `operations-mcp`, `postgres` and `mariadb` have no egress beyond DNS.
  - **Result:** a compromised MCP server, WordPress or database pod cannot reach the internet, PostgreSQL, the gateway or the other store components. WordPress has no internet access unless `networkPolicies.wordpressEgress` opens it.
- **Least-privilege RBAC (`charts/storelink/templates/registry-rbac.yaml`):** All pods except `gateway` run with `automountServiceAccountToken: false`. The `gateway` ServiceAccount has a namespaced `Role` granting `get` and `patch` solely on `resourceNames: [storelink-upstream-credentials]`.
- **Container security:** Every workload runs as a non-root user without privilege escalation and with all Linux capabilities dropped. Application and MCP containers (`gateway`, `woo-mcp`, `time-mcp`, `operations-mcp`) run as UID `1000` with a read-only root filesystem. PostgreSQL runs as `70` and MariaDB as `999`. WordPress and its bootstrap Job run as `www-data` (`33`), with Apache on port 8080 inside the pod.
- **Upstream credentials at rest:** Each entry in `storelink-upstream-credentials` is an AES-256-GCM envelope (`packages/shared/src/credential-cipher.ts`). The key is derived with HKDF-SHA256 from the API key pepper, and the credential ID is authenticated data, so an entry copied into another server's slot fails to decrypt instead of sending one server's token to another. Altered entries fail closed. This protects against anyone who can read the upstream Secret, its backups or etcd snapshots but not `storelink-credentials`. It does not protect against anyone who can read every Secret in the namespace, because the pepper is in `storelink-credentials`. Rotating the pepper makes the stored credentials unreadable, so they must be re-entered.
- **Secrets and transport:** Internal WooCommerce REST calls use OAuth 1.0a HMAC-SHA256 over cluster HTTP; production deployments that require encrypted pod-to-pod traffic should enable a CNI wire-encryption layer or service mesh. Enable Kubernetes Secret encryption at rest on the k3s host and restrict access to `.data/cluster-secrets.json` and `.data/kubeconfig` (`0600`).

## Provisioned stores

Store lifecycle APIs allow members to manage their own stores and admins to manage stores only in their team. A PostgreSQL transaction enforces per-user and per-team caps under concurrent creation. Every store namespace has its own database, WordPress, random database/REST credentials, PVCs and default-deny network rules; it cannot connect to another store's WordPress or database. All tool calls still pass through the team's gateway, so a teammate can use another teammate's shared store tools. Lifecycle ownership is not a per-tool ACL.

A separate trusted provisioner holds the cluster-level permissions needed to create/delete namespaces. An API-server admission policy constrains its writes to managed store namespaces and the named gateway credential Secret, while the application also validates namespace names and checks the managed label before deletion. This reduces accidental cross-namespace mutation; compromise of this privileged controller remains a serious cluster trust-boundary failure. The gateway has no store-provisioning ClusterRole.

New-store MCP tokens are derived from the Secret-held pepper and immutable store ID using a distinct HMAC domain. This permits crash recovery without reading store database passwords. The pepper already grants access to the gateway's encrypted upstream tokens; losing it requires a coordinated credential recovery plan. Delete confirmation describes permanent data loss, and the controller removes gateway registration before namespace teardown. A Delete-reclaim StorageClass is required for automatic volume removal; backup/restore and root-key rotation remain operator responsibilities. See [multi-store operations](multi-store.md).
