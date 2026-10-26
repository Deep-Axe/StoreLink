# Multi-store Provisioning

The Stores dashboard provisions independent WooCommerce stores and connects each to the team's existing MCP gateway. It is enabled by `stores.enabled` in the same Helm chart used for the original store.

## Using Stores

1. Sign in and open **Stores → Create store**. Supply a display name and a globally unique address of 1–12 lowercase letters, digits or interior hyphens, beginning with a letter.
2. The card shows **Provisioning**, then **Ready** or **Failed**, with a failure reason. Status refreshes automatically. A Ready card links to its storefront and identifies its tool prefix, such as `woo-north__*`.
3. Members list, retry and delete their own stores. Administrators manage every store in their team. Store tools are shared with that team's members, consistent with the gateway's existing shared-upstream model.
4. Use **Retry setup** after a failure. Use **Delete store**, then confirm permanent deletion, to remove a store's products, orders, files and gateway registration.

No store, database or upstream credentials are returned by these APIs. WordPress administration credentials are operator-managed in that store namespace's `store-credentials` Secret; the dashboard does not expose them.

For example, create `north` and `south`, place a COD order in each, then ask Chat: “Compare today's orders in woo-north and woo-south. Use the time server for the day window and report each store's total and currency.”

## Desired state and recovery

The gateway records requests in PostgreSQL and announces work with `NOTIFY`. A separate provisioner reconciles pending stores every five seconds and on notifications. It holds a PostgreSQL advisory lock so overlapping controller pods cannot reconcile simultaneously. The gateway has no provisioning ClusterRole.

Each `storelink-store-<slug>` namespace gets its own MariaDB, WordPress, WooCommerce MCP, Services, Ingress, Secrets, two PVCs, readiness/liveness probes, resource limits, ResourceQuota and LimitRange. Kubernetes runs different stores' workloads concurrently. Bootstrap uses the bundled WooCommerce plugin and is idempotent.

A persisted attempt number gives retries a new bootstrap Job even if a previous Job is terminally Failed. Existing PVCs and random database/WordPress credentials remain unchanged. Newly created stores use a domain-separated HMAC of the Secret-held API-key pepper and immutable store ID for the MCP token. The controller can reconstruct that token after an interruption between creating the store Secret and saving the gateway's encrypted credential. It never reads back the store's database passwords. Existing development-era stores with random tokens retain their old behavior; if both credential copies are lost, their failure message requires recreation.

Ready requires available workloads and a successful setup Job. With certificate automation enabled, it also requires the store's Certificate to be Ready. Failed provisioning retains resources for inspection/retry and still consumes quota. Status updates use compare-and-set predicates, so a concurrent deletion cannot be overwritten by Ready.

Deletion unregisters tools and removes the encrypted MCP credential before deleting the managed namespace. The database row remains Deleting until Kubernetes confirms the namespace is gone. Use a StorageClass with **Delete** reclaim policy for automatic volume/data removal; Retain classes deliberately require operator cleanup and do not satisfy automatic teardown. Do not remove a namespace's finalizers blindly if deletion stalls.

## Limits and isolation

Defaults are two stores per user, three per team and a 240-second provisioning deadline. Check-and-insert runs in a short PostgreSQL transaction under a shared lock, so concurrent requests across gateway replicas cannot bypass either limit. Deleting and Failed stores count until removed. Configure `stores.maxPerUser`, `stores.maxPerTeam`, `stores.provisionTimeoutSeconds`, `stores.resources`, `stores.storage` and `stores.quota` in values; storage requests must fit the namespace storage quota.

Every generated namespace starts with ingress and egress denied. Explicit rules allow its MCP to its WordPress, WordPress to its MariaDB, bootstrap to MariaDB, DNS, Traefik to the storefront, and the platform gateway to MCP. Cross-store WordPress/database connections are blocked. HTTP-01 certificate solvers have a separate rule for Traefik to their challenge port.

The provisioner has cluster-level permissions because it creates namespaces. Application-side namespace checks and an API-server ValidatingAdmissionPolicy restrict its mutations to managed store namespaces, with an exception for the gateway's named credential Secret. The controller remains a privileged, trusted component; these guards do not sandbox arbitrary code executing inside it. The cluster must support `admissionregistration.k8s.io/v1` ValidatingAdmissionPolicy.

## Production DNS and TLS

`values-prod.yaml` sets HTTPS storefront URLs, a per-store TLS Secret name and a cert-manager ClusterIssuer. Supply real values for:

```yaml
stores:
  hostSuffix: stores.example.com
  scheme: https
  tlsSecretName: storefront-tls
  tlsClusterIssuer: letsencrypt-prod
  provisionTimeoutSeconds: 600
```

Point wildcard DNS `*.stores.example.com` at the VPS Ingress. Install cert-manager using its [official Helm instructions](https://cert-manager.io/docs/installation/helm/) and configure the named ClusterIssuer first. For HTTP-01, its solver must use your Ingress class (Traefik by default) and the public hostnames must resolve to that Ingress. The generated Ingress annotation asks ingress-shim to create a Certificate and TLS Secret **inside each store namespace**, rather than referring to the base namespace's Secret. See the [official cert-manager Ingress guide](https://cert-manager.io/docs/usage/ingress/). HTTPS store configuration without the issuer/Secret settings fails Helm rendering. Certificate delays appear as pending TLS and eventually a bounded failure, rather than a false Ready state.

Public DNS and the issuer contact address are operator setup. Local stores use HTTP on `*.store.storelink.localhost`. A single-node k3s deployment has issued a Let's Encrypt certificate for the platform hostnames through this ClusterIssuer. See [Public TLS](../README.md#public-tls).

## Backups and upgrades

Back up the application PostgreSQL database, both platform Secrets (pepper and encrypted gateway credentials), and **each store's** database, WordPress files and `store-credentials` Secret. For a store called north:

```sh
umask 077
backup="$HOME/storelink-backups/north-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
namespace=storelink-store-north
kubectl -n "$namespace" exec deploy/mariadb -- \
  sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines wordpress' > "$backup/database.sql"
kubectl -n "$namespace" exec deploy/wordpress -- \
  tar -C /var/www/html -czf - . > "$backup/wordpress.tgz"
kubectl -n "$namespace" get secret store-credentials -o yaml > "$backup/credentials.yaml"
```

Take a coordinated backup with writers quiesced if database/files consistency is required. Before restoring, pause the provisioner and store writers, restore matching database/files/Secrets, then restart store pods and reconciliation. Preserve the original store row/ID and platform pepper so the MCP token and encrypted credential agree. cert-manager can reissue certificates; also back up the issuer/account configuration according to its recovery procedure. Test restores in an isolated environment before relying on backups. `scripts/smoke-multistore.ts` covers controller restart recovery. Restoring these backups is a separate operation.

Changing the platform app/store images affects future stores and retries; Ready stores are not silently upgraded by this controller. Plan explicit per-store migrations and backups for existing stores. Helm rollback restores platform manifests; it does not roll back provisioned namespace data or database schemas.

## Verification

Run `node scripts/smoke-multistore.ts` on the configured local cluster. It acquires the shared cluster lock, requires no existing additional stores, creates temporary stores and real COD orders, and makes **one paid, read-only OpenAI chat turn**. Its cleanup removes its stores while retaining the attributed audit history and chat evidence.

The check covers concurrent admission, browser create/list/retry/delete, member ownership, a forced terminal bootstrap failure followed by retry, provisioner restart, unchanged credentials, two-store MCP discovery, blocked cross-store traffic, today's-order comparison, stale-tool refusal, surviving-store availability and namespace/PV cleanup. Results go to `.data/multi-store-evidence.json`. Screenshots go to `.cache/multi-store-*.png`.
