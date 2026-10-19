# System Design and Tradeoffs

## Architecture

```mermaid
flowchart LR
  Shopper --> Ingress
  Browser[React dashboard] --> Ingress
  External[External MCP client] --> Ingress
  Ingress --> WP[WordPress + WooCommerce]
  Ingress --> Backend[Express backend / MCP gateway]
  Backend --> PG[(PostgreSQL)]
  WP --> Maria[(MariaDB)]
  Backend --> Woo[Custom Woo MCP]
  Backend --> Time[Time MCP]
  Backend --> Ops[Operations MCP]
  Woo -->|REST HTTP + OAuth| WP
  Chat[Chat module] -->|In-process gateway service calls| Backend
  Chat --> OpenAI[OpenAI Responses API]
```

TypeScript/Node 24 and npm workspaces keep the backend, custom MCP servers and React/Vite dashboard in one repository. The backend serves the built dashboard, browser API and MCP endpoint. SQL migrations and the `pg` driver implement application persistence; Drizzle is installed but is not the active query layer. WordPress uses a separate MariaDB and content PVC. Both databases and all application services run in Kubernetes.

One gateway replica keeps routing/configuration caches and throttles simple. This is a single-node submission design: failover, distributed rate limits and multi-replica synchronization need additional work.

## Store authentication

The custom adapter calls WooCommerce `wc/v3` REST rather than manipulating order/product tables. This preserves WooCommerce validation. WP-CLI and one PHP bootstrap script install/configure the store, seed a product and create the integration credential.

Both environments use OAuth 1.0a HMAC-SHA256 over direct internal HTTP. The adapter signs an HTTP URL with the canonical public hostname and privately resolves that hostname to the WordPress Service. It preserves the canonical Host without routing through public DNS/Ingress. Public HTTPS does not change this internal authentication path. Redirects are rejected, never followed. The consumer secret stays out of URLs. OAuth authenticates requests but does not encrypt the hop or sign JSON bodies; stronger internal transport needs TLS or a service mesh.

This transport has passed against the actual local WordPress 7.1.3 / WooCommerce 11.2.1 deployment. Fixture checks cover public HTTP and HTTPS settings; a real public HTTPS deployment remains unverified. Order queries set `dates_are_gmt=true`; the Temporal-based time server supplies store-local day boundaries, including DST, with the adapter’s exclusive second-precision filters.

## Aggregation, routing and failure handling

The gateway uses MCP SDK 1.28.0 as an upstream client and downstream Streamable HTTP server. Discovery runs independently per server, with a three-second deadline, at most five pages/200 tools, and bounded metadata. Calls have a fifteen-second deadline and bounded results.

Public tool names are `<slug>__<alias>` within 64 characters. Slugs are team-unique and at most sixteen characters; unusual tool names receive a deterministic normalized/hash alias. A stored runtime mapping routes each name to server ID and original tool name. Both time and operations expose `get_status` and route independently.

Disabling/removing a server immediately removes routes and fences older discoveries. Each call rechecks the actor and enabled route, then validates arguments. A failed connection removes only that server’s tools. Independent periodic refresh restores healthy catalogs. Status transitions and last success/failure timestamps are persisted for the dashboard; readiness depends on PostgreSQL, not on every upstream.

The downstream transport is stateless JSON Streamable HTTP. Clients explicitly refresh tools; SSE/list-change notifications are not implemented. Stale calls still fail immediately. Reconnect clients after a gateway replacement when their transport retains a failed connection.

Mutations are never automatically retried. Lost write responses, including adapter-to-store failures, are returned/audited as uncertain. A read/check is required before retrying. Audit attempts are persisted before dispatch; failure to start an audit prevents execution. A crash can leave a visible `started` record.

## Access, secrets and chat

Passwords use Argon2id. Browser sessions use random HttpOnly/SameSite cookies with eight-hour expiry, server-side HMAC lookup and CSRF checks. API keys contain 32 random bytes and use indexed `HMAC-SHA256(Secret-held pepper, full key)` digests. This provides direct lookup without scanning Argon2 hashes or trusting prefixes. Revoked records remain attributable. Pepper rotation requires explicit key/session reissuance.

Users, server registrations, calls and conversations are team-scoped; conversations and member keys are owner-scoped. Invitations are hashed, single-use and expire after 24 hours. The initial UI supports one team; membership currently lives on the user row.

Static upstream credentials live in one dedicated Kubernetes Secret, with registration metadata in PostgreSQL. The gateway ServiceAccount can only `get`/`patch` that named Secret. Browser routes never return values. New origins require an operator-configured allowlist; redirects and URL-embedded credentials are rejected. Runtime credential changes use the dashboard; externally editing the Secret requires a gateway restart to replace cached clients.

Chat translates the current gateway catalog to OpenAI Responses function tools. It retains response/reasoning items and matches each call ID. Execution uses the same in-process gateway service and verified session principal as external MCP calls. Client credentials never go to upstreams or OpenAI. Conversations/token counts persist in PostgreSQL. Limits: eight rounds, twenty calls, 120 seconds, bounded context/output and per-user throttling. See the [OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling).

## Production changes

Use the same Helm chart with production image references, public DNS/HTTPS hosts, TLS Secret, fresh application/adapter/model Secrets, and appropriate storage class/PVC sizes. The chart supplies probes, resource bounds and gateway-only upstream NetworkPolicies. A single-node `local-path` installation requires off-node database/content/Secret backups and restore testing. Production also needs operational log retention, credential recovery/rotation procedures, ingress abuse controls and stronger internal transport if the node/network trust boundary is insufficient.

See [README](../README.md) for deployment and [verification](verification.md) for tested behavior versus remaining acceptance work.
