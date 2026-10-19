# Threat Model

## Assets and trust boundaries

Protect WooCommerce credentials, upstream credentials, gateway keys, browser sessions, OpenAI credentials, team order data and audit attribution. Trust the host/cluster operator and team administrators to manage integrations. Members may call every enabled team tool; the store integration account has shared read/write privileges. The model and upstream metadata/results are untrusted.

## Shared credentials without disclosure

A member never sees the WooCommerce key, yet can exercise the privileges exposed through its tools: read products/orders, create products and change order statuses. Hiding a credential does not limit those delegated capabilities. Members can change shared store state and affect coworkers’ work. The current design has no approval queue or tool-specific member ACLs. Product/order tools intentionally omit unrelated account administration and customer contact/address data. Administrators must review the tool catalog and integration account permissions before inviting members.

## Token termination

Gateway keys identify a person and authorize gateway access. They are never forwarded to an upstream. The gateway attaches only that upstream’s static credential, avoiding credential leakage, accidental trust between services and upstream impersonation of gateway users. Audit entries retain the gateway user even though the store sees a shared integration account. Revocation is checked on every listing/call, including open clients; matching revoked digests are retained for attribution.

Password hashes use Argon2id; high-entropy API keys and session/invite tokens use domain-separated HMAC-SHA256 with a Secret-held pepper. Digests are indexed; raw gateway keys are displayed once. Compromise of PostgreSQL alone does not reveal keys. Compromise of the gateway and its mounted/authorized Secrets crosses that boundary. Rotating the pepper invalidates existing credentials unless explicitly migrated.

## Untrusted upstreams and prompt injection

An upstream can publish descriptions or results telling the model to ignore the user, disclose information or invoke another tool. Instructions identify this material as untrusted, and the model has no generic network/shell tool or access to credentials. Arguments are schema-validated and calls remain subject to gateway authorization, auditing and budgets.

Those measures do not prove resistance to prompt injection. A malicious integration could induce an unwanted call or exfiltrate tool-visible data through a tool it controls. Server registration is administrator-only; allowed origins are deployment-controlled, redirects are rejected, and descriptions/results are bounded. Review upstream trust and use least-privilege accounts. The allowlist trusts its configured DNS targets; it is not a complete DNS-rebinding/egress firewall defense. An upstream necessarily receives its own credential and could echo it back; only connect services trusted to handle that credential.

## What one member can do to another

Members share enabled tool privileges and can modify shared commerce data or consume team model credits. They cannot administer connections/members, revoke another member’s key, or read another user’s conversations or personal audit view. Admins can issue/revoke team keys and disable member access. Concurrent commerce mutations use WooCommerce’s behavior; there is no per-member transaction isolation beyond authorization/auditing.

Owner/team predicates protect object access; invitation acceptance is transactional and single-use. CSRF tokens, strict cookies, origin/Host checks, CSP, input bounds and throttling protect browser routes. Rate limits and four concurrent chat users bound basic abuse, but are in-memory and reset on restart; production needs ingress/shared limits. Login has no SSO, MFA, password recovery or email delivery in this release.

## Cluster, transport and recovery

Only Ingress exposes the storefront/dashboard/gateway. NetworkPolicies and independent service tokens protect all three MCP upstreams; MariaDB and PostgreSQL accept only their application workloads. The adapter alone mounts store credentials. The gateway can read/patch one named upstream Secret; no user route exposes arbitrary Kubernetes API access. The named Secret aggregates team upstream credentials, so gateway compromise exposes that entire set. Policies currently constrain ingress, not all egress.

Public production traffic uses TLS. Internal store HTTP/OAuth does not encrypt customer/store traffic or protect JSON bodies from an on-path attacker. The host, CNI and cluster administrators remain trusted; use internal TLS/mTLS if that is insufficient. Kubernetes Secrets are base64 data, not encryption: enable encryption at rest and restrict operator access. Protect the local recovery file as a credential backup.

Audits exclude full tool arguments and order contact data; HTTP logs contain generated request IDs, method, status and timing, not credentials or request bodies. Database/audit failures fail closed before dispatch. Lost mutation replies are uncertain, not retried. Back up both databases, WordPress content and Secrets off-node, and test restores. Single-node storage and the gateway remain availability risks.

## Verification limits

Automated/cluster checks cover boundaries and common failure paths; they are not a security audit. See [verification](verification.md). Live model prompts and a public HTTPS VPS deployment remain outstanding. Multi-store provisioning/isolation is deferred.
