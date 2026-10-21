# StoreLink

A WooCommerce store and team MCP gateway on Kubernetes. Connect upstream servers once, then use their tools from the React dashboard or one authenticated MCP endpoint.

The local store, dashboard, PostgreSQL repository and three MCP servers are implemented. Real COD checkout and MCP store operations have passed. Chat has a bounded OpenAI Responses tool loop with deterministic tests and a completed live two-user demonstration using `gpt-6-luna`. See [verification](docs/verification.md) for the exact evidence and remaining work, and [project scope](docs/project-plan.md) for requirements and completion gates.

## Local setup

Prerequisites: Linux, Node 24, Docker Engine with working daemon/group access, Helm, k3d, kubectl, Git, curl and Python 3. Allocate at least 4 GiB to the k3d node and additional memory for image builds/browser checks. No host database or Python virtual environment is needed.

```sh
# Optional: install user-local Node/Helm/k3d/kubectl if missing.
scripts/install-dev-tools.sh
# If using its tools, add .tools/bin to PATH; prefer your installed Node 24.
scripts/install-dependencies.sh
scripts/local-up.sh
export KUBECONFIG="$PWD/.data/kubeconfig"
.tools/bin/kubectl -n urumi get pods
```

Setup creates the `urumi` cluster, generates Secrets, builds/imports images, and installs `charts/urumi`. Rerun after changes; image tags change and existing data, passwords and key revocations are retained. The generated recovery file `.data/cluster-secrets.json` contains credentials even though its values are base64 encoded; keep it private and backed up.

- Storefront: <http://store.urumi.localhost>
- Dashboard: <http://dashboard.urumi.localhost>
- WordPress admin: <http://store.urumi.localhost/wp-admin/>
- Gateway MCP: <http://dashboard.urumi.localhost/mcp>

The `*.localhost` hosts resolve to loopback in the verified browser/host configuration. k3d binds ports 80/443 on `127.0.0.1`; no hosts-file edits are needed here. If your resolver does not resolve these hosts, map both names to `127.0.0.1` locally. Pods use Service DNS for MCP and a private canonical-host lookup for WooCommerce REST.

Run this **in your own terminal** to retrieve the generated dashboard and WordPress passwords:

```sh
node scripts/local-credentials.ts --show
```

Sign in as `admin@urumi.local` or `member@urumi.local`. The WordPress username is `admin`. These are separate accounts.

## Place an order

1. Open the storefront and choose the seeded demo mug or a product created through MCP/chat.
2. Add it to the cart and open `/checkout/`.
3. Enter a test Indian address, select Karnataka and a valid postcode (for example Bengaluru, `560001`). Choose cash on delivery and place the order.
4. Confirm the order number on the receipt, then open WordPress admin → WooCommerce → Orders. No payment-provider account is needed.

## Connect an external MCP client

Sign in to the dashboard → **Access** → generate a key for your account. Save it when displayed; it cannot be retrieved again. Configure a client supporting Streamable HTTP:

```json
{
  "mcpServers": {
    "urumi": {
      "type": "http",
      "url": "http://dashboard.urumi.localhost/mcp",
      "headers": { "Authorization": "Bearer <your gateway key>" }
    }
  }
}
```

For the required third-party demonstration, save the configuration above as `.data/member-mcp.json` (permissions `600`) and use real Claude Code:

```sh
node scripts/with-cluster-lock.ts -- claude -p --mcp-config .data/member-mcp.json --strict-mcp-config --allowedTools mcp__urumi \
  "What orders came in today in the store's timezone? Use the time server for the day window and WooCommerce for orders. Then read the operations sales target and compare. Do not change anything."
```

The gateway configuration contains only its URL and the member key. Claude Code uses its own authentication/subscription, separately from dashboard OpenAI usage. This command passed the user-supplied QA run; see [client evidence](docs/verification.md#third-party-client-evidence).

Client configuration wrappers vary; the required connection settings are the URL, Streamable HTTP, and that header. MCP Inspector is installed: run `npx @modelcontextprotocol/inspector`, choose Streamable HTTP, and enter those settings. Keep its local proxy token enabled.

Expect nine tools across `woo__`, `time__` and `ops__`, including both `time__get_status` and `ops__get_status`. The gateway advertises tool-list changes and sends team-scoped SSE notifications to connected clients. Clients that support automatic refresh update their catalogs when a server changes; otherwise refresh or reconnect manually. Disabled tools and revoked keys fail on the next request even when the client caches old tools. Sessions are bound to the issuing user/key, expire after 15 minutes idle, and are lost on gateway replacement; reconnect after a 404 session-expired response.

For an optional terminal convenience using the same inexpensive OpenAI model, save user B’s generated gateway key in a private file (for example `.data/member-key`) and run:

```sh
URUMI_GATEWAY_KEY_FILE=.data/member-key node --env-file=.env scripts/external-chat.ts "Use the time service to find today, then list today's store orders."
```

Its MCP configuration contains only the gateway URL and user B’s key; its separate OpenAI key belongs in `.env`. The command prints called tool names and token usage; add `--json` before the prompt for structured results. This flow passed a real-model check, but reuses our dashboard chat loop and does not serve as the required third-party-client evidence.

## Use dashboard chat

Put your OpenAI API key in the ignored `.env`, then rerun setup:

```dotenv
OPENAI_API_KEY=your-key-here
```

```sh
scripts/local-up.sh
```

Setup copies the key into a Kubernetes Secret and enables chat. Set the model with Helm’s `chat.model` (default `gpt-6-luna`); access to this model was verified with the owner’s key. The browser never receives this key. OpenAI API usage is the only paid dependency for the local chat; all infrastructure runs locally.

The blank `WOO_CONSUMER_KEY_FILE` and `WOO_CONSUMER_SECRET_FILE` entries in `.env.example` are optional file paths for running the adapter outside Kubernetes. Cluster bootstrap generates the WooCommerce REST consumer key/secret and mounts them at `/secrets/woo-consumer-key` and `/secrets/woo-consumer-secret` in the adapter pod. Leave those local entries blank when using `scripts/local-up.sh`.

Try “Create a product named Team Mug priced at 149.00”, place an order for it, then ask “Use the store timezone to tell me what orders came in today.” For multiple sources, ask “Compare today’s order total with our operations sales target.” Tool activity appears under the answer, and **Activity** shows the attributed audit records. Conversations and token usage are saved per user. A turn is limited to eight model rounds, twenty tool calls, and a 120-second deadline; accepted chat turns are limited to fifteen per user per hour. Invalid input, inaccessible conversations and busy denials do not consume that allowance. Defaults allow one active turn per user, four per team and sixteen globally; configure `chat.limits` in Helm. Limits are process-local and reset on restart; one gateway replica is supported.

Admins manage servers in **Connections**, invite members and issue/revoke keys in **Access**, and review calls in **Activity**. Register a public HTTPS `/mcp` URL and optional static credential directly in the dashboard. DNS must resolve exclusively to public addresses, checked again when each connection opens; redirects are rejected. Private/internal origins require operator approval through `gateway.extraUpstreamOrigins` before registration. Set `Authorization` to `Bearer …` for bearer authentication, or use the required custom header. Credentials are stored in a dedicated Kubernetes Secret and never returned by the API.

## Production-like VPS setup

This is a single-node deployment, not HA. The chart and production rendering are checked locally; a public VPS deployment has not been performed.

1. Provision a Linux VPS with sufficient SSD storage and workload capacity. Start with 4 vCPU/8 GiB for headroom; this is a project estimate, not a load-test result. Install k3s with Traefik and NetworkPolicy enforcement using the [official quick-start](https://docs.k3s.io/quick-start) and [network requirements](https://docs.k3s.io/installation/requirements). Use a matching kubectl. Restrict SSH/Kubernetes API access and expose public HTTP/HTTPS.
2. Build and push `images/app/Dockerfile` and `images/store/Dockerfile` to a registry the VPS can pull. The store build requires `--build-arg WOOCOMMERCE_SHA256=5317434cb381b5fdc7c1dd6ee258324f08c390976aaf8d1199f2a0e9a3ab8586`. For a private registry, configure k3s registry credentials on the node.
3. Copy `charts/urumi/values-prod.yaml` to an ignored values file. Replace image references, public hosts and HTTPS URLs. Point DNS A/AAAA records to the VPS. Choose the storage class and PVC capacities before installation; `local-path` stores data on that node and needs off-node backups.
4. Select the production kubeconfig and create independent credentials. Keep namespace `urumi` and the default resource/Secret names when using the supplied helper:

   ```sh
   export KUBECONFIG=/path/to/private/production-kubeconfig
   URUMI_STATE_DIR=.data/production node scripts/prepare-cluster-secrets.ts
   ```

   The helper uses `URUMI_KUBECTL` if set, otherwise the project-local kubectl or PATH fallback. Supply `OPENAI_API_KEY` through the environment or ignored `.env`, and set `chat.enabled: true` in your deployment values. Retrieve production bootstrap passwords with `URUMI_STATE_DIR=.data/production node scripts/local-credentials.ts --show`.

5. Obtain a certificate covering both hosts and create TLS Secret `urumi-tls`, or use your existing certificate controller. Keep private keys outside the repository:

   ```sh
   kubectl -n urumi create secret tls urumi-tls --cert=/private/fullchain.pem --key=/private/privkey.pem
   helm lint charts/urumi -f /private/production-values.yaml
   helm upgrade --install urumi charts/urumi -n urumi -f /private/production-values.yaml --wait --timeout 10m
   kubectl -n urumi wait --for=condition=complete jobs -l urumi/component=store-bootstrap --timeout=120s
   ```

6. Verify both HTTPS sites, checkout, keys and chat. Back up PostgreSQL, MariaDB, WordPress content, and Secrets, and test restores. Enable Kubernetes Secret encryption at rest and protect kubeconfig/recovery files. Local/prod behavior differs through values and supplied Secrets; the REST adapter uses the same direct HTTP/OAuth transport in both.

A VPS, DNS/domain, registry storage and OpenAI usage may cost money. No paid service has been provisioned automatically. See [design](docs/system-design.md) and [threat model](docs/threat-model.md).

## Development and verification

```sh
npm run typecheck
npm test
npm run build:dashboard
npm run format:check
helm lint charts/urumi -f charts/urumi/values-local.yaml
helm template urumi charts/urumi -f charts/urumi/values-prod.yaml
```

Run cluster checks sequentially; the failure check deliberately interrupts workloads:

```sh
node scripts/smoke-cluster.ts       # Creates a product and a real COD order
node scripts/smoke-dashboard.ts     # Two browser users, invitations, CRUD and key controls
node scripts/smoke-failures.ts      # Outage/recovery and replacement persistence
node --env-file=.env scripts/smoke-chat.ts # Paid live-model/browser acceptance; creates demo data
```

Browser checks use installed Google Chrome through Playwright. `npm run dev:dashboard` starts Vite and proxies API requests to the local deployed gateway (override with `URUMI_DEV_BACKEND`); use the deployed dashboard for final cookie/origin integration checks. Production PostgreSQL is required for dashboard/auth/chat; the standalone SQLite backend is only a gateway test/development slice.

Source: `apps/dashboard/`, `services/gateway/` (including chat), `services/woocommerce-mcp/`, `services/time-mcp/`, `services/operations-mcp/`, `packages/shared/`, `charts/`, `scripts/`, `tests/`.

Extras implemented: owner-scoped conversations/token accounting, team-scoped authorization, expiring single-use invitations, CSRF/throttling, minimized order results, persisted connection history and a credential-origin allowlist. See [verification](docs/verification.md). Multi-store provisioning remains an optional extension and is not implemented.

For parallel contributor/agent work, use separate Git worktrees and the shared-cluster lock described in [the agent workflow](docs/agent-workflow.md). Deploy and smoke scripts lock automatically; wrap manual cluster mutations and client demos with `node scripts/with-cluster-lock.ts -- <command>`. Preview scoped QA cleanup with `node scripts/cleanup-qa.ts`, then run it with `--apply` when appropriate. See [QA fixes and evidence](docs/bugfix-verification.md) for the stacked review branches and checks.
