# QA Fixes and Review Order

All nine issues from the 2026-10-19 QA table are addressed. Branches are stacked: review each against the preceding branch, then use the final branch for the combined result. `main` remains unchanged.

| Branch                              | Compare against                | Changes                                                                                                 |
| ----------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `fix/cluster-reliability`           | `main`                         | B5 kubectl resolution, B1 outage deadline, shared cluster lock, B8 connection deadline                  |
| `fix/chat-errors-and-limits`        | `fix/cluster-reliability`      | B2 input/context validation, B3 provider failures, B4 atomic conversation creation, B9 admission limits |
| `fix/upstream-registration`         | `fix/chat-errors-and-limits`   | B7 public HTTPS registration and connection-time SSRF checks                                            |
| `fix/external-client-evidence`      | `fix/upstream-registration`    | B6 real Claude Code command and attribution of user-provided evidence                                   |
| `chore/qa-cleanup-and-verification` | `fix/external-client-evidence` | Recovery-test readiness, SDK abort coverage, live regression and scoped cleanup tools, final evidence   |

Individual bugs have separate commits. The final branch includes follow-up corrections found during verification.

## Automated and live checks

- All 31 deterministic tests pass, including real socket connection deadlines, DNS rebinding rejection, HTTP status/persistence checks and admission fairness. No paid model calls occur in these tests.
- Type checking, dashboard production build, Prettier and both Helm profiles pass; production templates render successfully.
- Combined application deployed locally through `scripts/local-up.sh`, Helm revision 7; final diagnostic refinement deployed in revision 8.
- Browser smoke passes: three connected servers, nine tools, invitation flow, ownership, CSRF, add/edit/remove, credential replacement, disable and immediate revocation.
- Current outage smoke passes: operations outage leaves time usable, recovery restores tools, gateway restart preserves sessions/configuration/audits, and WordPress restart retains order 22. A read-only order probe polls through endpoint/full-plugin readiness lag. Mutations are never retried.
- In this outage run, the catalog had already removed the dead route, so its 13 ms rejection does not measure a cold TCP failure. The separate real-network tests verify the connection timeout and that a healthy long tool call survives it.
- Live OpenAI regression: 17 blank requests returned 400 and left zero conversations; a subsequent invited-member turn successfully called `time__get_status` and persisted 1,652 input / 29 output tokens. Only that read-only turn incurred model usage.
- Real Claude Code evidence is explicitly attributed to the user's earlier QA run in [verification.md](verification.md#third-party-client-evidence). No fresh Claude run or cached tool-list notification support is claimed.

Private logs remain in `.cache/bugs-*.log`; credentials and private planning notes are excluded from Git.

## Cleanup and coordination

`node scripts/cleanup-qa.ts` previews; `--apply` disables the reported QA member and disabled invitation-smoke accounts, clears their password hashes/sessions/invitations, revokes their keys, removes their conversations and zero-work empty conversations, and trashes product 23 only if its name matches the QA fixture. It preserves audit/user/key tombstones for attribution, working bootstrap access, integration/OpenAI secrets and demo orders.

Applied cleanup covered seven accounts and four conversations. Verification found zero active QA passwords/keys/sessions/conversations and zero empty conversations; both bootstrap keys remain active. Product 23 is in trash, and all three upstreams are enabled and Connected.

Use [the agent workflow](agent-workflow.md): one worktree/branch per agent, automatic host-wide locking for deployments and smoke tests, and the same lock wrapper for manual tests and cleanup. Remote runners require separate environments or shared CI/Kubernetes locking.
