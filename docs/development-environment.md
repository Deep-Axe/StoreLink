# Development Environment

Verified on 2026-10-19. Docker group membership, daemon access, outbound package access, and browser execution now work in this session.

## Host tools

| Tool                | Verified installation                                                              |
| ------------------- | ---------------------------------------------------------------------------------- |
| Node.js / npm       | 24.22.0 / 11.19.1                                                                  |
| Docker Engine       | 29.9.1; `docker run --rm hello-world` succeeds                                     |
| Helm                | 4.3.1                                                                              |
| k3d                 | 5.9.0; default k3s 1.35.5                                                          |
| kubectl             | Host version 1.37.1; matching project-local version 1.35.9 at `.tools/bin/kubectl` |
| Google Chrome       | 154.0.8037.92; Playwright headless launch succeeds                                 |
| Build prerequisites | Git, curl, Python 3, make, and GCC are available                                   |

Use `.tools/bin/kubectl` with the default k3d cluster. The host's kubectl 1.37 is two minor versions newer than that cluster; Kubernetes supports kubectl within one minor version of the API server. The install helper now selects the k3d default's minor version, or accepts `URUMI_KUBECTL_VERSION` when a different cluster image is chosen. [Kubernetes version policy](https://kubernetes.io/releases/version-skew-policy/)

## Project packages

The workspace manifests and `package-lock.json` include:

- **Gateway:** OpenAI SDK, PostgreSQL driver (`pg`), Drizzle ORM, and Argon2 password hashing.
- **Dashboard:** React and React DOM; Vite and the React plugin are available as development tools. The React dashboard is built and served by the gateway image.
- **Existing MCP services:** official MCP SDK 1.28.0, Express, Zod, Ajv, and format validation.
- **Development:** TypeScript and Node/Express/PostgreSQL/React types, Drizzle Kit, ESLint/typescript-eslint, and Prettier.
- **Testing:** the existing Node test runner, Vitest, jsdom, Testing Library, Playwright, and MCP Inspector.

Required Argon2, esbuild, and Inspector installation scripts were enabled for their installed versions and rebuilt successfully. Argon2id hashing/verification, application package imports, and a React/Vite production-bundle smoke check pass. Browser checks use the installed Chrome through Playwright's `channel: 'chrome'`; no additional browser download is required for that configuration.

## Reproduce checks

```sh
scripts/install-dependencies.sh
npm run typecheck
npm test
npm run format:check
```

The helper prefers an existing Node 24 installation over the older project-local fallback. TypeScript runs without emitting JavaScript; Node 24 executes the current TypeScript sources directly.

## Cluster and remaining setup

No further host packages are needed for the implemented core. The `urumi` k3d cluster is running with private kubeconfig `.data/kubeconfig`; use `KUBECONFIG="$PWD/.data/kubeconfig" .tools/bin/kubectl -n urumi get pods`. The root README documents reproducible image builds, Helm installation and credentials retrieval.

WordPress/WooCommerce, MariaDB, PostgreSQL, the gateway/dashboard and three MCP services are deployed. Real COD checkout, OAuth REST calls, persisted audits and browser access controls have passed. Native Argon2 and React production builds run inside the application images too. No host databases or Python virtual environment are needed.

Live OpenAI requests still require an API key/account-access check; deterministic tool-loop tests do not establish real model acceptance. See [verification](verification.md) for current evidence and remaining gates. No paid services have been provisioned.
