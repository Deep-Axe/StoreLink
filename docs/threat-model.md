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
- **Browser and session controls:** State-changing `/api/*` requests require a same-origin `Origin` header, a matching `Host` header, and a session-bound `x-csrf-token`. Login and invitation endpoints enforce per-IP and per-account rate limits.

## Cluster and storage boundaries

- **NetworkPolicies (`charts/storelink/templates/network-policies.yaml`):** `woo-mcp`, `time-mcp` and `operations-mcp` accept ingress only from the `gateway` pod. `postgres` accepts ingress only from `gateway`, `mariadb` accepts ingress only from `wordpress` and `store-bootstrap`, and `wordpress` accepts ingress only from `woo-mcp` and the Traefik ingress controller.
- **Least-privilege RBAC (`charts/storelink/templates/registry-rbac.yaml`):** All pods except `gateway` run with `automountServiceAccountToken: false`. The `gateway` ServiceAccount has a namespaced `Role` granting `get` and `patch` solely on `resourceNames: [storelink-upstream-credentials]`.
- **Container security:** Application and MCP containers (`gateway`, `woo-mcp`, `time-mcp`, `operations-mcp`) run as non-root UID/GID `1000`.
- **Secrets and transport:** Internal WooCommerce REST calls use OAuth 1.0a HMAC-SHA256 over cluster HTTP; production deployments that require encrypted pod-to-pod traffic should enable a CNI wire-encryption layer or service mesh. Enable Kubernetes Secret encryption at rest on the k3s host and restrict access to `.data/cluster-secrets.json` and `.data/kubeconfig` (`0600`).
