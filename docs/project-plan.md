# Project Goal and Scope

## Goal

Deliver a reproducible single-store WooCommerce platform on Kubernetes where an administrator connects MCP servers once and members use their tools through one gateway and dashboard chat. Success is the complete two-user acceptance flow, locally, with the same Helm chart ready for production-like k3s configuration.

## Required scope and implementation

| Area           | Required behavior                                                                 | Current state                                                              |
| -------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Store          | Persistent WordPress/WooCommerce, storefront/admin Ingress, COD checkout          | Deployed and checked against the real store                                |
| Store adapter  | Custom Streamable HTTP MCP with five product/order tools, gateway-only access     | Implemented; OAuth REST and network restriction checked                    |
| Gateway        | At least three upstreams, namespaced collisions, bounded calls, isolated failures | WooCommerce/time/operations deployed; control/failure checks passed        |
| Administration | Server CRUD/static credentials, status and tools                                  | React/API and PostgreSQL registry implemented; browser CRUD checked        |
| Identity       | Admin/member, invitations, per-user hashed/revocable keys                         | Implemented; two-user browser/client checks passed                         |
| Auditing       | Attributed attempts/outcomes visible in dashboard                                 | Implemented, including revoked-key denials and uncertain writes            |
| Chat           | Real LLM tool calls through the gateway as logged-in user, visible activity       | Scripted tests and real dashboard/external OpenAI acceptance passed        |
| Deployment     | Same Helm charts, local/production values, probes/resources/Secrets/PVCs          | Local upgrades and production render/lint checked; public VPS not deployed |
| Documentation  | Setup/demo, architecture/tradeoffs, threats, extras inventory                     | README and notes under `docs/`                                             |

## Architecture and engineering requirements

Use TypeScript/Node 24, Express, the official MCP SDK, React/Vite, application PostgreSQL and separate store MariaDB. All deployed components run in Kubernetes. Chat and MCP HTTP share one gateway application service; neither browsers nor models contact upstreams directly. Keep credentials in Kubernetes Secrets and indexed high-entropy gateway-key digests in PostgreSQL.

Bound discovery/calls/results/model rounds, preserve mutation uncertainty without retries, and fail closed before unaudited execution. Enforce team/owner predicates, role checks, session/CSRF validation and immediate revocation/disable. Configure the store timezone explicitly and use UTC order filters with decimal-string prices. Keep local and production differences in values/Secrets.

Tests combine deterministic protocol/security/tool-loop tests with real SDK, browser, store and pod replacement checks. No numerical coverage requirement is imposed. CI runs type checking, tests, dashboard build, formatting and Helm validation; the initial GitHub Actions run passed.

## Acceptance status and optional next work

The mandatory local two-user model demonstration passed with `gpt-6-luna`: dashboard product creation, browser order placement/admin confirmation, timezone-aware order queries, an external member’s multi-upstream prompt, disable/revocation controls, persisted history/token counts and audit attribution. See [verification](verification.md) for the evidence and exact client used.

Public VPS deployment still requires DNS/TLS and backup/restore verification. Multi-store provisioning is an optional extension, not implemented. No further model-provider setup is needed for the current local installation.

## Services and cost

No additional host package or Python environment is needed here. Docker/k3d/Helm/kubectl and npm dependencies are installed; databases and WordPress run as containers. OpenAI API usage needs the owner’s funded account/key. SMTP, managed databases and payment providers are unnecessary for the local demo. Public hosting may require a paid VPS/domain/registry; none has been purchased or provisioned. Secrets, DNS/certificates and backup destinations require operator setup for production.
