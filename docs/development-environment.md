# Development Environment

## Host tools

| Tool          | Version / notes                                        |
| ------------- | ------------------------------------------------------ |
| Node.js / npm | 24.x (`>=24.5.0`) / 11.x                               |
| Docker Engine | 29.x with daemon access for building and k3d           |
| Helm          | 4.3.x                                                  |
| k3d           | 5.9.x (runs k3s 1.35.x)                                |
| kubectl       | 1.35.x matching the cluster minor version              |
| Google Chrome | Used by Playwright (`channel: 'chrome'`)               |
| Build tools   | Git, curl, Python 3, make, and GCC (for native addons) |

`scripts/install-dev-tools.sh` downloads Node 24, Helm, k3d, and a `kubectl` binary matching the k3d Kubernetes minor version into `.tools/bin`. Set `STORELINK_KUBECTL_VERSION` to pick a specific `kubectl` release, or `STORELINK_KUBECTL` to point scripts at a custom binary path.

## Workspace packages

- **Gateway (`services/gateway`):** Express 5, `@modelcontextprotocol/sdk`, OpenAI SDK, `pg`, Argon2, Zod, Ajv, `ipaddr.js`, and `undici`.
- **Dashboard (`apps/dashboard`):** React 19 and Vite. The production bundle is built into `apps/dashboard/dist` and served by the gateway.
- **MCP servers (`services/woocommerce-mcp`, `services/time-mcp`, `services/operations-mcp`):** `@modelcontextprotocol/sdk`, Express, Zod, and `@js-temporal/polyfill`.
- **Tooling and tests:** TypeScript, Prettier, ESLint, Node's built-in test runner, Playwright, and `@modelcontextprotocol/inspector`.

Node 24 runs the TypeScript sources directly. `package.json` whitelists build scripts for `argon2`, `esbuild`, and `@modelcontextprotocol/inspector`.

## Local checks

```sh
scripts/install-dependencies.sh
npm run typecheck
npm test
npm run build:dashboard
npm run format:check
```

## Local cluster

`scripts/local-up.sh` creates the `storelink` k3d cluster, writes the kubeconfig to `.data/kubeconfig`, generates credentials into `.data/cluster-secrets.json` and the `storelink-credentials` Kubernetes Secret, builds and imports the container images, and installs `charts/storelink`.

```sh
scripts/local-up.sh
export KUBECONFIG="$PWD/.data/kubeconfig"
.tools/bin/kubectl -n storelink get pods
```

Set `OPENAI_API_KEY` in `.env` before running `scripts/local-up.sh` to enable dashboard chat in the cluster. For UI work against a running cluster, `npm run dev:dashboard` starts the Vite dev server and proxies `/api` requests to `http://dashboard.storelink.localhost` (or `STORELINK_DEV_BACKEND`).
