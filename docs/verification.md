# Verification and Remaining Acceptance Work

Verified locally on 2026-10-19 with k3d 5.9.0 / k3s 1.35.5, Helm 4.3.1, MCP SDK 1.28.0, Node 24 and Google Chrome 154. These notes distinguish real infrastructure from deterministic fixtures.

## Executed evidence

- `npm test`: sixteen tests cover routing/collisions, isolation, schema validation, audit failure, key revocation/attribution, actual SDK HTTP exchanges, OAuth canonical binding, uncertain mutations, bounded scripted Responses continuation and timezone/DST boundaries. Scripted model tests make no paid calls.
- `scripts/local-up.sh`: repeated image builds and Helm upgrades completed; WordPress/WooCommerce bootstrap is idempotent and all long-running workloads become Ready.
- `node scripts/smoke-cluster.ts`: real gateway → Woo MCP → OAuth REST product creation/listing, browser COD checkout, order listing/retrieval/status update. The initial recorded product/order IDs were 13/15; the final run created product 16/order 17, confirmed the order in WooCommerce admin, and retrieved it with time-service UTC day filters. PostgreSQL retained attributed audit entries. The script creates new demo data each run.
- `node scripts/smoke-dashboard.ts`: real Chrome login as admin/member, three connected servers/nine tools, CSRF/origin denial, member administration denial, self-service key creation, duplicate-name calls, disable/re-enable, revocation in an existing client and attributed denials. Browser invitation acceptance, single-use enforcement, member key ownership and access removal passed. The extended check also passed connection add/edit/remove, credential replacement and denial of unapproved origins/unsafe credential headers.
- An unlabelled test pod could not reach the healthy Woo MCP Service; the gateway reached it successfully. This checks actual NetworkPolicy enforcement, not just rendered YAML.
- `node scripts/smoke-failures.ts`: gateway replacement retained the browser session, disabled registration and audit rows; WordPress replacement retained product/order data, including order 15 initially and order 22 when rerun after live model acceptance.
- An operations pod was removed and held down with zero replicas. The dashboard reported Unreachable while time calls succeeded; restoring replicas restored the catalog.

Screenshots/logs and generated test identifiers live under ignored `.cache/` and `.data/`. They are local evidence, not required configuration.

## Live OpenAI acceptance

`node --env-file=.env scripts/smoke-chat.ts` passed with `gpt-6-luna` against the deployed application. It makes paid model calls and creates demo data; it is separate from deterministic CI tests.

- Dashboard admin A used chat to create product **21**. Browser COD checkout produced order **22**, which was confirmed in WooCommerce admin.
- The next chat turn called `time__get_day_window` and `woo__list_orders`; both tool results and the final answer included order 22.
- Saved conversation history reloaded successfully and token counts persisted. Member B could not read A’s conversation.
- Member B generated a gateway key and used the bundled external agent CLI as a separate MCP client. A real prompt combined time, WooCommerce orders and the operations sales target. The model received no upstream credentials.
- Disabling operations removed its tools from both catalogs. Dashboard chat reported the policy unavailable, while B’s external agent still answered using time and WooCommerce.
- B’s revoked key was rejected on the next call in an open SDK client. Audits attributed successful and denied calls to the correct user/key; dashboard calls were attributed to A’s session.
- Three dashboard turns used 7,449 input / 370 output tokens; two external turns used 7,730 input / 387 output tokens. These are measured usage counts for this run, not a billing estimate.

The private evidence file is `.data/live-chat-evidence.json`; screenshot/logs are under `.cache/`. Test keys were revoked and the temporary key file deleted. Live model behavior can vary on reruns. The external model demonstration used the bundled SDK-based CLI; Claude Code/Cursor UI integrations have not been separately exercised.

## Remaining gates

- Validate actual public DNS/TLS and restore procedures on a VPS if deploying one. Production Helm rendering alone is not a live production test.

## Extras and locations

| Extra                                                      | Implementation                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Team/owner scoping, member invitations and CSRF/throttling | `services/gateway/src/dashboard-api.ts`, PostgreSQL migrations        |
| Conversations and token accounting                         | `services/gateway/src/chat.ts`, `conversations` table, dashboard Chat |
| Persisted connection transitions                           | `services/gateway/src/registry.ts`, dashboard Connections             |
| Shared credential confinement and origin allowlist         | `credentials.ts`, registry, chart RBAC/NetworkPolicies                |
| Minimized order data and uncertain write outcomes          | Woo MCP source, gateway audit path                                    |
| DST-aware store-local day windows                          | `services/time-mcp/`, `tests/chat.test.ts`                            |

Multi-store provisioning is not attempted. The mandatory local two-user real-model demonstration has passed; production DNS/TLS and backup/restore checks remain deployment-specific.
